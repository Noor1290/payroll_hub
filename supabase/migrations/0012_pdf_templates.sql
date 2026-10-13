-- =====================================================================
-- PDF form templates: the fields of each form in a table, the PDF files in a bucket
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0011. Safe to re-run.
--
-- It only ADDS things (two tables, one private Storage bucket, three Storage policies, five
-- functions) and replaces one function, public.delete_company, with the same function plus
-- two more deletes. No existing table, column or row is changed.
--
-- 1. public.pdf_templates: one row per template of a company. It holds the template's name,
--    a JSON body (the fields drawn on the form and the template's company details; no
--    payroll figures and nobody's personal data), a revision number that goes up by one on
--    every save, and which PDF file it is for: the file's SHA-256 hash, name, size and
--    number of pages.
--
-- 2. public.pdf_template_history: every revision that was ever saved, so an earlier one can
--    be restored. At most the last 200 per template are kept.
--
--    Who can do what, for both tables:
--      * Members of the company: read.
--      * Admins of the company: save, restore, copy and delete, ONLY through the functions
--        below.
--      * Nobody, through the API: insert, update or delete a row directly.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 3. Storage bucket "pdf-forms": private, PDF files only, 5 MB each. A file's path is
--      <company id>/<sha-256 of the file>.pdf
--    so the same file is stored once per company however many templates use it.
--      * Members of the company: download that company's files.
--      * Admins of the company: upload and delete that company's files.
--      * Nobody: change a stored file (there is no update policy).
--      * Everyone else, and anonymous visitors: nothing.
--
-- 4. public.save_pdf_template: creates a template (last revision seen = 0) or saves over
--    it. The caller must say which revision they last saw; if someone else saved since, the
--    save is refused instead of overwriting their work. The PDF file must already be in the
--    bucket.
--    public.restore_pdf_template: makes an earlier revision the newest one.
--    public.copy_pdf_template: copies a template to another company. The caller must be a
--      member of the company it comes from and an admin of the one it goes to, and the file
--      must already be in the bucket under the second company.
--    public.delete_pdf_template: deletes a template and its history, and says whether its
--      file is still used by another template of that company.
--
--    All four are SECURITY DEFINER because the tables have no write policy or grant; each
--    function applies the rules itself. search_path = '' and fully qualified names, so
--    nothing can be shadowed.
--
-- 5. public.delete_company (migration 0011) is replaced: it now also deletes these two
--    tables' rows by name and returns their counts as "pdf_templates" and
--    "pdf_template_history". Nothing else about it changes. The dashboard removes the
--    company's files from the bucket before it calls the function. If you ever run an older
--    delete_company file again after this one, run this file again too.
--
-- Limits: a name is 1 to 80 characters and unique in its company (capitals ignored); a body
-- is a JSON object of at most 256 KB; a file is at most 5 MB; a company has at most 50
-- templates.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN    no logged-in user
--   PH_NOT_ADMIN        the caller is not an admin of this company (or it does not exist)
--   PH_NOT_FOUND        this company has no such template or revision
--   PH_INVALID_INPUT    something is missing or malformed
--   PH_TOO_LARGE        the body is larger than 256 KB
--   PH_DUPLICATE_NAME   this company already has a template with that name
--   PH_STALE            the revision the caller last saw is not the current one
--   PH_NO_FILE          the PDF file is not in the bucket for this company
--   PH_LIMIT            the company already has 50 templates
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.pdf_templates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  name           text not null
                 check (name = btrim(name) and char_length(name) between 1 and 80),
  body           jsonb not null
                 check (jsonb_typeof(body) = 'object'
                        and octet_length(body::text) <= 262144),
  revision       integer not null check (revision >= 1),
  -- Which file in the bucket: <company_id>/<pdf_sha256>.pdf
  pdf_sha256     text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_file_name  text not null check (char_length(pdf_file_name) between 1 and 200),
  pdf_bytes      integer not null check (pdf_bytes between 1 and 5242880),
  pdf_pages      integer not null check (pdf_pages between 1 and 10000),
  -- Become empty if that user account is ever removed; the row itself stays.
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  -- Lets a history row point at its template AND its company together (see below).
  unique (id, company_id)
);

-- One name per company, whatever the capitals.
create unique index if not exists pdf_templates_company_name_idx
  on public.pdf_templates (company_id, lower(name));

