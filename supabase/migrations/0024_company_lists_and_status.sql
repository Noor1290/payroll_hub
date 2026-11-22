-- =====================================================================
-- Company lists and status: which app each company is used in, and what is needed to show,
-- month by month, whether each service is done.
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0023. Safe to re-run.
-- Undo (only if asked): supabase/undo/0024_company_lists_and_status_undo.sql
--
-- Nothing that exists is changed: no existing table, column, row, policy or grant. This file
-- only ADDS three tables, three read policies, three functions and one trigger, and replaces
-- public.delete_company with the same function plus the new tables.
--
-- 1. public.company_app_lists: one row per company and list it is switched ON in. The lists
--    are 'payroll' (Payroll System), 'payslips' (Payslip Automation), 'csg' and 'prgf' (MRA
--    Returns). No row = off, so every company, new or old, starts switched off in every list.
--    A convenience only: hiding a company from an app's list changes nobody's access.
--      * Members of the company: read.
--      * Admins of the company: switch it on or off, ONLY through set_company_app_lists,
--        which saves every change it is given or none (admin of EVERY company named).
--      * Everyone else, anonymous visitors, and direct writes through the API: nothing.
--
-- 2. public.mra_file_records: one row each time the MRA Returns app downloads a CSG or a PRGF
--    file for a company and month: who, when, which file, how many employees, the file's
--    totals (numbers only: sums, never a name or an ID), whether it was made with warnings, and
--    the payroll month revision and run status at that moment, looked up HERE (never sent by
--    the app), so the dashboard can tell when the month was saved again afterwards.
--      * Members of the company: read.
--      * Admins of the company: add a row, ONLY through record_mra_file.
--
-- 3. public.payroll_run_approvals: one row each time a saved run's status changes (approved,
--    or set back to draft): who and when. Filled by a trigger on payroll_runs; nobody writes it
--    directly. Runs approved before this file was run have no row: their date is not known.
--      * Members of the company: read.
--
-- 4. public.delete_company (newest in migration 0021) is replaced: it now also deletes the
--    company's rows in the three tables above and returns their counts as "app_lists",
--    "mra_file_records" and "run_approvals". Nothing else about it changes. If you ever run
--    an older delete_company file again after this one, run this file again too.
--
-- All functions are SECURITY DEFINER (the tables have no write grant), check who is calling
-- first, and use search_path = '' and fully qualified names, so nothing can be shadowed.
--
-- Limits: a list save holds at most 2000 changes (a company in a list, on or off); a file record's totals are a JSON object of
-- numbers, at most 2 KB; at most 500 records per company, month and file.
--
-- Errors the dashboard recognises (message prefix), as in 0010 to 0023:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_INVALID_INPUT, PH_TOO_LARGE, PH_LIMIT
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.company_app_lists (
  company_id  uuid not null references public.companies(id) on delete cascade,
  list        text not null check (list in ('payroll', 'payslips', 'csg', 'prgf')),
  -- Becomes empty if that user account is ever removed; the row itself stays.
  added_by    uuid references auth.users(id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (company_id, list)
);

create table if not exists public.mra_file_records (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  -- Always the first day of the month the file is for.
  period          date not null
                  check (extract(day from period) = 1
                         and period between date '2000-01-01' and date '2100-12-01'),
  kind            text not null check (kind in ('csg', 'prgf')),
  employee_count  integer not null check (employee_count between 0 and 5000),
  totals          jsonb not null
                  check (jsonb_typeof(totals) = 'object' and octet_length(totals::text) <= 2048),
  warnings        boolean not null,
  -- Looked up by record_mra_file when the row is made; empty when there was none.
  month_revision  integer,
  run_status      text check (run_status in ('draft', 'approved')),
  made_by         uuid references auth.users(id) on delete set null,
  made_at         timestamptz not null default now()
);

create index if not exists mra_file_records_company_idx
  on public.mra_file_records (company_id, period, kind, made_at desc);

create table if not exists public.payroll_run_approvals (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.payroll_runs(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  period      date not null,
  status      text not null check (status in ('draft', 'approved')),
  changed_by  uuid references auth.users(id) on delete set null,
  changed_at  timestamptz not null default now()
);

create index if not exists payroll_run_approvals_company_idx
  on public.payroll_run_approvals (company_id, period, changed_at desc);

-- ---------- row level security: read policies only ----------
alter table public.company_app_lists     enable row level security;
alter table public.mra_file_records      enable row level security;
alter table public.payroll_run_approvals enable row level security;

drop policy if exists "company_app_lists_select" on public.company_app_lists;
create policy "company_app_lists_select" on public.company_app_lists
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists "mra_file_records_select" on public.mra_file_records;
create policy "mra_file_records_select" on public.mra_file_records
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists "payroll_run_approvals_select" on public.payroll_run_approvals;
create policy "payroll_run_approvals_select" on public.payroll_run_approvals
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.company_app_lists     from public, anon, authenticated;
revoke all on table public.mra_file_records      from public, anon, authenticated;
revoke all on table public.payroll_run_approvals from public, anon, authenticated;
grant select on table public.company_app_lists     to authenticated;
grant select on table public.mra_file_records      to authenticated;
grant select on table public.payroll_run_approvals to authenticated;

-- ---------- switch companies on or off, in one or more lists, all or nothing ----------
-- p_changes: a JSON array of {"company_id": uuid, "list": text, "on": boolean}, at most 2000,
-- each company and list at most once.
create or replace function public.set_company_app_lists(p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_count    integer;
  v_added    integer;
  v_removed  integer;
begin
  -- ---------- who is calling ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- An admin of at least one company, before any input is looked at.
  if not exists (
    select 1 from public.company_members m where m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks (the dashboard checks first; this is the backstop) ----------
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'PH_INVALID_INPUT: changes must be a list' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_changes);
  if v_count > 2000 then
    raise exception 'PH_TOO_LARGE: at most 2000 changes at once' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) e
    -- CASE, so nothing looks inside an element that is not an object.
    where case when jsonb_typeof(e) <> 'object' then true
               else (select count(*) from jsonb_object_keys(e)) <> 3
                    or coalesce(jsonb_typeof(e -> 'company_id'), '') <> 'string'
                    or (e ->> 'company_id') !~
                       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    or coalesce(jsonb_typeof(e -> 'list'), '') <> 'string'
                    or (e ->> 'list') not in ('payroll', 'payslips', 'csg', 'prgf')
                    or coalesce(jsonb_typeof(e -> 'on'), '') <> 'boolean'
          end
  ) then
    raise exception 'PH_INVALID_INPUT: a change is not valid' using errcode = '22023';
  end if;

  if (select count(*) from (
        select distinct c.company_id, c.list
        from jsonb_to_recordset(p_changes) as c(company_id uuid, list text, "on" boolean)
      ) d) <> v_count then
    raise exception 'PH_INVALID_INPUT: a company and list are named twice' using errcode = '22023';
  end if;

  -- Admin of EVERY company named, or nothing is changed. A company that does not exist gives
  -- the same answer, so the function cannot be used to find out which ids exist.
  if exists (
    select 1 from jsonb_to_recordset(p_changes) as c(company_id uuid, list text, "on" boolean)
    where not exists (
      select 1 from public.company_members m
      where m.company_id = c.company_id and m.user_id = v_user and m.role = 'admin'
    )
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  insert into public.company_app_lists (company_id, list, added_by)
  select c.company_id, c.list, v_user
  from jsonb_to_recordset(p_changes) as c(company_id uuid, list text, "on" boolean)
  where c."on"
  on conflict (company_id, list) do nothing;
  get diagnostics v_added = row_count;

  delete from public.company_app_lists l
  using jsonb_to_recordset(p_changes) as c(company_id uuid, list text, "on" boolean)
  where not c."on" and l.company_id = c.company_id and l.list = c.list;
  get diagnostics v_removed = row_count;

  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$$;

revoke all on function public.set_company_app_lists(jsonb) from public, anon;
grant execute on function public.set_company_app_lists(jsonb) to authenticated;

-- ---------- record that an MRA file was made ----------
create or replace function public.record_mra_file(
  p_company_id     uuid,
  p_period         date,
  p_kind           text,
  p_employee_count integer,
  p_totals         jsonb,
  p_warnings       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := (select auth.uid());
  v_revision  integer;
  v_status    text;
  v_row       public.mra_file_records%rowtype;
begin
  -- ---------- who is calling ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if p_company_id is null or not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks ----------
  if p_period is null or extract(day from p_period) <> 1
     or p_period not between date '2000-01-01' and date '2100-12-01' then
    raise exception 'PH_INVALID_INPUT: the month is not valid' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('csg', 'prgf') then
    raise exception 'PH_INVALID_INPUT: unknown file' using errcode = '22023';
  end if;
  if p_employee_count is null or p_employee_count not between 0 and 5000 then
    raise exception 'PH_INVALID_INPUT: the number of employees is not valid' using errcode = '22023';
  end if;
  if p_warnings is null then
    raise exception 'PH_INVALID_INPUT: warnings is missing' using errcode = '22023';
  end if;
  if p_totals is null or jsonb_typeof(p_totals) <> 'object' then
    raise exception 'PH_INVALID_INPUT: totals must be an object' using errcode = '22023';
  end if;
  if octet_length(p_totals::text) > 2048 then
    raise exception 'PH_TOO_LARGE: totals are limited to 2 KB' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_totals) e where jsonb_typeof(e.value) <> 'number') then
    raise exception 'PH_INVALID_INPUT: every total must be a number' using errcode = '22023';
  end if;
  if (select count(*) from public.mra_file_records r
      where r.company_id = p_company_id and r.period = p_period and r.kind = p_kind) >= 500 then
    raise exception 'PH_LIMIT: too many records for this month' using errcode = '22023';
  end if;

  -- ---------- what the file was made from, looked up here ----------
  select pm.revision into v_revision
  from public.payroll_months pm
  where pm.company_id = p_company_id and pm.period = p_period;

  select r.status into v_status
  from public.payroll_runs r
  where r.company_id = p_company_id and r.period = p_period and r.deleted_at is null;

  insert into public.mra_file_records
    (company_id, period, kind, employee_count, totals, warnings, month_revision, run_status, made_by)
  values
    (p_company_id, p_period, p_kind, p_employee_count, p_totals, p_warnings, v_revision, v_status, v_user)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'made_at', v_row.made_at,
    'month_revision', v_row.month_revision,
    'run_status', v_row.run_status
  );
