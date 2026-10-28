-- =====================================================================
-- MRA Returns: the return file templates, each company's MRA details, and each user's email
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0019. Safe to re-run.
-- Undo (only if asked): supabase/undo/0020_mra_returns_undo.sql
--
-- Nothing that exists is changed: no existing table, column, row, policy or grant. This file
-- only ADDS five tables, five read policies and ten functions, and replaces public.delete_company
-- with the same function plus the new tables.
--
-- 1. public.mra_templates: the MRA Returns app's templates of a return file (the CSG file, MRA
--    "PACO", and the PRGF file): the grid of cells, which row is copied, the employer row and
--    the employee row, what goes in each cell, the formats and the file settings. A JSON body,
--    written by the app and stored exactly as sent, and a revision number that goes up by one
--    on every save. It holds no employee and no payroll figure: the app keeps the text of the
--    copied rows only (titles and headings), never the employee rows of an uploaded file.
--    public.mra_template_history keeps EVERY revision (History and Restore).
--
-- 2. public.mra_template_companies: the companies a template is used by, one row per company,
--    each with its own values (a fixed value "for this company only") as a JSON object and a
--    revision number. A template is used by at least one company from the moment it is made:
--    it is made for the company the admin is working in.
--
--    Who can do what, as for the payroll app's Global columns (migration 0013):
--      * A template: read by an ADMIN of at least one company using it. Changed only by
--        someone who is an admin of EVERY company using it, because a change reaches all of
--        them.
--      * A company's own values: read and changed by an admin of that company.
--      * Using a template in another company: an admin of that company who may also change
--        the template. Taking it out of a company: an admin of that company; when no company
--        uses it any more, it is deleted with its history.
--      * Nobody, through the API: insert, update or delete a row directly.
--      * Members who are not admins, everyone else, and anonymous visitors: nothing.
--
-- 3. public.mra_company_details: one row per company, its details for the MRA: the Employer
--    Registration Number (ERN, text, so leading zeros stay), the telephone and mobile numbers
--    and the name of the declarant. Read and changed by the company's admins only (Company
--    profile in the dashboard).
--
-- 4. public.mra_settings: one row per signed-in user: their email address for the MRA returns,
--    the same for every company. Read and changed by that user only, and only by someone who is
--    an admin of at least one company.
--
-- 5. The functions. Every save names the revision the caller last saw (0 for something new); if
--    someone else saved since, it is refused instead of overwriting their work.
--      public.can_read_mra_template, public.can_change_mra_template, public.mra_template_access:
--        the rules above for the signed-in user (true or false, and counts only).
--      public.save_mra_template: makes a template for a company, or saves over one.
--      public.attach_mra_template: uses a template in another company too.
--      public.save_mra_template_values: saves a company's own values.
--      public.detach_mra_template: takes a template out of a company (deleting it when no
--        company uses it any more).
--      public.save_mra_company_details, public.save_mra_settings.
--    All are SECURITY DEFINER: the tables have no write policy or grant, and the rules look at
--    companies the caller may not be an admin of, so each function applies the rules itself,
--    who is calling first, before any input is looked at. search_path = '' and fully qualified
--    names, so nothing can be shadowed.
--
-- 6. public.delete_company (newest in migration 0018) is replaced: it now also deletes the
--    company's MRA details and its rows in mra_template_companies, and every template no other
--    company uses any more, with its history. It returns their counts as "mra_company_details",
--    "mra_template_companies", "mra_templates" and "mra_template_history". Nothing else about
--    it changes. If you ever run an older delete_company file again after this one, run this
--    file again too. mra_settings belongs to a user, not to a company: it is not touched.
--
-- Limits: a template name is 1 to 80 characters, unique in each company using it whatever the
-- capitals; a body is a JSON object of at most 256 KB; a company's own values at most 64 KB; a
-- company uses at most 20 templates. ERN: letters and digits, at most 20. Telephone and mobile:
-- digits, spaces and + - ( ), at most 30. Declarant: at most 120 characters. Email: at most 254
-- characters, one @, no spaces, commas or semicolons. Every text is trimmed and has no control
-- characters.
--
-- Errors the dashboard recognises (message prefix), as in 0010, 0013 and 0018:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_NOT_FOUND, PH_INVALID_INPUT, PH_TOO_LARGE, PH_STALE,
--   PH_ALREADY_ATTACHED, PH_DUPLICATE_NAME, PH_LIMIT
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.mra_templates (
  -- Chosen by the app, so a save that is sent twice cannot make two templates.
  id          uuid primary key,
  name        text not null
              check (name = btrim(name) and char_length(name) between 1 and 80),
  body        jsonb not null
              check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 262144),
  revision    integer not null check (revision >= 1),
  -- Become empty if that user account is ever removed; the row itself stays.
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.mra_template_history (
  template_id  uuid not null references public.mra_templates(id) on delete cascade,
  revision     integer not null check (revision >= 1),
  name         text not null,
  body         jsonb not null,
  saved_by     uuid references auth.users(id) on delete set null,
  saved_at     timestamptz not null default now(),
  primary key (template_id, revision)
);