create table if not exists public.pdf_template_history (
  template_id    uuid not null,
  company_id     uuid not null references public.companies(id) on delete cascade,
  revision       integer not null check (revision >= 1),
  name           text not null,
  body           jsonb not null,
  pdf_sha256     text not null,
  pdf_file_name  text not null,
  pdf_bytes      integer not null,
  pdf_pages      integer not null,
  saved_by       uuid references auth.users(id) on delete set null,
  saved_at       timestamptz not null default now(),
  primary key (template_id, revision),
  -- A history row always carries the same company as its template.
  foreign key (template_id, company_id)
    references public.pdf_templates (id, company_id) on delete cascade
);

-- ---------- row level security: members read; no write policy at all ----------
alter table public.pdf_templates        enable row level security;
alter table public.pdf_template_history enable row level security;

drop policy if exists "pdf_templates_select" on public.pdf_templates;
create policy "pdf_templates_select" on public.pdf_templates
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists "pdf_template_history_select" on public.pdf_template_history;
create policy "pdf_template_history_select" on public.pdf_template_history
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.pdf_templates        from public, anon, authenticated;
revoke all on table public.pdf_template_history from public, anon, authenticated;
grant select on table public.pdf_templates        to authenticated;
grant select on table public.pdf_template_history to authenticated;

-- ---------- the bucket for the PDF files ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdf-forms', 'pdf-forms', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

-- A file's path is <company id>/<sha256>.pdf. This reads the company from it, and answers
-- "no company" (null) for any path that is not shaped exactly like that, so a file with any
-- other name can be neither read nor written through the policies below.
create or replace function public.pdf_form_company(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}[.]pdf$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

revoke all on function public.pdf_form_company(text) from public, anon;
grant execute on function public.pdf_form_company(text) to authenticated;

drop policy if exists "pdf_forms_select" on storage.objects;
create policy "pdf_forms_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'pdf-forms' and public.is_company_member(public.pdf_form_company(name)));

drop policy if exists "pdf_forms_insert" on storage.objects;
create policy "pdf_forms_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'pdf-forms' and public.is_company_admin(public.pdf_form_company(name)));

drop policy if exists "pdf_forms_delete" on storage.objects;
create policy "pdf_forms_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'pdf-forms' and public.is_company_admin(public.pdf_form_company(name)));
-- No update policy: a stored file is never changed.

