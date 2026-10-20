-- =====================================================================
-- Employees: where the date of employment came from
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0016. Safe to re-run.
-- Undo (only if asked): supabase/undo/0017_employee_date_source_undo.sql
--
-- What changes: public.employees gets two optional columns, both empty for every existing row:
--   * date_of_employment_month  the month (its first day) the stored date of employment came
--                               from: the month sent by the payroll app, or, for a date typed in
--                               the Data explorer, the company's newest saved month at that time.
--   * date_of_employment_typed  true when the date was typed in the Data explorer, false when
--                               it came from a month sent by the payroll app, empty when not known.
-- With them the dashboard replaces a stored date only with one sent for the same or a newer
-- month; a date typed in the Data explorer only with one sent for a newer month than the newest
-- saved when it was typed. A date stored before this migration (both columns empty) is treated
-- as typed in the Data explorer.
--
-- No existing row is changed: both columns start empty.
--
-- Who can do what: unchanged, because these are columns of an existing table.
--   * Members of the company read them   (policy "employees_select", migration 0001).
--   * Admins of the company change them  (policy "employees_update", migration 0001).
--   * Everyone else, and anonymous visitors: nothing.
-- No policy and no grant is added or changed here, for anyone.
--
-- An import never touches them: import_payroll_run (migration 0002) names the columns it
-- writes and these are not among them.
--
-- No function is added, so this file contains no SECURITY DEFINER code.
-- delete_company needs no change: no table is added.
-- =====================================================================

alter table public.employees
  add column if not exists date_of_employment_month date
    check (
      date_of_employment_month is null
      or (
        date_of_employment_month = date_trunc('month', date_of_employment_month)::date
        and date_of_employment_month between date '1900-01-01' and date '2100-12-01'
      )
    );

alter table public.employees
  add column if not exists date_of_employment_typed boolean;

notify pgrst, 'reload schema';

-- ---------- Check: one row, every column should read true ----------
select
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees'
      and column_name = 'date_of_employment_month' and data_type = 'date' and is_nullable = 'YES'
  ) as month_column_added,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees'
      and column_name = 'date_of_employment_typed' and data_type = 'boolean' and is_nullable = 'YES'
  ) as typed_column_added,
  not exists (
    select 1 from public.employees
    where date_of_employment_month is not null or date_of_employment_typed is not null
  ) as no_existing_row_changed,
  (select relrowsecurity from pg_class where oid = 'public.employees'::regclass)
    as row_security_still_on,
  (has_table_privilege('authenticated', 'public.employees', 'select')
    and has_table_privilege('authenticated', 'public.employees', 'update'))
    as signed_in_users_unchanged,
  not has_table_privilege('anon', 'public.employees',
    'select, insert, update, delete, truncate, references, trigger')
    as anon_has_nothing;
