-- =====================================================================
-- Employees: date of employment
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0007. Safe to re-run.
--
-- What changes: public.employees gets one optional column, date_of_employment. An admin types
-- it in the dashboard (the payroll app does not export it). It is sent to apps with a saved
-- run's rows as "Date of Employment", and only for employees who have one.
--
-- Who can do what: unchanged, because this is a column of an existing table.
--   * Members of the company read it     (policy "employees_select", migration 0001).
--   * Admins of the company change it    (policy "employees_update", migration 0001).
--   * Everyone else, and anonymous visitors: nothing.
-- No policy and no grant is added or changed here, for anyone.
--
-- An import never touches it: import_payroll_run (migration 0002) names the columns it
-- writes and this is not one of them, so importing a month again keeps every date.
--
-- No function is added, so this file contains no SECURITY DEFINER code.
-- delete_company needs no change: no table is added.
-- =====================================================================

alter table public.employees
  add column if not exists date_of_employment date;

-- A typing slip such as the year 0206 or 20026 is refused. Empty stays allowed.
alter table public.employees
  drop constraint if exists employees_date_of_employment_check;
alter table public.employees
  add constraint employees_date_of_employment_check
  check (
    date_of_employment is null
    or date_of_employment between date '1900-01-01' and date '2100-12-31'
  );

-- Ask the Data API to pick up the new column straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees'
      and column_name = 'date_of_employment' and data_type = 'date' and is_nullable = 'YES'
  ) as column_added,
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.employees'::regclass
      and conname = 'employees_date_of_employment_check'
  ) as range_check_added,
  (select relrowsecurity from pg_class where oid = 'public.employees'::regclass)
    as row_security_still_on,
  (has_table_privilege('authenticated', 'public.employees', 'select')
    and has_table_privilege('authenticated', 'public.employees', 'update'))
    as signed_in_users_unchanged,
  not has_table_privilege('anon', 'public.employees',
    'select, insert, update, delete, truncate, references, trigger')
    as anon_has_nothing;