-- ---------- create a template, or save over it ----------
create or replace function public.save_pdf_template(
  p_company_id        uuid,
  p_template_id       uuid,
  p_name              text,
  p_body              jsonb,
  p_expected_revision integer,
  p_pdf_sha256        text,
  p_pdf_file_name     text,
  p_pdf_bytes         integer,
  p_pdf_pages         integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_name     text := btrim(coalesce(p_name, ''));
  v_file     text := btrim(coalesce(p_pdf_file_name, ''));
  v_template public.pdf_templates%rowtype;
begin
  -- ---------- who is calling ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company. A company that does not exist gives the same answer.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks (the dashboard validates first; this is the backstop) ----------
  if p_template_id is null then
    raise exception 'PH_INVALID_INPUT: the template id is missing' using errcode = '22023';
  end if;

  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'PH_INVALID_INPUT: the template name must be 1 to 80 characters'
      using errcode = '22023';
  end if;

  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the template body must be a JSON object'
      using errcode = '22023';
  end if;

  if octet_length(p_body::text) > 262144 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing'
      using errcode = '22023';
  end if;

  if p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PH_INVALID_INPUT: the hash of the PDF file is missing or malformed'
      using errcode = '22023';
  end if;

  if v_file = '' or char_length(v_file) > 200 then
    raise exception 'PH_INVALID_INPUT: the name of the PDF file must be 1 to 200 characters'
      using errcode = '22023';
  end if;

  if p_pdf_bytes is null or p_pdf_bytes < 1 or p_pdf_bytes > 5242880 then
    raise exception 'PH_INVALID_INPUT: the size of the PDF file must be 1 byte to 5 MB'
      using errcode = '22023';
  end if;

  if p_pdf_pages is null or p_pdf_pages < 1 or p_pdf_pages > 10000 then
    raise exception 'PH_INVALID_INPUT: the number of pages of the PDF file is missing'
      using errcode = '22023';
  end if;

  -- One save at a time per company, and never while the company is being deleted.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- The file must be in the bucket first: a template never points at a file that is not there.
  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'pdf-forms'
      and o.name = p_company_id::text || '/' || p_pdf_sha256 || '.pdf'
  ) then
    raise exception 'PH_NO_FILE' using errcode = 'P0002';
  end if;

  select * into v_template
  from public.pdf_templates t
  where t.id = p_template_id
  for update;

  if not found then
    -- ---------- a new template ----------
    if p_expected_revision <> 0 then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    if (select count(*) from public.pdf_templates t where t.company_id = p_company_id) >= 50 then
      raise exception 'PH_LIMIT' using errcode = '54000';
    end if;

    begin
      insert into public.pdf_templates (
        id, company_id, name, body, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages,
        created_by, created_at, updated_by, updated_at
      )
      values (
        p_template_id, p_company_id, v_name, p_body, 1, p_pdf_sha256, v_file, p_pdf_bytes,
        p_pdf_pages, v_user, now(), v_user, now()
      )
      returning * into v_template;
    exception when unique_violation then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end;
  else
    -- ---------- an existing template, which must belong to THIS company ----------
    if v_template.company_id <> p_company_id then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- Someone else saved since the caller opened it (or this very save already went
    -- through): refuse, never overwrite.
    if v_template.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    begin
      update public.pdf_templates t
         set name          = v_name,
             body          = p_body,
             revision      = t.revision + 1,
             pdf_sha256    = p_pdf_sha256,
             pdf_file_name = v_file,
             pdf_bytes     = p_pdf_bytes,
             pdf_pages     = p_pdf_pages,
             updated_by    = v_user,
             updated_at    = now()
       where t.id = v_template.id
      returning * into v_template;
    exception when unique_violation then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end;
  end if;

  -- ---------- keep this revision, and at most the last 200 ----------
  insert into public.pdf_template_history (
    template_id, company_id, revision, name, body, pdf_sha256, pdf_file_name, pdf_bytes,
    pdf_pages, saved_by, saved_at
  )
  values (
    v_template.id, v_template.company_id, v_template.revision, v_template.name,
    v_template.body, v_template.pdf_sha256, v_template.pdf_file_name, v_template.pdf_bytes,
    v_template.pdf_pages, v_user, v_template.updated_at
  );

  delete from public.pdf_template_history h
  where h.template_id = v_template.id and h.revision <= v_template.revision - 200;

  -- What was stored, without the body.
  return jsonb_build_object(
    'template_id', v_template.id,
    'name',        v_template.name,
    'revision',    v_template.revision,
    'updated_at',  v_template.updated_at
  );
end;
$$;

revoke all on function public.save_pdf_template(uuid, uuid, text, jsonb, integer, text, text, integer, integer)
  from public, anon;
grant execute on function public.save_pdf_template(uuid, uuid, text, jsonb, integer, text, text, integer, integer)
  to authenticated;

-- ---------- make an earlier revision the newest one ----------
create or replace function public.restore_pdf_template(
  p_company_id        uuid,
  p_template_id       uuid,
  p_revision          integer,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_template public.pdf_templates%rowtype;
  v_old      public.pdf_template_history%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_template_id is null or p_revision is null or p_expected_revision is null then
    raise exception 'PH_INVALID_INPUT: the template, the revision to restore or the last revision seen is missing'
      using errcode = '22023';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  select * into v_template
  from public.pdf_templates t
  where t.id = p_template_id and t.company_id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_template.revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  select * into v_old
  from public.pdf_template_history h
  where h.template_id = p_template_id and h.company_id = p_company_id and h.revision = p_revision;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Its file must still be there.
  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'pdf-forms'
      and o.name = p_company_id::text || '/' || v_old.pdf_sha256 || '.pdf'
  ) then
    raise exception 'PH_NO_FILE' using errcode = 'P0002';
  end if;

  begin
    update public.pdf_templates t
       set name          = v_old.name,
           body          = v_old.body,
           revision      = t.revision + 1,
           pdf_sha256    = v_old.pdf_sha256,
           pdf_file_name = v_old.pdf_file_name,
           pdf_bytes     = v_old.pdf_bytes,
           pdf_pages     = v_old.pdf_pages,
           updated_by    = v_user,
           updated_at    = now()
     where t.id = v_template.id
    returning * into v_template;
  exception when unique_violation then
    -- Another template has taken the name this revision had.
    raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
  end;

  insert into public.pdf_template_history (
    template_id, company_id, revision, name, body, pdf_sha256, pdf_file_name, pdf_bytes,
    pdf_pages, saved_by, saved_at
  )
  values (
    v_template.id, v_template.company_id, v_template.revision, v_template.name,
    v_template.body, v_template.pdf_sha256, v_template.pdf_file_name, v_template.pdf_bytes,
    v_template.pdf_pages, v_user, v_template.updated_at
  );

  delete from public.pdf_template_history h
  where h.template_id = v_template.id and h.revision <= v_template.revision - 200;

  return jsonb_build_object(
    'template_id',   v_template.id,
    'name',          v_template.name,
    'revision',      v_template.revision,
    'restored_from', p_revision,
    'updated_at',    v_template.updated_at
  );
