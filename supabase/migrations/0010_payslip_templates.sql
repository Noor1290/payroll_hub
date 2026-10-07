-- =====================================================================
-- Payslip templates: a draft per template, and immutable published versions
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0009. Safe to re-run.
--
-- 1. public.payslip_templates: one row per template of a company. It holds the DRAFT: a JSON
--    body (labels, lines, which payroll column fills which line; no payroll figures) and a
--    draft revision number that goes up by one on every save.
--
-- 2. public.payslip_template_versions: what was PUBLISHED. Publishing copies the draft as it
--    is into a new row with the next version number, who and when. A published version is
--    never changed and never removed.
--
--    Who can do what, for both tables:
--      * Members of the company: read.
--      * Admins of the company: save a draft and publish, ONLY through the two functions
--        below.
--      * Nobody, through the API: insert, update or delete a row directly. There is no such
--        policy and no such grant.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 3. public.save_payslip_template_draft: creates a template (no template id, last revision
--    seen = 0) or saves over its draft. The caller must say which draft revision they last
--    saw; if someone else saved since, the save is refused instead of overwriting their work.
--
-- 4. public.publish_payslip_template: publishes the current draft, with the same check.
--
--    Both are SECURITY DEFINER because the tables have no write policy or grant; each
--    function applies the rules itself: signed in, admin of THAT company, the template
--    belongs to that company, name and body within limits. search_path = '' and fully
--    qualified names, so nothing can be shadowed.
--
-- 5. public.delete_company (migration 0009) is replaced: it now also deletes these two
--    tables' rows by name and returns their counts as "templates" and "template_versions".
--    Nothing else about it changes. If you ever run an older delete_company file again after
--    this one, run this file again too.
--
-- Limits: a name is 1 to 80 characters and unique in its company (capitals ignored); a body
-- is a JSON object of at most 256 KB; a company has at most 50 templates.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN    no logged-in user
--   PH_NOT_ADMIN        the caller is not an admin of this company (or it does not exist)
--   PH_NOT_FOUND        this company has no template with that id
--   PH_INVALID_INPUT    the name or the body is missing or malformed
--   PH_TOO_LARGE        the body is larger than 256 KB
--   PH_DUPLICATE_NAME   this company already has a template with that name
--   PH_STALE            the draft revision the caller last saw is not the current one
--   PH_NO_CHANGE        the draft is the same as the latest published version
--   PH_LIMIT            the company already has 50 templates
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.payslip_templates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  name            text not null
                  check (name = btrim(name) and char_length(name) between 1 and 80),
  draft_body      jsonb not null
                  check (jsonb_typeof(draft_body) = 'object'
                         and octet_length(draft_body::text) <= 262144),
  draft_revision  integer not null check (draft_revision >= 1),
  -- Become empty if that user account is ever removed; the row itself stays.
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  -- Lets a published version point at its template AND its company together (see below).
  unique (id, company_id)
);

-- One name per company, whatever the capitals.
create unique index if not exists payslip_templates_company_name_idx
  on public.payslip_templates (company_id, lower(name));

create table if not exists public.payslip_template_versions (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null,
  company_id    uuid not null references public.companies(id) on delete cascade,
  version       integer not null check (version >= 1),
  -- The template's name at the moment it was published.
  name          text not null
                check (name = btrim(name) and char_length(name) between 1 and 80),
  body          jsonb not null
                check (jsonb_typeof(body) = 'object'
                       and octet_length(body::text) <= 262144),
  published_by  uuid references auth.users(id) on delete set null,
  published_at  timestamptz not null default now(),
  unique (template_id, version),
  -- A version always carries the same company as its template.
  foreign key (template_id, company_id)
    references public.payslip_templates (id, company_id) on delete cascade
);

-- ---------- row level security: members read; no write policy at all ----------
alter table public.payslip_templates         enable row level security;
alter table public.payslip_template_versions enable row level security;

drop policy if exists "payslip_templates_select" on public.payslip_templates;
create policy "payslip_templates_select" on public.payslip_templates
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists "payslip_template_versions_select" on public.payslip_template_versions;
create policy "payslip_template_versions_select" on public.payslip_template_versions
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.payslip_templates         from public, anon, authenticated;
revoke all on table public.payslip_template_versions from public, anon, authenticated;
grant select on table public.payslip_templates         to authenticated;
grant select on table public.payslip_template_versions to authenticated;