end;
$$;

revoke all on function public.record_mra_file(uuid, date, text, integer, jsonb, boolean)
  from public, anon;
grant execute on function public.record_mra_file(uuid, date, text, integer, jsonb, boolean)
  to authenticated;

-- ---------- record every change of a run's status ----------
create or replace function public.record_payroll_run_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'approved' then
      return null;
    end if;
  elsif new.status is not distinct from old.status then
    return null;
  end if;
  insert into public.payroll_run_approvals (run_id, company_id, period, status, changed_by)
  values (new.id, new.company_id, new.period, new.status, (select auth.uid()));
  return null;
end;
$$;

revoke all on function public.record_payroll_run_approval() from public, anon, authenticated;

drop trigger if exists payroll_runs_record_approval on public.payroll_runs;
create trigger payroll_runs_record_approval
  after insert or update of status on public.payroll_runs
  for each row execute function public.record_payroll_run_approval();

-- ---------- delete_company: as in 0021, plus the three tables above ----------
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
  v_approvals         integer;
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
  v_mra_files         integer;
  v_app_lists         integer;
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

  -- The record of approvals (0024) before the runs it points at.
  delete from public.payroll_run_approvals a where a.company_id = p_company_id;
  get diagnostics v_approvals = row_count;

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

  -- The record of MRA files and the app lists (0024).
  delete from public.mra_file_records f where f.company_id = p_company_id;
  get diagnostics v_mra_files = row_count;

  delete from public.company_app_lists l where l.company_id = p_company_id;
  get diagnostics v_app_lists = row_count;

  delete from public.company_member_history h where h.company_id = p_company_id;

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id',                    p_company_id,
    'issued_payslips',               v_issued,
    'entries',                       v_entries,
    'runs',                          v_runs,
    'run_approvals',                 v_approvals,
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
    'mra_file_records',              v_mra_files,
    'app_lists',                     v_app_lists,
    'members',                       v_members
  );
