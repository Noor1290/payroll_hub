-- =====================================================================
-- Statutory rates: effective-dated, insert-only, shared by the apps
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0008. Safe to re-run.
--
-- 1. public.statutory_rates: the employee-side NSF and CSG settings of a company, from a
--    given month onwards. SHARED: the payslip app reads it first (as a cross-check), the
--    payroll app later, both through the dashboard. The column names are generic on purpose.
--    Rates are percentages (1.5 means 1.5 %); ceilings and thresholds are rupees a month.
--
--    Rows are never changed and never removed. A correction is a NEW row for the same month
--    with the next revision number, so the rows themselves are the change log: who, when,
--    and (the previous revision) what it said before.
--
--    Who can do what:
--      * Members of the company: read every row.
--      * Admins of the company: add a row, ONLY through public.save_statutory_rates below.
--      * Nobody, through the API: change or remove a row. There is no insert, update or
--        delete policy and no such grant, so the revision number, the author and the time
--        cannot be chosen or altered by a caller.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 2. public.save_statutory_rates: adds one revision. SECURITY DEFINER because the table has
--    no insert policy or grant; the function applies the rules itself: signed in, admin of
--    THAT company, values in range and no more precise than the columns store (nothing is
--    rounded silently), and the caller must say which revision they last saw for that month
--    (0 when there is none). If someone else added one since, or the same save arrives
--    twice, it is refused instead of creating a second row. search_path = '' and fully
--    qualified names, so nothing can be shadowed.
--
-- 3. public.delete_company (migration 0007) is replaced: it now also deletes this table's
--    rows by name and returns their count as "rates". Nothing else about it changes. If you
--    ever run an older delete_company file again after this one, run this file again too.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN   no logged-in user
--   PH_NOT_ADMIN       the caller is not an admin of this company (or it does not exist)
--   PH_INVALID_INPUT   a value is missing, out of range or too precise
--   PH_STALE           the revision the caller last saw is not the latest any more
--   PH_NO_CHANGE       the values are the same as the latest revision for that month
--   PH_LIMIT           the company already has 1000 rows here
-- =====================================================================

-- ---------- table ----------
create table if not exists public.statutory_rates (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id) on delete cascade,
  -- Always the first day of a month: the first month these values apply to.
  effective_from          date not null
                          check (extract(day from effective_from) = 1
                                 and effective_from between date '2000-01-01' and date '2100-12-01'),
  revision                integer not null check (revision >= 1),
  nsf_employee_rate       numeric(7,4)  not null check (nsf_employee_rate between 0 and 100),
  nsf_ceiling             numeric(12,2) not null check (nsf_ceiling >= 0),
  nsf_exempt_at_60        boolean       not null,
  csg_employee_rate_low   numeric(7,4)  not null check (csg_employee_rate_low between 0 and 100),
  csg_employee_rate_high  numeric(7,4)  not null check (csg_employee_rate_high between 0 and 100),
  csg_threshold           numeric(12,2) not null check (csg_threshold >= 0),
  -- Where the figures come from, e.g. the Act or Finance Act. Optional.
  source_note             text
                          check (source_note is null
                                 or (source_note = btrim(source_note)
                                     and char_length(source_note) between 1 and 300)),
  -- Becomes empty if that user account is ever removed; the row itself stays.
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  unique (company_id, effective_from, revision)
);

-- ---------- row level security: members read; no write policy at all ----------
alter table public.statutory_rates enable row level security;

drop policy if exists "statutory_rates_select" on public.statutory_rates;
create policy "statutory_rates_select" on public.statutory_rates
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.statutory_rates from public, anon, authenticated;
grant select on table public.statutory_rates to authenticated;

