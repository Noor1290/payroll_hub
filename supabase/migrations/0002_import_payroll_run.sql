-- =====================================================================
-- Atomic payroll import
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001_initial_schema.sql. Safe to re-run (create or replace).
--
-- Why a function: the browser has no transactions. Saving an import touches three tables
-- (employees, payroll_runs, payroll_entries); a function body runs as ONE transaction, so an
-- import either fully succeeds or leaves the database exactly as it was.
--
-- Security:
--   * SECURITY INVOKER: runs as the calling user, so every RLS policy from 0001 still applies.
--   * Explicit admin check up front, for a clear error instead of a row-level failure.
--   * search_path = '' and fully qualified names, so nothing can be shadowed.
--   * Only logged-in users may call it; nothing is granted to anon or public.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_ADMIN       caller is not an admin of the company
--   PH_RUN_EXISTS      a run already exists for that company + period and p_replace is false
--   PH_RUN_APPROVED    the existing run is approved; set it back to draft before replacing
--   PH_INVALID_INPUT   the rows are malformed (the dashboard validates first; this is a backstop)
-- =====================================================================

create or replace function public.import_payroll_run(
  p_company_id uuid,
  p_period     date,
  p_rows       jsonb,
  p_replace    boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run               public.payroll_runs%rowtype;
  v_run_id            uuid;
  v_outcome           text;
  v_row_count         integer;
  v_distinct_ids      integer;
  v_existing_employees integer;
  v_entries           integer;
  v_removed           integer;
begin
  -- ---------- who is calling ----------
  if (select auth.uid()) is null or not public.is_company_admin(p_company_id) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks (backstop; the dashboard validates each row before calling) ----------
  if p_period is null or p_period <> date_trunc('month', p_period)::date then
    raise exception 'PH_INVALID_INPUT: period must be the first day of a month' using errcode = '22023';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'PH_INVALID_INPUT: rows must be a non-empty array' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) as el where jsonb_typeof(el) <> 'object'
  ) then
    raise exception 'PH_INVALID_INPUT: every row must be an object' using errcode = '22023';
  end if;

  select count(*), count(distinct btrim(r.national_id))
    into v_row_count, v_distinct_ids
  from jsonb_to_recordset(p_rows) as r(national_id text);

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(national_id text, surname text)
    where coalesce(btrim(r.national_id), '') = '' or coalesce(btrim(r.surname), '') = ''
  ) then
    raise exception 'PH_INVALID_INPUT: every row needs a national_id and a surname' using errcode = '22023';
  end if;

  if v_row_count <> v_distinct_ids then
    raise exception 'PH_INVALID_INPUT: the same national_id appears more than once' using errcode = '22023';
  end if;

  -- Money columns are numeric(12,2). Refuse anything more precise rather than let it be rounded
  -- silently: payroll figures must be stored exactly as exported.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as el,
         jsonb_each(el - 'extra') as kv
    where jsonb_typeof(kv.value) = 'number'
      and (kv.value #>> '{}')::numeric <> round((kv.value #>> '{}')::numeric, 2)
  ) then
    raise exception 'PH_INVALID_INPUT: a number has more than 2 decimal places' using errcode = '22023';
  end if;

  -- ---------- the run: create, replace in place, or revive a soft-deleted one ----------
  select * into v_run
  from public.payroll_runs
  where company_id = p_company_id and period = p_period
  for update;

  if found then
    if not p_replace then
      raise exception 'PH_RUN_EXISTS' using errcode = 'P0001';
    end if;
    if v_run.deleted_at is null and v_run.status = 'approved' then
      raise exception 'PH_RUN_APPROVED' using errcode = 'P0001';
    end if;

    update public.payroll_runs
       set deleted_at = null, status = 'draft'
     where id = v_run.id;

    v_run_id  := v_run.id;
    v_outcome := case when v_run.deleted_at is null then 'replaced' else 'revived' end;
  else
    insert into public.payroll_runs (company_id, period, status)
    values (p_company_id, p_period, 'draft')
    returning id into v_run_id;

    v_outcome := 'created';
  end if;

  -- ---------- employees: add new ones, refresh details, restore soft-deleted ones ----------
  select count(*) into v_existing_employees
  from public.employees e
  where e.company_id = p_company_id
    and e.national_id in (
      select btrim(r.national_id) from jsonb_to_recordset(p_rows) as r(national_id text)
    );

  insert into public.employees (company_id, national_id, surname, other_names, employment_type)
  select p_company_id,
         btrim(r.national_id),
         btrim(r.surname),
         nullif(btrim(r.other_names), ''),
         nullif(btrim(r.employment_type), '')
  from jsonb_to_recordset(p_rows)
       as r(national_id text, surname text, other_names text, employment_type text)
  on conflict (company_id, national_id) do update
    set surname         = excluded.surname,
        other_names     = excluded.other_names,
        employment_type = excluded.employment_type,
        deleted_at      = null;

  -- ---------- entries: one per employee in the file, values exactly as given ----------
  insert into public.payroll_entries (
    run_id, employee_id,
    basic_salary, govt_increment, new_basic_salary, allowances, emoluments, travelling,
    gross_pay, age_60_plus, csg, nsf, paye, total_deductions, net_pay, levy, prgf,
    total_mra_contributions, edf, edf_monthly, total, extra
  )
  select v_run_id, e.id,
         r.basic_salary, r.govt_increment, r.new_basic_salary, r.allowances, r.emoluments, r.travelling,
         r.gross_pay, r.age_60_plus, r.csg, r.nsf, r.paye, r.total_deductions, r.net_pay, r.levy, r.prgf,
         r.total_mra_contributions, r.edf, r.edf_monthly, r.total, coalesce(r.extra, '{}'::jsonb)
  from jsonb_to_recordset(p_rows) as r(
         national_id text,
         basic_salary numeric, govt_increment numeric, new_basic_salary numeric, allowances numeric,
         emoluments numeric, travelling numeric, gross_pay numeric, age_60_plus boolean,
         csg numeric, nsf numeric, paye numeric, total_deductions numeric, net_pay numeric,
         levy numeric, prgf numeric, total_mra_contributions numeric, edf numeric,
         edf_monthly numeric, total numeric, extra jsonb
       )
  join public.employees e
    on e.company_id = p_company_id and e.national_id = btrim(r.national_id)
  on conflict (run_id, employee_id) do update
    set basic_salary            = excluded.basic_salary,
        govt_increment          = excluded.govt_increment,
        new_basic_salary        = excluded.new_basic_salary,
        allowances              = excluded.allowances,
        emoluments              = excluded.emoluments,
        travelling              = excluded.travelling,
        gross_pay               = excluded.gross_pay,
        age_60_plus             = excluded.age_60_plus,
        csg                     = excluded.csg,
        nsf                     = excluded.nsf,
        paye                    = excluded.paye,
        total_deductions        = excluded.total_deductions,
        net_pay                 = excluded.net_pay,
        levy                    = excluded.levy,
        prgf                    = excluded.prgf,
        total_mra_contributions = excluded.total_mra_contributions,
        edf                     = excluded.edf,
        edf_monthly             = excluded.edf_monthly,
        total                   = excluded.total,
        extra                   = excluded.extra;

  get diagnostics v_entries = row_count;

  -- ---------- replace: drop entries for employees who are not in the new file ----------
  delete from public.payroll_entries pe
  where pe.run_id = v_run_id
    and pe.employee_id not in (
      select e.id
      from public.employees e
      where e.company_id = p_company_id
        and e.national_id in (
          select btrim(r.national_id) from jsonb_to_recordset(p_rows) as r(national_id text)
        )
    );

  get diagnostics v_removed = row_count;

  return jsonb_build_object(
    'run_id',             v_run_id,
    'outcome',            v_outcome,              -- 'created' | 'replaced' | 'revived'
    'entries',            v_entries,
    'entries_removed',    v_removed,
    'employees_new',      v_row_count - v_existing_employees,
    'employees_existing', v_existing_employees
  );
end;
$$;

-- Only logged-in users may call it. RLS inside still limits them to companies they administer.
revoke all on function public.import_payroll_run(uuid, date, jsonb, boolean) from public, anon;
grant execute on function public.import_payroll_run(uuid, date, jsonb, boolean) to authenticated;

-- Ask the Data API to pick up the new function straight away.
notify pgrst, 'reload schema';
