-- =====================================================================
-- Payslip templates: the one "used for the payslips", and publishing to several companies
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0017. Safe to re-run.
-- Undo (only if asked): supabase/undo/0018_payslip_template_in_use_undo.sql
--
-- Nothing that exists is changed: no existing row, column, policy or grant. This file only ADDS
-- one table and three functions, and replaces public.delete_company with the same function
-- plus the new table.
--
-- 1. public.payslip_template_in_use: one row per company at most, naming the published version
--    of one of ITS templates that its payslips are made with. Until now the payslip app kept
--    that choice in memory only (its known issue 14), so another company's choice could be
--    neither set nor read. The row starts empty for every company: nothing is chosen for anyone.
--
--    Who can do what:
--      * Members of the company: read.
--      * Admins of the company: set or clear it, ONLY through the functions below.
--      * Nobody, through the API: insert, update or delete a row directly. There is no such
--        policy and no such grant.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 2. public.set_payslip_template_in_use: an admin of the company names one of its published
--    versions (or null, to clear the choice).
--
-- 3. public.publish_payslip_template_copy: publishes a template body to ONE company, all or
--    nothing, in one transaction:
--      * the company's template with the same name (capitals ignored) gets the body as its
--        draft and, unless its latest published version already is exactly that, a new version;
--      * a company without one gets a new template with that name, published as version 1;
--      * either way that version becomes the one used for its payslips.
--    The caller states the draft revision it saw when it checked the company (0 when the
--    company had no template with that name). If that is no longer so, it is refused as
--    PH_STALE and nothing is stored, so work saved in that company after the check is never
--    overwritten. Issued payslips are not touched.
--
-- 4. public.payroll_run_columns: for ONE company the caller is an admin of, the month of its
--    newest saved run, how many employees it has, and the NAMES of the extra payroll columns
--    stored with it (payroll_entries.extra). Never a value: only key names and a count. Used
--    to check, before publishing, that a template's lines name columns the company has.
--
--    All three are SECURITY DEFINER because the table has no write policy or grant and the
--    column names are read across a run's entries; each applies the rules itself: signed in,
--    admin of THAT company (checked in company_members), the template belongs to that company.
--    search_path = '' and fully qualified names, so nothing can be shadowed.
--
-- 5. public.delete_company (newest in migration 0014) is replaced: it now also deletes the new
--    table's row, before the template versions it points at, and returns its count as
--    "template_in_use". Nothing else about it changes. If you ever run an older delete_company
--    file again after this one, run this file again too.
--
-- Errors the dashboard recognises (message prefix), as in 0010:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_NOT_FOUND, PH_INVALID_INPUT, PH_TOO_LARGE, PH_STALE,
--   PH_LIMIT
-- =====================================================================

-- ---------- table ----------
create table if not exists public.payslip_template_in_use (
  company_id   uuid primary key references public.companies(id) on delete cascade,
  template_id  uuid not null,
  version      integer not null check (version >= 1),
  -- Becomes empty if that user account is ever removed; the row itself stays.
  set_by       uuid references auth.users(id) on delete set null,
  set_at       timestamptz not null default now(),
  -- The template is one of THIS company's, and the version is one of its published versions.
  foreign key (template_id, company_id)
    references public.payslip_templates (id, company_id) on delete cascade,
  foreign key (template_id, version)
    references public.payslip_template_versions (template_id, version) on delete cascade
);

-- ---------- row level security: members read; no write policy at all ----------
alter table public.payslip_template_in_use enable row level security;

drop policy if exists "payslip_template_in_use_select" on public.payslip_template_in_use;
create policy "payslip_template_in_use_select" on public.payslip_template_in_use
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.payslip_template_in_use from public, anon, authenticated;
grant select on table public.payslip_template_in_use to authenticated;