-- ---------- create a template, or save over its draft ----------
create or replace function public.save_payslip_template_draft(
  p_company_id        uuid,
  p_template_id       uuid,
  p_name              text,
  p_body              jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_name     text := btrim(coalesce(p_name, ''));
  v_template public.payslip_templates%rowtype;
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
    raise exception 'PH_INVALID_INPUT: the last draft revision seen is missing'
      using errcode = '22023';
  end if;

  -- One save at a time per company, and never while the company is being deleted.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_template_id is null then
    -- ---------- a new template ----------
    if p_expected_revision <> 0 then
      raise exception 'PH_INVALID_INPUT: a new template has no earlier revision'
        using errcode = '22023';
    end if;

    if (select count(*) from public.payslip_templates t where t.company_id = p_company_id) >= 50 then
      raise exception 'PH_LIMIT' using errcode = '54000';
    end if;

    begin
      insert into public.payslip_templates (
        company_id, name, draft_body, draft_revision, created_by, created_at, updated_by, updated_at
      )
      values (p_company_id, v_name, p_body, 1, v_user, now(), v_user, now())
      returning * into v_template;
    exception when unique_violation then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end;
  else
    -- ---------- an existing template of THIS company ----------
    select * into v_template
    from public.payslip_templates t
    where t.id = p_template_id and t.company_id = p_company_id
    for update;

    if not found then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- Someone else saved since the caller opened it: refuse, never overwrite their work.
    if v_template.draft_revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    begin
      update public.payslip_templates t
         set name           = v_name,
             draft_body     = p_body,
             draft_revision = t.draft_revision + 1,
             updated_by     = v_user,
             updated_at     = now()
       where t.id = v_template.id
      returning * into v_template;
    exception when unique_violation then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end;
  end if;

  -- What was stored, without the body.
  return jsonb_build_object(
    'template_id',    v_template.id,
    'name',           v_template.name,
    'draft_revision', v_template.draft_revision,
    'updated_at',     v_template.updated_at
  );
end;
$$;

revoke all on function public.save_payslip_template_draft(uuid, uuid, text, jsonb, integer)
  from public, anon;
grant execute on function public.save_payslip_template_draft(uuid, uuid, text, jsonb, integer)
  to authenticated;

-- ---------- publish the current draft as the next version ----------
create or replace function public.publish_payslip_template(
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
  v_template public.payslip_templates%rowtype;
  v_latest   integer;
  v_version  public.payslip_template_versions%rowtype;
begin
  -- ---------- who is calling ----------
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
    raise exception 'PH_INVALID_INPUT: the template or the last draft revision seen is missing'
      using errcode = '22023';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- the template, which must belong to THIS company ----------
  select * into v_template
  from public.payslip_templates t
  where t.id = p_template_id and t.company_id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Publish exactly the draft the caller saw, not one somebody saved after it.
  if v_template.draft_revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  select coalesce(max(v.version), 0) into v_latest
  from public.payslip_template_versions v
  where v.template_id = v_template.id;

  -- Publishing the same thing twice would only add an identical version.
  if exists (
    select 1
    from public.payslip_template_versions v
    where v.template_id = v_template.id
      and v.version = v_latest
      and v.name = v_template.name
      and v.body = v_template.draft_body
  ) then
    raise exception 'PH_NO_CHANGE' using errcode = 'P0001';
  end if;

  -- ---------- add the version: its number, the publisher and the time are set here ----------
  insert into public.payslip_template_versions (
    template_id, company_id, version, name, body, published_by, published_at
  )
  values (
    v_template.id, v_template.company_id, v_latest + 1,
    v_template.name, v_template.draft_body, v_user, now()
  )
  returning * into v_version;

  return jsonb_build_object(
    'template_id',    v_version.template_id,
    'version',        v_version.version,
    'draft_revision', v_template.draft_revision,
    'published_at',   v_version.published_at
  );
end;
$$;

revoke all on function public.publish_payslip_template(uuid, uuid, integer) from public, anon;
grant execute on function public.publish_payslip_template(uuid, uuid, integer) to authenticated;

-- ---------- delete_company: as in 0009, plus the two template tables ----------
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
  v_entries           integer;
  v_runs              integer;
  v_employees         integer;
  v_details           integer;
  v_links             integer;
  v_rates             integer;
  v_template_versions integer;
  v_templates         integer;
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
  -- a save of rates or of a template, another delete) can change it or what belongs to it
  -- meanwhile.
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

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id',        p_company_id,
    'entries',           v_entries,
    'runs',              v_runs,
    'employees',         v_employees,
    'details',           v_details,
    'links',             v_links,
    'rates',             v_rates,
    'templates',         v_templates,
    'template_versions', v_template_versions,
    'members',           v_members
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
   where c.oid in ('public.payslip_templates'::regclass,
                   'public.payslip_template_versions'::regclass))
    as row_security_on_both,
  (select count(*) = 2 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies
   where schemaname = 'public'
     and tablename in ('payslip_templates', 'payslip_template_versions'))
    as only_read_policies,
  (has_table_privilege('authenticated', 'public.payslip_templates', 'select')
    and has_table_privilege('authenticated', 'public.payslip_template_versions', 'select'))
    as signed_in_can_read,
  (not has_table_privilege('authenticated', 'public.payslip_templates',
        'insert, update, delete, truncate, references, trigger')
    and not has_table_privilege('authenticated', 'public.payslip_template_versions',
        'insert, update, delete, truncate, references, trigger'))
    as signed_in_cannot_write_directly,
  (not has_table_privilege('anon', 'public.payslip_templates',
        'select, insert, update, delete, truncate, references, trigger')
    and not has_table_privilege('anon', 'public.payslip_template_versions',
        'select, insert, update, delete, truncate, references, trigger'))
    as anon_has_nothing,
  (select count(*) = 2 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.save_payslip_template_draft(uuid, uuid, text, jsonb, integer)'::regprocedure,
     'public.publish_payslip_template(uuid, uuid, integer)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (has_function_privilege('authenticated',
        'public.save_payslip_template_draft(uuid, uuid, text, jsonb, integer)', 'execute')
    and has_function_privilege('authenticated',
        'public.publish_payslip_template(uuid, uuid, integer)', 'execute'))
    as signed_in_can_call_them,
  (not has_function_privilege('anon',
        'public.save_payslip_template_draft(uuid, uuid, text, jsonb, integer)', 'execute')
    and not has_function_privilege('anon',
        'public.publish_payslip_template(uuid, uuid, integer)', 'execute'))
    as anon_cannot_call_them,
  (select count(*) = 2 from pg_proc
   where proname in ('save_payslip_template_draft', 'publish_payslip_template'))
    as each_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.payslip_template_versions%'
          and p.prosrc like '%public.payslip_templates%'
          and p.prosrc like '%public.statutory_rates%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