end;
$$;

revoke all on function public.restore_pdf_template(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.restore_pdf_template(uuid, uuid, integer, integer) to authenticated;

-- ---------- copy a template to another company ----------
create or replace function public.copy_pdf_template(
  p_from_company_id uuid,
  p_template_id     uuid,
  p_to_company_id   uuid,
  p_new_template_id uuid,
  p_name            text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_name   text := btrim(coalesce(p_name, ''));
  v_source public.pdf_templates%rowtype;
  v_copy   public.pdf_templates%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of the company it goes TO. A company that does not exist gives the same answer.
  if p_to_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_to_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_from_company_id is null or p_template_id is null or p_new_template_id is null then
    raise exception 'PH_INVALID_INPUT: the template or one of the two companies is missing'
      using errcode = '22023';
  end if;

  if p_from_company_id = p_to_company_id then
    raise exception 'PH_INVALID_INPUT: the two companies are the same' using errcode = '22023';
  end if;

  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'PH_INVALID_INPUT: the template name must be 1 to 80 characters'
      using errcode = '22023';
  end if;

  -- One save at a time in the company it goes to.
  perform 1 from public.companies c where c.id = p_to_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- The template must belong to the company it comes FROM, and the caller must be a member
  -- there. Both failures give the same answer, so this cannot be used to find templates.
  select * into v_source
  from public.pdf_templates t
  where t.id = p_template_id
    and t.company_id = p_from_company_id
    and exists (
      select 1
      from public.company_members m
      where m.company_id = p_from_company_id and m.user_id = v_user
    );

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'pdf-forms'
      and o.name = p_to_company_id::text || '/' || v_source.pdf_sha256 || '.pdf'
  ) then
    raise exception 'PH_NO_FILE' using errcode = 'P0002';
  end if;

  if (select count(*) from public.pdf_templates t where t.company_id = p_to_company_id) >= 50 then
    raise exception 'PH_LIMIT' using errcode = '54000';
  end if;

  if exists (select 1 from public.pdf_templates t where t.id = p_new_template_id) then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  begin
    insert into public.pdf_templates (
      id, company_id, name, body, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages,
      created_by, created_at, updated_by, updated_at
    )
    values (
      p_new_template_id, p_to_company_id, v_name, v_source.body, 1, v_source.pdf_sha256,
      v_source.pdf_file_name, v_source.pdf_bytes, v_source.pdf_pages, v_user, now(), v_user, now()
    )
    returning * into v_copy;
  exception when unique_violation then
    raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
  end;

  insert into public.pdf_template_history (
    template_id, company_id, revision, name, body, pdf_sha256, pdf_file_name, pdf_bytes,
    pdf_pages, saved_by, saved_at
  )
  values (
    v_copy.id, v_copy.company_id, v_copy.revision, v_copy.name, v_copy.body, v_copy.pdf_sha256,
    v_copy.pdf_file_name, v_copy.pdf_bytes, v_copy.pdf_pages, v_user, v_copy.updated_at
  );

  return jsonb_build_object(
    'template_id', v_copy.id,
    'name',        v_copy.name,
    'revision',    v_copy.revision,
    'updated_at',  v_copy.updated_at
  );
end;
$$;

revoke all on function public.copy_pdf_template(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.copy_pdf_template(uuid, uuid, uuid, uuid, text) to authenticated;

-- ---------- delete a template and its history ----------
create or replace function public.delete_pdf_template(
  p_company_id        uuid,
  p_template_id       uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_template public.pdf_templates%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_template_id is null or p_expected_revision is null then
    raise exception 'PH_INVALID_INPUT: the template or the last revision seen is missing'
      using errcode = '22023';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  select * into v_template
  from public.pdf_templates t
  where t.id = p_template_id and t.company_id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Delete exactly what the caller saw, not something somebody saved after it.
  if v_template.revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  delete from public.pdf_template_history h where h.template_id = v_template.id;
  delete from public.pdf_templates t where t.id = v_template.id;

  -- The dashboard removes the file from the bucket only when nothing else here uses it:
  -- no other template of this company, and no kept revision of one.
  return jsonb_build_object(
    'template_id',     v_template.id,
    'name',            v_template.name,
    'pdf_sha256',      v_template.pdf_sha256,
    'file_still_used', exists (
      select 1 from public.pdf_templates t
      where t.company_id = p_company_id and t.pdf_sha256 = v_template.pdf_sha256
    ) or exists (
      select 1 from public.pdf_template_history h
      where h.company_id = p_company_id and h.pdf_sha256 = v_template.pdf_sha256
    )
  );
end;
$$;

revoke all on function public.delete_pdf_template(uuid, uuid, integer) from public, anon;
grant execute on function public.delete_pdf_template(uuid, uuid, integer) to authenticated;

-- ---------- delete_company: as in 0011, plus the two PDF template tables ----------
create or replace function public.delete_company(
  p_company_id   uuid,
  p_confirm_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user              uuid := (select auth.uid());
  v_company           public.companies%rowtype;
  v_issued            integer;
  v_entries           integer;
  v_runs              integer;
  v_employees         integer;
  v_details           integer;
  v_links             integer;
  v_rates             integer;
  v_template_versions integer;
  v_templates         integer;
  v_pdf_history       integer;
  v_pdf_templates     integer;
  v_members           integer;
begin
  -- ---------- who is calling ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company. A company that does not exist gives the same answer, so the
  -- function cannot be used to find out which ids exist.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- Lock the company row for the rest of the transaction, so nothing (an import, a rename,
  -- a save of rates or of a template, an issue of payslips, another delete) can change it or
  -- what belongs to it meanwhile.
  select * into v_company
  from public.companies
  where id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- the caller must name what they are deleting ----------
  -- Compared with the name as it is now, after trimming both. Case-sensitive.
  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(v_company.name) then
    raise exception 'PH_NAME_MISMATCH' using errcode = '22023';
  end if;

  -- ---------- delete, children first ----------
  -- Issued payslips must go before employees and before template versions: both references
  -- are ON DELETE RESTRICT.
  delete from public.issued_payslips p where p.company_id = p_company_id;
  get diagnostics v_issued = row_count;

  -- Entries must go before employees: payroll_entries.employee_id is ON DELETE RESTRICT.
  delete from public.payroll_entries pe
  where pe.run_id in (select r.id from public.payroll_runs r where r.company_id = p_company_id);
  get diagnostics v_entries = row_count;

  delete from public.payroll_runs r where r.company_id = p_company_id;
  get diagnostics v_runs = row_count;

  delete from public.employees e where e.company_id = p_company_id;
  get diagnostics v_employees = row_count;

  delete from public.company_details d where d.company_id = p_company_id;
  get diagnostics v_details = row_count;

  delete from public.company_links l where l.company_id = p_company_id;
  get diagnostics v_links = row_count;

  delete from public.statutory_rates s where s.company_id = p_company_id;
  get diagnostics v_rates = row_count;

  -- Published versions before the templates they belong to.
  delete from public.payslip_template_versions v where v.company_id = p_company_id;
  get diagnostics v_template_versions = row_count;

  delete from public.payslip_templates t where t.company_id = p_company_id;
  get diagnostics v_templates = row_count;

  -- Kept revisions before the PDF templates they belong to. The files themselves are in the
  -- Storage bucket: the dashboard removes them before it calls this function.
  delete from public.pdf_template_history h where h.company_id = p_company_id;
  get diagnostics v_pdf_history = row_count;

  delete from public.pdf_templates t where t.company_id = p_company_id;
  get diagnostics v_pdf_templates = row_count;

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id',           p_company_id,
    'issued_payslips',      v_issued,
    'entries',              v_entries,
    'runs',                 v_runs,
    'employees',            v_employees,
    'details',              v_details,
    'links',                v_links,
    'rates',                v_rates,
    'templates',            v_templates,
    'template_versions',    v_template_versions,
    'pdf_templates',        v_pdf_templates,
    'pdf_template_history', v_pdf_history,
    'members',              v_members
  );
end;
$$;

-- Unchanged, and repeated so this file is enough on its own.
revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;

-- Ask the Data API to pick up the new tables and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select bool_and(c.relrowsecurity) and count(*) = 2
   from pg_class c
   where c.oid in ('public.pdf_templates'::regclass, 'public.pdf_template_history'::regclass))
    as row_security_on_both,
  (select count(*) = 2 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies
   where schemaname = 'public' and tablename in ('pdf_templates', 'pdf_template_history'))
    as only_read_policies,
  (has_table_privilege('authenticated', 'public.pdf_templates', 'select')
    and has_table_privilege('authenticated', 'public.pdf_template_history', 'select'))
    as signed_in_can_read,
  (not has_table_privilege('authenticated', 'public.pdf_templates',
        'insert, update, delete, truncate, references, trigger')
    and not has_table_privilege('authenticated', 'public.pdf_template_history',
        'insert, update, delete, truncate, references, trigger'))
    as signed_in_cannot_write_directly,
  (not has_table_privilege('anon', 'public.pdf_templates',
        'select, insert, update, delete, truncate, references, trigger')
    and not has_table_privilege('anon', 'public.pdf_template_history',
        'select, insert, update, delete, truncate, references, trigger'))
    as anon_has_nothing,
  (select count(*) = 1 and bool_and(not b.public and b.file_size_limit = 5242880
                                    and b.allowed_mime_types = array['application/pdf'])
   from storage.buckets b where b.id = 'pdf-forms')
    as bucket_is_private_pdf_only_5mb,
  (select count(*) = 3
          and bool_and(roles = '{authenticated}')
          and count(*) filter (where cmd = 'SELECT' and qual like '%is_company_member(%') = 1
          and count(*) filter (where cmd = 'INSERT' and with_check like '%is_company_admin(%') = 1
          and count(*) filter (where cmd = 'DELETE' and qual like '%is_company_admin(%') = 1
   from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname like 'pdf_forms_%')
    as bucket_members_read_admins_add_and_remove,
  (public.pdf_form_company('10000000-0000-4000-8000-000000000001/'
        || repeat('a', 64) || '.pdf') = '10000000-0000-4000-8000-000000000001'::uuid
    and public.pdf_form_company('x/' || repeat('a', 64) || '.pdf') is null
    and public.pdf_form_company('10000000-0000-4000-8000-000000000001/notes.pdf') is null
    and public.pdf_form_company('10000000-0000-4000-8000-000000000001/sub/'
        || repeat('a', 64) || '.pdf') is null)
    as file_paths_are_read_strictly,
  (select count(*) = 4 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.save_pdf_template(uuid, uuid, text, jsonb, integer, text, text, integer, integer)'::regprocedure,
     'public.restore_pdf_template(uuid, uuid, integer, integer)'::regprocedure,
     'public.copy_pdf_template(uuid, uuid, uuid, uuid, text)'::regprocedure,
     'public.delete_pdf_template(uuid, uuid, integer)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (has_function_privilege('authenticated',
        'public.save_pdf_template(uuid, uuid, text, jsonb, integer, text, text, integer, integer)', 'execute')
    and has_function_privilege('authenticated',
        'public.restore_pdf_template(uuid, uuid, integer, integer)', 'execute')
    and has_function_privilege('authenticated',
        'public.copy_pdf_template(uuid, uuid, uuid, uuid, text)', 'execute')
    and has_function_privilege('authenticated',
        'public.delete_pdf_template(uuid, uuid, integer)', 'execute'))
    as signed_in_can_call_them,
  (not has_function_privilege('anon',
        'public.save_pdf_template(uuid, uuid, text, jsonb, integer, text, text, integer, integer)', 'execute')
    and not has_function_privilege('anon',
        'public.restore_pdf_template(uuid, uuid, integer, integer)', 'execute')
    and not has_function_privilege('anon',
        'public.copy_pdf_template(uuid, uuid, uuid, uuid, text)', 'execute')
    and not has_function_privilege('anon',
        'public.delete_pdf_template(uuid, uuid, integer)', 'execute')
    and not has_function_privilege('anon', 'public.pdf_form_company(text)', 'execute'))
    as anon_cannot_call_them,
  (select count(*) = 5 from pg_proc
   where proname in ('save_pdf_template', 'restore_pdf_template', 'copy_pdf_template',
                     'delete_pdf_template', 'pdf_form_company'))
    as each_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.pdf_template_history%'
          and p.prosrc like '%public.pdf_templates%'
          and p.prosrc like '%public.issued_payslips%'
          and p.prosrc like '%public.payslip_template_versions%'
          and p.prosrc like '%public.statutory_rates%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