end;
$$;

revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;

-- Ask the Data API to pick up the new tables and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification: one row, every column true ----------
select
  (select count(*) = 3 from information_schema.tables
   where table_schema = 'public'
     and table_name in ('company_app_lists', 'mra_file_records', 'payroll_run_approvals'))
    as tables_exist,
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.company_app_lists'::regclass, 'public.mra_file_records'::regclass,
                   'public.payroll_run_approvals'::regclass))
    as row_security_on,
  (select count(*) = 3 from pg_policies
   where schemaname = 'public'
     and policyname in ('company_app_lists_select', 'mra_file_records_select',
                        'payroll_run_approvals_select'))
    as read_policies_exist,
  (not has_table_privilege('authenticated', 'public.company_app_lists', 'insert, update, delete')
   and not has_table_privilege('authenticated', 'public.mra_file_records', 'insert, update, delete')
   and not has_table_privilege('authenticated', 'public.payroll_run_approvals', 'insert, update, delete'))
    as no_direct_writes,
  (not has_table_privilege('anon', 'public.company_app_lists', 'select')
   and not has_table_privilege('anon', 'public.mra_file_records', 'select')
   and not has_table_privilege('anon', 'public.payroll_run_approvals', 'select'))
    as anon_reads_nothing,
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""']) from pg_proc p
   where p.oid in ('public.set_company_app_lists(jsonb)'::regprocedure,
                   'public.record_mra_file(uuid, date, text, integer, jsonb, boolean)'::regprocedure,
                   'public.record_payroll_run_approval()'::regprocedure,
                   'public.delete_company(uuid, text)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (has_function_privilege('authenticated', 'public.set_company_app_lists(jsonb)', 'execute')
   and has_function_privilege('authenticated', 'public.record_mra_file(uuid, date, text, integer, jsonb, boolean)', 'execute')
   and not has_function_privilege('anon', 'public.set_company_app_lists(jsonb)', 'execute')
   and not has_function_privilege('anon', 'public.record_mra_file(uuid, date, text, integer, jsonb, boolean)', 'execute'))
    as signed_in_only,
  (select count(*) = 1 from pg_trigger
   where tgname = 'payroll_runs_record_approval'
     and tgrelid = 'public.payroll_runs'::regclass and not tgisinternal)
    as approval_trigger_exists,
  (select position('company_app_lists' in pg_get_functiondef('public.delete_company(uuid, text)'::regprocedure)) > 0)
    as delete_company_knows_the_new_tables;