-- ---------- add one revision ----------
create or replace function public.save_statutory_rates(
  p_company_id             uuid,
  p_effective_from         date,
  p_expected_revision      integer,
  p_nsf_employee_rate      numeric,
  p_nsf_ceiling            numeric,
  p_nsf_exempt_at_60       boolean,
  p_csg_employee_rate_low  numeric,
  p_csg_employee_rate_high numeric,
  p_csg_threshold          numeric,
  p_source_note            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_note   text := nullif(btrim(coalesce(p_source_note, '')), '');
  v_latest integer;
  v_row    public.statutory_rates%rowtype;
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
  if p_effective_from is null
     or extract(day from p_effective_from) <> 1
     or p_effective_from < date '2000-01-01' or p_effective_from > date '2100-12-01' then
    raise exception 'PH_INVALID_INPUT: the month is missing or is not the first day of a month'
      using errcode = '22023';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  if p_nsf_exempt_at_60 is null then
    raise exception 'PH_INVALID_INPUT: the Age 60+ setting is missing' using errcode = '22023';
  end if;

  -- A rate is a percentage with at most 4 decimals. Anything more precise is refused rather
  -- than rounded by the column.
  if p_nsf_employee_rate is null or p_nsf_employee_rate < 0 or p_nsf_employee_rate > 100
     or p_nsf_employee_rate <> round(p_nsf_employee_rate, 4)
     or p_csg_employee_rate_low is null or p_csg_employee_rate_low < 0 or p_csg_employee_rate_low > 100
     or p_csg_employee_rate_low <> round(p_csg_employee_rate_low, 4)
     or p_csg_employee_rate_high is null or p_csg_employee_rate_high < 0 or p_csg_employee_rate_high > 100
     or p_csg_employee_rate_high <> round(p_csg_employee_rate_high, 4) then
    raise exception 'PH_INVALID_INPUT: a rate must be between 0 and 100 with at most 4 decimals'
      using errcode = '22023';
  end if;

  -- An amount is in rupees with at most 2 decimals, and must fit the column.
  if p_nsf_ceiling is null or p_nsf_ceiling < 0 or p_nsf_ceiling > 9999999999.99
     or p_nsf_ceiling <> round(p_nsf_ceiling, 2)
     or p_csg_threshold is null or p_csg_threshold < 0 or p_csg_threshold > 9999999999.99
     or p_csg_threshold <> round(p_csg_threshold, 2) then
    raise exception 'PH_INVALID_INPUT: an amount must be 0 or more with at most 2 decimals'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_note, '')) > 300 then
    raise exception 'PH_INVALID_INPUT: the source note is too long' using errcode = '22023';
  end if;

  -- ---------- one save at a time per company ----------
  -- Locks the company row for the rest of the transaction, so two saves cannot both read the
  -- same "latest revision", and a delete of the company cannot run in between.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if (select count(*) from public.statutory_rates r where r.company_id = p_company_id) >= 1000 then
    raise exception 'PH_LIMIT' using errcode = '54000';
  end if;

  select coalesce(max(r.revision), 0) into v_latest
  from public.statutory_rates r
  where r.company_id = p_company_id and r.effective_from = p_effective_from;

  -- The caller must have seen the latest revision for this month. This is also what stops the
  -- same save from being stored twice when its first answer was lost on the way back.
  if v_latest <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  -- A correction that corrects nothing is not stored.
  if exists (
    select 1
    from public.statutory_rates r
    where r.company_id = p_company_id
      and r.effective_from = p_effective_from
      and r.revision = v_latest
      and r.nsf_employee_rate = p_nsf_employee_rate
      and r.nsf_ceiling = p_nsf_ceiling
      and r.nsf_exempt_at_60 = p_nsf_exempt_at_60
      and r.csg_employee_rate_low = p_csg_employee_rate_low
      and r.csg_employee_rate_high = p_csg_employee_rate_high
      and r.csg_threshold = p_csg_threshold
      and r.source_note is not distinct from v_note
  ) then
    raise exception 'PH_NO_CHANGE' using errcode = 'P0001';
  end if;

  -- ---------- add the row: the revision, the author and the time are set here ----------
  begin
    insert into public.statutory_rates (
      company_id, effective_from, revision,
      nsf_employee_rate, nsf_ceiling, nsf_exempt_at_60,
      csg_employee_rate_low, csg_employee_rate_high, csg_threshold,
      source_note, created_by, created_at
    )
    values (
      p_company_id, p_effective_from, v_latest + 1,
      p_nsf_employee_rate, p_nsf_ceiling, p_nsf_exempt_at_60,
      p_csg_employee_rate_low, p_csg_employee_rate_high, p_csg_threshold,
      v_note, v_user, now()
    )
    returning * into v_row;
  exception when unique_violation then
    -- Cannot happen while the lock above is held; kept so a duplicate is never an obscure error.
    raise exception 'PH_STALE' using errcode = 'P0001';
  end;

  -- What was stored, and nothing else.
  return jsonb_build_object(
    'id',             v_row.id,
    'effective_from', v_row.effective_from,
    'revision',       v_row.revision,
    'created_at',     v_row.created_at
  );
end;
$$;

-- Only logged-in users may call it. The function itself then requires an admin of the company.
revoke all on function public.save_statutory_rates(
  uuid, date, integer, numeric, numeric, boolean, numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.save_statutory_rates(
  uuid, date, integer, numeric, numeric, boolean, numeric, numeric, numeric, text
) to authenticated;

-- ---------- delete_company: as in 0007, plus statutory_rates ----------
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
  v_user      uuid := (select auth.uid());
  v_company   public.companies%rowtype;
  v_entries   integer;
  v_runs      integer;
  v_employees integer;
  v_details   integer;
  v_links     integer;
  v_rates     integer;
  v_members   integer;
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
  -- a save of rates, another delete) can change it or what belongs to it meanwhile.
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

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id', p_company_id,
    'entries',    v_entries,
    'runs',       v_runs,
    'employees',  v_employees,
    'details',    v_details,
    'links',      v_links,
    'rates',      v_rates,
    'members',    v_members
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
  (select relrowsecurity from pg_class where oid = 'public.statutory_rates'::regclass)
    as row_security_on,
  (select count(*) = 1 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies where schemaname = 'public' and tablename = 'statutory_rates')
    as only_a_read_policy,
  has_table_privilege('authenticated', 'public.statutory_rates', 'select')
    as signed_in_can_read,
  not has_table_privilege('authenticated', 'public.statutory_rates',
    'insert, update, delete, truncate, references, trigger')
    as signed_in_cannot_write_directly,
  not has_table_privilege('anon', 'public.statutory_rates',
    'select, insert, update, delete, truncate, references, trigger')
    as anon_has_nothing,
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.save_statutory_rates(uuid, date, integer, numeric, numeric, boolean, numeric, numeric, numeric, text)'::regprocedure)
    as save_is_definer_with_empty_search_path,
  has_function_privilege('authenticated',
    'public.save_statutory_rates(uuid, date, integer, numeric, numeric, boolean, numeric, numeric, numeric, text)',
    'execute')
    as signed_in_can_call_save,
  not has_function_privilege('anon',
    'public.save_statutory_rates(uuid, date, integer, numeric, numeric, boolean, numeric, numeric, numeric, text)',
    'execute')
    as anon_cannot_call_save,
  (select count(*) = 1 from pg_proc where proname = 'save_statutory_rates')
    as save_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.statutory_rates%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