-- ---------- set (or clear) the version used for the payslips ----------
create or replace function public.set_payslip_template_in_use(
  p_company_id  uuid,
  p_template_id uuid,
  p_version     integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_row  public.payslip_template_in_use%rowtype;
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

  -- Both or neither: a template without a version (or the reverse) means nothing.
  if (p_template_id is null) <> (p_version is null) then
    raise exception 'PH_INVALID_INPUT: the template and its version go together'
      using errcode = '22023';
  end if;

  -- One change at a time per company, and never while the company is being deleted.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_template_id is null then
    -- Cleared: the payslip app goes back to its own rule (one published template, or ask).
    delete from public.payslip_template_in_use u where u.company_id = p_company_id;
    return jsonb_build_object('template_id', null, 'version', null);
  end if;

  -- A published version of one of THIS company's templates.
  if not exists (
    select 1
    from public.payslip_template_versions v
    where v.template_id = p_template_id
      and v.company_id = p_company_id
      and v.version = p_version
  ) then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.payslip_template_in_use as u (company_id, template_id, version, set_by, set_at)
  values (p_company_id, p_template_id, p_version, v_user, now())
  on conflict (company_id) do update
    set template_id = excluded.template_id,
        version     = excluded.version,
        set_by      = excluded.set_by,
        set_at      = excluded.set_at
  returning * into v_row;

  return jsonb_build_object(
    'template_id', v_row.template_id,
    'version',     v_row.version,
    'set_at',      v_row.set_at
  );
end;
$$;

revoke all on function public.set_payslip_template_in_use(uuid, uuid, integer) from public, anon;
grant execute on function public.set_payslip_template_in_use(uuid, uuid, integer) to authenticated;

-- ---------- publish a template body to one company, all or nothing ----------
create or replace function public.publish_payslip_template_copy(
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
  v_user      uuid := (select auth.uid());
  v_name      text := btrim(coalesce(p_name, ''));
  v_template  public.payslip_templates%rowtype;
  v_created   boolean := false;
  v_published boolean := false;
  v_latest    integer;
  v_version   public.payslip_template_versions%rowtype;
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

  -- ---------- the company's template with that name, whatever the capitals ----------
  select * into v_template
  from public.payslip_templates t
  where t.company_id = p_company_id and lower(t.name) = lower(v_name)
  for update;

  if not found then
    -- The caller checked a template that is no longer there under that name: refuse.
    if p_expected_revision <> 0 then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    if (select count(*) from public.payslip_templates t where t.company_id = p_company_id) >= 50 then
      raise exception 'PH_LIMIT' using errcode = '54000';
    end if;

    insert into public.payslip_templates (
      company_id, name, draft_body, draft_revision, created_by, created_at, updated_by, updated_at
    )
    values (p_company_id, v_name, p_body, 1, v_user, now(), v_user, now())
    returning * into v_template;
    v_created := true;
  else
    -- Saved in that company since the caller checked it (or, for 0, made since): refuse,
    -- never overwrite what someone did there.
    if v_template.draft_revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    -- Its name stays as that company wrote it; only the draft becomes the body.
    if v_template.draft_body is distinct from p_body then
      update public.payslip_templates t
         set draft_body     = p_body,
             draft_revision = t.draft_revision + 1,
             updated_by     = v_user,
             updated_at     = now()
       where t.id = v_template.id
      returning * into v_template;
    end if;
  end if;

  -- ---------- publish, unless the latest version already is exactly this ----------
  select coalesce(max(v.version), 0) into v_latest
  from public.payslip_template_versions v
  where v.template_id = v_template.id;

  select * into v_version
  from public.payslip_template_versions v
  where v.template_id = v_template.id
    and v.version = v_latest
    and v.name = v_template.name
    and v.body = v_template.draft_body;

  if not found then
    insert into public.payslip_template_versions (
      template_id, company_id, version, name, body, published_by, published_at
    )
    values (
      v_template.id, v_template.company_id, v_latest + 1,
      v_template.name, v_template.draft_body, v_user, now()
    )
    returning * into v_version;
    v_published := true;
  end if;

  -- ---------- and it is the one used for the company's payslips ----------
  insert into public.payslip_template_in_use as u (company_id, template_id, version, set_by, set_at)
  values (p_company_id, v_version.template_id, v_version.version, v_user, now())
  on conflict (company_id) do update
    set template_id = excluded.template_id,
        version     = excluded.version,
        set_by      = excluded.set_by,
        set_at      = excluded.set_at;

  return jsonb_build_object(
    'template_id',    v_template.id,
    'name',           v_template.name,
    'version',        v_version.version,
    'draft_revision', v_template.draft_revision,
    'created',        v_created,
    'published',      v_published,
    'published_at',   v_version.published_at
  );
end;
$$;

revoke all on function public.publish_payslip_template_copy(uuid, text, jsonb, integer)
  from public, anon;
grant execute on function public.publish_payslip_template_copy(uuid, text, jsonb, integer)
  to authenticated;

-- ---------- the column names of a company's newest saved run: names only, never a value ----------
create or replace function public.payroll_run_columns(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user      uuid := (select auth.uid());
  v_run       uuid;
  v_period    date;
  v_employees integer;
  v_keys      jsonb;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company, in the database: a member who is not an admin learns nothing here.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- The newest saved run, as "Get from dashboard" picks it: the latest month not deleted.
  select r.id, r.period into v_run, v_period
  from public.payroll_runs r
  where r.company_id = p_company_id and r.deleted_at is null
  order by r.period desc
  limit 1;

  if v_run is null then
    return jsonb_build_object('period', null, 'employees', 0, 'keys', '[]'::jsonb);
  end if;

  select count(*) into v_employees
  from public.payroll_entries e
  where e.run_id = v_run;

  -- jsonb_object_keys gives the keys of each entry's extra, never what is stored under them.
  select coalesce(jsonb_agg(k.key order by k.key), '[]'::jsonb) into v_keys
  from (
    select distinct jsonb_object_keys(e.extra) as key
    from public.payroll_entries e
    where e.run_id = v_run and jsonb_typeof(e.extra) = 'object'
  ) k;

  return jsonb_build_object('period', v_period, 'employees', v_employees, 'keys', v_keys);
end;
$$;

revoke all on function public.payroll_run_columns(uuid) from public, anon;
grant execute on function public.payroll_run_columns(uuid) to authenticated;

-- ---------- delete_company: as in 0014, plus the template used for the payslips ----------
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
    'members',                       v_members
  );
end;
$$;

-- Unchanged, and repeated so this file is enough on its own.
revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;

-- Ask the Data API to pick up the new table and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select c.relrowsecurity from pg_class c
   where c.oid = 'public.payslip_template_in_use'::regclass)
    as row_security_on,
  (select count(*) = 1 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies
   where schemaname = 'public' and tablename = 'payslip_template_in_use')
    as only_a_read_policy,
  has_table_privilege('authenticated', 'public.payslip_template_in_use', 'select')
    as signed_in_can_read,
  not has_table_privilege('authenticated', 'public.payslip_template_in_use',
        'insert, update, delete, truncate, references, trigger')
    as signed_in_cannot_write_directly,
  not has_table_privilege('anon', 'public.payslip_template_in_use',
        'select, insert, update, delete, truncate, references, trigger')
    as anon_has_nothing,
  (select count(*) = 3 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.set_payslip_template_in_use(uuid, uuid, integer)'::regprocedure,
     'public.publish_payslip_template_copy(uuid, text, jsonb, integer)'::regprocedure,
     'public.payroll_run_columns(uuid)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (has_function_privilege('authenticated',
        'public.set_payslip_template_in_use(uuid, uuid, integer)', 'execute')
    and has_function_privilege('authenticated',
        'public.publish_payslip_template_copy(uuid, text, jsonb, integer)', 'execute')
    and has_function_privilege('authenticated', 'public.payroll_run_columns(uuid)', 'execute'))
    as signed_in_can_call_them,
  (not has_function_privilege('anon',
        'public.set_payslip_template_in_use(uuid, uuid, integer)', 'execute')
    and not has_function_privilege('anon',
        'public.publish_payslip_template_copy(uuid, text, jsonb, integer)', 'execute')
    and not has_function_privilege('anon', 'public.payroll_run_columns(uuid)', 'execute'))
    as anon_cannot_call_them,
  (select count(*) = 3 from pg_proc
   where proname in ('set_payslip_template_in_use', 'publish_payslip_template_copy',
                     'payroll_run_columns'))
    as each_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.payslip_template_in_use%'
          and p.prosrc like '%public.payroll_month_history%'
          and p.prosrc like '%public.issued_payslips%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