create table if not exists public.mra_template_companies (
  template_id  uuid not null references public.mra_templates(id) on delete restrict,
  company_id   uuid not null references public.companies(id) on delete cascade,
  own_values   jsonb not null
               check (jsonb_typeof(own_values) = 'object' and octet_length(own_values::text) <= 65536),
  revision     integer not null check (revision >= 1),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (template_id, company_id)
);

create index if not exists mra_template_companies_company_idx
  on public.mra_template_companies (company_id);

create table if not exists public.mra_company_details (
  company_id  uuid primary key references public.companies(id) on delete cascade,
  -- Text, never a number: "013341" keeps its leading zero.
  ern         text not null default ''
              check (ern ~ '^[0-9A-Za-z]{0,20}$'),
  telephone   text not null default ''
              check (telephone = btrim(telephone) and telephone ~ '^[0-9 +()-]{0,30}$'),
  mobile      text not null default ''
              check (mobile = btrim(mobile) and mobile ~ '^[0-9 +()-]{0,30}$'),
  declarant   text not null default ''
              check (declarant = btrim(declarant) and char_length(declarant) <= 120
                     and declarant !~ '[[:cntrl:]]'),
  revision    integer not null check (revision >= 1),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.mra_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null default ''
              check (email = '' or (char_length(email) <= 254
                     and email ~ '^[^@[:space:][:cntrl:],;]+@[^@[:space:][:cntrl:],;]+$')),
  revision    integer not null check (revision >= 1),
  updated_at  timestamptz not null default now()
);

-- ---------- who may read or change a template ----------
-- SECURITY DEFINER because the answer depends on companies the caller may not be an admin of
-- (they use the template all the same). Each answers only true or false, about the caller.

-- An admin of at least one company using it.
create or replace function public.can_read_mra_template(p_template_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.mra_template_companies tc
    join public.company_members m on m.company_id = tc.company_id
    where tc.template_id = p_template_id
      and m.user_id = (select auth.uid())
      and m.role = 'admin'
  );
$$;

-- An admin of EVERY company using it (and there is always at least one).
create or replace function public.can_change_mra_template(p_template_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (select 1 from public.mra_template_companies tc where tc.template_id = p_template_id)
    and not exists (
      select 1
      from public.mra_template_companies tc
      where tc.template_id = p_template_id
        and not exists (
          select 1 from public.company_members m
          where m.company_id = tc.company_id
            and m.user_id = (select auth.uid())
            and m.role = 'admin'
        )
    );
$$;

-- What the app shows: whether the caller may change it, how many companies use it, and of how
-- many of those the caller is an admin. Counts only, never which companies. Someone who may not
-- read the template gets false and zeros, as for a template that does not exist.
create or replace function public.mra_template_access(p_template_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.can_read_mra_template(p_template_id) then jsonb_build_object(
      'can_change', public.can_change_mra_template(p_template_id),
      'companies', (
        select count(*) from public.mra_template_companies tc where tc.template_id = p_template_id
      ),
      'admin_of', (
        select count(*)
        from public.mra_template_companies tc
        join public.company_members m on m.company_id = tc.company_id
        where tc.template_id = p_template_id
          and m.user_id = (select auth.uid())
          and m.role = 'admin'
      )
    )
    else jsonb_build_object('can_change', false, 'companies', 0, 'admin_of', 0)
  end;
$$;

revoke all on function public.can_read_mra_template(uuid) from public, anon;
revoke all on function public.can_change_mra_template(uuid) from public, anon;
revoke all on function public.mra_template_access(uuid) from public, anon;
grant execute on function public.can_read_mra_template(uuid) to authenticated;
grant execute on function public.can_change_mra_template(uuid) to authenticated;
grant execute on function public.mra_template_access(uuid) to authenticated;

-- ---------- row level security: read policies only ----------
alter table public.mra_templates          enable row level security;
alter table public.mra_template_history   enable row level security;
alter table public.mra_template_companies enable row level security;
alter table public.mra_company_details    enable row level security;
alter table public.mra_settings           enable row level security;

drop policy if exists "mra_templates_select" on public.mra_templates;
create policy "mra_templates_select" on public.mra_templates
  for select to authenticated
  using (public.can_read_mra_template(id));

drop policy if exists "mra_template_history_select" on public.mra_template_history;
create policy "mra_template_history_select" on public.mra_template_history
  for select to authenticated
  using (public.can_read_mra_template(template_id));

drop policy if exists "mra_template_companies_select" on public.mra_template_companies;
create policy "mra_template_companies_select" on public.mra_template_companies
  for select to authenticated
  using (public.is_company_admin(company_id));

drop policy if exists "mra_company_details_select" on public.mra_company_details;
create policy "mra_company_details_select" on public.mra_company_details
  for select to authenticated
  using (public.is_company_admin(company_id));

drop policy if exists "mra_settings_select" on public.mra_settings;
create policy "mra_settings_select" on public.mra_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.mra_templates          from public, anon, authenticated;
revoke all on table public.mra_template_history   from public, anon, authenticated;
revoke all on table public.mra_template_companies from public, anon, authenticated;
revoke all on table public.mra_company_details    from public, anon, authenticated;
revoke all on table public.mra_settings           from public, anon, authenticated;
grant select on table public.mra_templates          to authenticated;
grant select on table public.mra_template_history   to authenticated;
grant select on table public.mra_template_companies to authenticated;
grant select on table public.mra_company_details    to authenticated;
grant select on table public.mra_settings           to authenticated;

-- ---------- make a template for a company, or save over one ----------
-- p_company_id is the company the caller is working in: the template is made for it
-- (p_expected_revision = 0), or must be one it is used by.
create or replace function public.save_mra_template(
  p_template_id       uuid,
  p_company_id        uuid,
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
  v_template public.mra_templates%rowtype;
begin
  -- ---------- who is calling: before any input is looked at ----------
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
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  -- One save at a time per template; attaching and taking out take the same lock first.
  select * into v_template
  from public.mra_templates t
  where t.id = p_template_id
  for update;

  if not found then
    -- ---------- a new template, for this company ----------
    if p_expected_revision <> 0 then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- Never while the company is being deleted.
    perform 1 from public.companies c where c.id = p_company_id for update;
    if not found then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;

    if (select count(*) from public.mra_template_companies tc where tc.company_id = p_company_id)
       >= 20 then
      raise exception 'PH_LIMIT' using errcode = '54000';
    end if;

    if exists (
      select 1
      from public.mra_template_companies tc
      join public.mra_templates t on t.id = tc.template_id
      where tc.company_id = p_company_id and lower(t.name) = lower(v_name)
    ) then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end if;

    begin
      insert into public.mra_templates (
        id, name, body, revision, created_by, created_at, updated_by, updated_at
      )
      values (p_template_id, v_name, p_body, 1, v_user, now(), v_user, now())
      returning * into v_template;
    exception when unique_violation then
      -- Made by someone else in the same moment.
      raise exception 'PH_STALE' using errcode = 'P0001';
    end;

    insert into public.mra_template_companies (
      template_id, company_id, own_values, revision, created_by, created_at, updated_by, updated_at
    )
    values (v_template.id, p_company_id, '{}'::jsonb, 1, v_user, now(), v_user, now());
  else
    -- ---------- an existing template, used by this company ----------
    if not exists (
      select 1 from public.mra_template_companies tc
      where tc.template_id = p_template_id and tc.company_id = p_company_id
    ) then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- The change reaches every company using it: the caller must be an admin of all of them.
    if not public.can_change_mra_template(p_template_id) then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;

    -- Someone else saved since the caller loaded it (or this very save already went
    -- through): refuse, never overwrite.
    if v_template.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    -- A new name must not be another template's in any company using this one.
    if exists (
      select 1
      from public.mra_template_companies mine
      join public.mra_template_companies other
        on other.company_id = mine.company_id and other.template_id <> mine.template_id
      join public.mra_templates t on t.id = other.template_id
      where mine.template_id = p_template_id and lower(t.name) = lower(v_name)
    ) then
      raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
    end if;

    update public.mra_templates t
       set name       = v_name,
           body       = p_body,
           revision   = t.revision + 1,
           updated_by = v_user,
           updated_at = now()
     where t.id = v_template.id
    returning * into v_template;
  end if;

  -- ---------- keep this revision: every one, none dropped ----------
  insert into public.mra_template_history (template_id, revision, name, body, saved_by, saved_at)
  values (
    v_template.id, v_template.revision, v_template.name, v_template.body, v_user,
    v_template.updated_at
  );

  -- What was stored, without the body.
  return jsonb_build_object(
    'template_id', v_template.id,
    'name',        v_template.name,
    'revision',    v_template.revision,
    'updated_at',  v_template.updated_at
  );
end;
$$;

revoke all on function public.save_mra_template(uuid, uuid, text, jsonb, integer)
  from public, anon;
grant execute on function public.save_mra_template(uuid, uuid, text, jsonb, integer)
  to authenticated;

-- ---------- use a template in another company too ----------
create or replace function public.attach_mra_template(
  p_template_id uuid,
  p_company_id  uuid,
  p_own_values  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_template public.mra_templates%rowtype;
  v_link     public.mra_template_companies%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_template_id is null then
    raise exception 'PH_INVALID_INPUT: the template is missing' using errcode = '22023';
  end if;

  if p_own_values is null or jsonb_typeof(p_own_values) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the company values must be a JSON object'
      using errcode = '22023';
  end if;

  if octet_length(p_own_values::text) > 65536 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  -- The template first, then the company: the same order as every other save here.
  select * into v_template from public.mra_templates t where t.id = p_template_id for update;
  if not found or not public.can_read_mra_template(p_template_id) then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Using it in one more company gives that company's admins a say over the others: it needs
  -- the right to change the template.
  if not public.can_change_mra_template(p_template_id) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- Once per company. Attaching twice is refused, never a second row.
  if exists (
    select 1 from public.mra_template_companies tc
    where tc.template_id = p_template_id and tc.company_id = p_company_id
  ) then
    raise exception 'PH_ALREADY_ATTACHED' using errcode = '23505';
  end if;

  if (select count(*) from public.mra_template_companies tc where tc.company_id = p_company_id)
     >= 20 then
    raise exception 'PH_LIMIT' using errcode = '54000';
  end if;

  if exists (
    select 1
    from public.mra_template_companies tc
    join public.mra_templates t on t.id = tc.template_id
    where tc.company_id = p_company_id and lower(t.name) = lower(v_template.name)
  ) then
    raise exception 'PH_DUPLICATE_NAME' using errcode = '23505';
  end if;

  insert into public.mra_template_companies (
    template_id, company_id, own_values, revision, created_by, created_at, updated_by, updated_at
  )
  values (p_template_id, p_company_id, p_own_values, 1, v_user, now(), v_user, now())
  returning * into v_link;

  return jsonb_build_object(
    'template_id', v_link.template_id,
    'company_id',  v_link.company_id,
    'revision',    v_link.revision,
    'updated_at',  v_link.updated_at
  );
end;
$$;

revoke all on function public.attach_mra_template(uuid, uuid, jsonb) from public, anon;
grant execute on function public.attach_mra_template(uuid, uuid, jsonb) to authenticated;

-- ---------- a company's own values ----------
create or replace function public.save_mra_template_values(
  p_template_id       uuid,
  p_company_id        uuid,
  p_own_values        jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_link public.mra_template_companies%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_own_values is null or jsonb_typeof(p_own_values) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the company values must be a JSON object'
      using errcode = '22023';
  end if;

  if octet_length(p_own_values::text) > 65536 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  -- The template first, then the company, as the other saves.
  perform 1 from public.mra_templates t where t.id = p_template_id for update;
  perform 1 from public.companies c where c.id = p_company_id for update;

  select * into v_link
  from public.mra_template_companies tc
  where tc.template_id = p_template_id and tc.company_id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_link.revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  update public.mra_template_companies tc
     set own_values = p_own_values,
         revision   = tc.revision + 1,
         updated_by = v_user,
         updated_at = now()
   where tc.template_id = p_template_id and tc.company_id = p_company_id
  returning * into v_link;

  return jsonb_build_object(
    'template_id', v_link.template_id,
    'company_id',  v_link.company_id,
    'revision',    v_link.revision,
    'updated_at',  v_link.updated_at
  );
end;
$$;

revoke all on function public.save_mra_template_values(uuid, uuid, jsonb, integer)
  from public, anon;
grant execute on function public.save_mra_template_values(uuid, uuid, jsonb, integer)
  to authenticated;

-- ---------- take a template out of a company ----------
-- p_expected_revision is the TEMPLATE's revision the caller last saw: what they decided to
-- take out (or, for the last company, to delete) is what is stored now.
create or replace function public.detach_mra_template(
  p_template_id       uuid,
  p_company_id        uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_template public.mra_templates%rowtype;
  v_deleted  boolean := false;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  select * into v_template from public.mra_templates t where t.id = p_template_id for update;
  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;

  if not exists (
    select 1 from public.mra_template_companies tc
    where tc.template_id = p_template_id and tc.company_id = p_company_id
  ) then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_template.revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  delete from public.mra_template_companies tc
  where tc.template_id = p_template_id and tc.company_id = p_company_id;

  -- No company uses it any more: nobody could read it again, so it goes, with its history.
  if not exists (
    select 1 from public.mra_template_companies tc where tc.template_id = p_template_id
  ) then
    delete from public.mra_template_history h where h.template_id = p_template_id;
    delete from public.mra_templates t where t.id = p_template_id;
    v_deleted := true;
  end if;

  return jsonb_build_object(
    'template_id', p_template_id,
    'name',        v_template.name,
    'deleted',     v_deleted
  );
end;
$$;

revoke all on function public.detach_mra_template(uuid, uuid, integer) from public, anon;
grant execute on function public.detach_mra_template(uuid, uuid, integer) to authenticated;

-- ---------- a company's MRA details ----------
create or replace function public.save_mra_company_details(
  p_company_id        uuid,
  p_ern               text,
  p_telephone         text,
  p_mobile            text,
  p_declarant         text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := (select auth.uid());
  v_ern       text := btrim(coalesce(p_ern, ''));
  v_telephone text := btrim(coalesce(p_telephone, ''));
  v_mobile    text := btrim(coalesce(p_mobile, ''));
  v_declarant text := btrim(coalesce(p_declarant, ''));
  v_row       public.mra_company_details%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if v_ern !~ '^[0-9A-Za-z]{0,20}$' then
    raise exception 'PH_INVALID_INPUT: the ERN must be letters and digits only, at most 20'
      using errcode = '22023';
  end if;
  if v_telephone !~ '^[0-9 +()-]{0,30}$' or v_mobile !~ '^[0-9 +()-]{0,30}$' then
    raise exception 'PH_INVALID_INPUT: a phone number must be digits, spaces and + - ( ) only, at most 30'
      using errcode = '22023';
  end if;
  if char_length(v_declarant) > 120 or v_declarant ~ '[[:cntrl:]]' then
    raise exception 'PH_INVALID_INPUT: the name of the declarant must be at most 120 characters'
      using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  -- One change at a time per company, and never while the company is being deleted.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  select * into v_row from public.mra_company_details d where d.company_id = p_company_id;

  if not found then
    if p_expected_revision <> 0 then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;
    insert into public.mra_company_details (
      company_id, ern, telephone, mobile, declarant, revision, updated_by, updated_at
    )
    values (p_company_id, v_ern, v_telephone, v_mobile, v_declarant, 1, v_user, now())
    returning * into v_row;
  else
    if v_row.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;
    update public.mra_company_details d
       set ern        = v_ern,
           telephone  = v_telephone,
           mobile     = v_mobile,
           declarant  = v_declarant,
           revision   = d.revision + 1,
           updated_by = v_user,
           updated_at = now()
     where d.company_id = p_company_id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'company_id', v_row.company_id,
    'ern',        v_row.ern,
    'telephone',  v_row.telephone,
    'mobile',     v_row.mobile,
    'declarant',  v_row.declarant,
    'revision',   v_row.revision,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.save_mra_company_details(uuid, text, text, text, text, integer)
  from public, anon;
grant execute on function public.save_mra_company_details(uuid, text, text, text, text, integer)
  to authenticated;

-- ---------- the signed-in user's email for the MRA returns ----------
create or replace function public.save_mra_settings(
  p_email             text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_email text := btrim(coalesce(p_email, ''));
  v_row   public.mra_settings%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Only someone who makes MRA returns: an admin of at least one company. Decided from who is
  -- calling alone, before the input is looked at.
  if not exists (
    select 1 from public.company_members m where m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if v_email <> '' and (char_length(v_email) > 254
     or v_email !~ '^[^@[:space:][:cntrl:],;]+@[^@[:space:][:cntrl:],;]+$') then
    raise exception 'PH_INVALID_INPUT: the email address is not valid' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  select * into v_row from public.mra_settings s where s.user_id = v_user for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;
    begin
      insert into public.mra_settings (user_id, email, revision, updated_at)
      values (v_user, v_email, 1, now())
      returning * into v_row;
    exception when unique_violation then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end;
  else
    if v_row.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;
    update public.mra_settings s
       set email      = v_email,
           revision   = s.revision + 1,
           updated_at = now()
     where s.user_id = v_user
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'email',      v_row.email,
    'revision',   v_row.revision,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.save_mra_settings(text, integer) from public, anon;
grant execute on function public.save_mra_settings(text, integer) to authenticated;

-- ---------- delete_company: as in 0018, plus the MRA tables ----------
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
  v_in_use            integer;
  v_template_versions integer;
  v_templates         integer;
  v_pdf_history       integer;
  v_pdf_templates     integer;
  v_month_history     integer;
  v_months            integer;
  v_shared_id         uuid;
  v_setup_history     integer;
  v_setups            integer;
  v_shared_history    integer := 0;
  v_shared_setups     integer := 0;
  v_mra_ids           uuid[];
  v_mra_links         integer;
  v_mra_history       integer;
  v_mra_templates     integer;
  v_mra_details       integer;
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
  -- a save of rates, of a template or of a month, an issue of payslips, another delete) can
  -- change it or what belongs to it meanwhile.
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

  -- The choice of template (0018) before the versions and templates it points at.
  delete from public.payslip_template_in_use u where u.company_id = p_company_id;
  get diagnostics v_in_use = row_count;

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

  -- The months, with their history, before the column setup revisions they point at (those
  -- references are ON DELETE RESTRICT).
  delete from public.payroll_month_history h where h.company_id = p_company_id;
  get diagnostics v_month_history = row_count;

  delete from public.payroll_months pm where pm.company_id = p_company_id;
  get diagnostics v_months = row_count;

  -- The company's payroll setup. Its shared setup is locked first, in the same order as the
  -- saves take their locks, so a save of the shared setup cannot run into this half way.
  select cs.shared_setup_id into v_shared_id
  from public.payroll_company_setups cs
  where cs.company_id = p_company_id;

  if v_shared_id is not null then
    perform 1 from public.payroll_shared_setups s where s.id = v_shared_id for update;
  end if;

  delete from public.payroll_company_setup_history h where h.company_id = p_company_id;
  get diagnostics v_setup_history = row_count;

  delete from public.payroll_company_setups cs where cs.company_id = p_company_id;
  get diagnostics v_setups = row_count;

  -- A shared setup that no other company uses any more goes too, with its revisions: nobody
  -- else could read it, and it would otherwise be left behind for good.
  if v_shared_id is not null and not exists (
    select 1 from public.payroll_company_setups cs where cs.shared_setup_id = v_shared_id
  ) and not exists (
    select 1 from public.payroll_company_setup_history h where h.shared_setup_id = v_shared_id
  ) and not exists (
    select 1 from public.payroll_months pm where pm.shared_setup_id = v_shared_id
  ) then
    delete from public.payroll_shared_setup_history h where h.shared_setup_id = v_shared_id;
    get diagnostics v_shared_history = row_count;

    delete from public.payroll_shared_setups s where s.id = v_shared_id;
    get diagnostics v_shared_setups = row_count;
  end if;

  -- The MRA templates (0020): the templates this company uses are locked first, in the same
  -- order as the saves take their locks; then its own values go, and every one of those
  -- templates that no other company uses any more, with its history (nobody else could read it).
  select coalesce(array_agg(tc.template_id order by tc.template_id), '{}') into v_mra_ids
  from public.mra_template_companies tc
  where tc.company_id = p_company_id;

  perform 1 from public.mra_templates t where t.id = any(v_mra_ids) order by t.id for update;

  delete from public.mra_template_companies tc where tc.company_id = p_company_id;
  get diagnostics v_mra_links = row_count;

  delete from public.mra_template_history h
  where h.template_id = any(v_mra_ids)
    and not exists (
      select 1 from public.mra_template_companies tc where tc.template_id = h.template_id
    );
  get diagnostics v_mra_history = row_count;

  delete from public.mra_templates t
  where t.id = any(v_mra_ids)
    and not exists (select 1 from public.mra_template_companies tc where tc.template_id = t.id);
  get diagnostics v_mra_templates = row_count;

  delete from public.mra_company_details d where d.company_id = p_company_id;
  get diagnostics v_mra_details = row_count;

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id',                    p_company_id,
    'issued_payslips',               v_issued,
    'entries',                       v_entries,
    'runs',                          v_runs,
    'employees',                     v_employees,
    'details',                       v_details,
    'links',                         v_links,
    'rates',                         v_rates,
    'template_in_use',               v_in_use,
    'templates',                     v_templates,
    'template_versions',             v_template_versions,
    'pdf_templates',                 v_pdf_templates,
    'pdf_template_history',          v_pdf_history,
    'payroll_months',                v_months,
    'payroll_month_history',         v_month_history,
    'payroll_company_setups',        v_setups,
    'payroll_company_setup_history', v_setup_history,
    'payroll_shared_setups',         v_shared_setups,
    'payroll_shared_setup_history',  v_shared_history,
    'mra_template_companies',        v_mra_links,
    'mra_templates',                 v_mra_templates,
    'mra_template_history',          v_mra_history,
    'mra_company_details',           v_mra_details,
    'members',                       v_members
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
  (select bool_and(c.relrowsecurity) and count(*) = 5
   from pg_class c
   where c.oid in ('public.mra_templates'::regclass,
                   'public.mra_template_history'::regclass,
                   'public.mra_template_companies'::regclass,
                   'public.mra_company_details'::regclass,
                   'public.mra_settings'::regclass))
    as row_security_on_all_five,
  (select count(*) = 5 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies
   where schemaname = 'public'
     and tablename in ('mra_templates', 'mra_template_history', 'mra_template_companies',
                       'mra_company_details', 'mra_settings'))
    as only_read_policies,
  (select count(*) = 2 and bool_and(qual like '%can_read_mra_template(%')
   from pg_policies
   where schemaname = 'public' and tablename in ('mra_templates', 'mra_template_history'))
    as templates_read_by_admins_of_a_company_using_them,
  (select count(*) = 2 and bool_and(qual like '%is_company_admin(%')
   from pg_policies
   where schemaname = 'public' and tablename in ('mra_template_companies', 'mra_company_details'))
    as company_rows_read_by_its_admins,
  (select count(*) = 1 and bool_and(qual like '%auth.uid()%')
   from pg_policies
   where schemaname = 'public' and tablename = 'mra_settings')
    as settings_read_by_their_user_only,
  (select bool_and(has_table_privilege('authenticated', t, 'select'))
   from unnest(array['public.mra_templates', 'public.mra_template_history',
                     'public.mra_template_companies', 'public.mra_company_details',
                     'public.mra_settings']) t)
    as signed_in_can_read,
  (select bool_and(not has_table_privilege('authenticated', t,
                     'insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.mra_templates', 'public.mra_template_history',
                     'public.mra_template_companies', 'public.mra_company_details',
                     'public.mra_settings']) t)
    as signed_in_cannot_write_directly,
  (select bool_and(not has_table_privilege('anon', t,
                     'select, insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.mra_templates', 'public.mra_template_history',
                     'public.mra_template_companies', 'public.mra_company_details',
                     'public.mra_settings']) t)
    as anon_has_nothing,
  (select count(*) = 10 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.can_read_mra_template(uuid)'::regprocedure,
     'public.can_change_mra_template(uuid)'::regprocedure,
     'public.mra_template_access(uuid)'::regprocedure,
     'public.save_mra_template(uuid, uuid, text, jsonb, integer)'::regprocedure,
     'public.attach_mra_template(uuid, uuid, jsonb)'::regprocedure,
     'public.save_mra_template_values(uuid, uuid, jsonb, integer)'::regprocedure,
     'public.detach_mra_template(uuid, uuid, integer)'::regprocedure,
     'public.save_mra_company_details(uuid, text, text, text, text, integer)'::regprocedure,
     'public.save_mra_settings(text, integer)'::regprocedure,
     'public.delete_company(uuid, text)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.can_read_mra_template(uuid)',
     'public.can_change_mra_template(uuid)',
     'public.mra_template_access(uuid)',
     'public.save_mra_template(uuid, uuid, text, jsonb, integer)',
     'public.attach_mra_template(uuid, uuid, jsonb)',
     'public.save_mra_template_values(uuid, uuid, jsonb, integer)',
     'public.detach_mra_template(uuid, uuid, integer)',
     'public.save_mra_company_details(uuid, text, text, text, text, integer)',
     'public.save_mra_settings(text, integer)',
     'public.delete_company(uuid, text)']) f)
    as signed_in_only_can_call_them,
  (select count(*) = 10 from pg_proc
   where proname in ('can_read_mra_template', 'can_change_mra_template', 'mra_template_access',
                     'save_mra_template', 'attach_mra_template', 'save_mra_template_values',
                     'detach_mra_template', 'save_mra_company_details', 'save_mra_settings',
                     'delete_company'))
    as each_exists_once,
  (select p.prosrc like '%public.mra_template_companies%'
          and p.prosrc like '%public.mra_template_history%'
          and p.prosrc like '%public.mra_company_details%'
          and p.prosrc like '%public.payslip_template_in_use%'
          and p.prosrc like '%public.payroll_month_history%'
          and p.prosrc like '%public.issued_payslips%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated;
