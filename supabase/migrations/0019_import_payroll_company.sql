-- =====================================================================
-- Several companies from one Excel file: import ONE company, all of it or nothing
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0018. Safe to re-run.
-- Undo (only if asked): supabase/undo/0019_import_payroll_company_undo.sql
--
-- Nothing that exists is changed: no table, column, row, policy, grant or function. This file
-- only ADDS one function.
--
-- public.import_payroll_company: what the payroll app's "Several companies…" > Import saves for
-- one company of the file, in ONE transaction, so a company is imported fully or not at all:
--
--   1. The company. Either one that exists, of which the caller must be an admin, or a new one,
--      made exactly as public.create_company (migration 0003) makes it: by an admin of at least
--      one company, with a BRN no company has, the caller becoming its admin.
--   2. Its column setup, only when it has none yet (a new company, or one that exists without
--      a setup): attached, with the company's own columns from the file, either to an existing
--      shared setup or to a new one made from the file, through public.save_payroll_shared_setup
--      and public.attach_payroll_company (migrations 0013 and 0016) with all their rules. A
--      company that has a setup keeps it; the caller states the revisions it checked the file
--      against, and if someone saved the setup since, it is refused as PH_STALE.
--   3. Its months, 1 to 24, each through public.save_payroll_month (migration 0014) with all its
--      rules and checks, worked out with the setup as it is now. A month that is not saved yet is
--      added. One that is saved is replaced only when the caller asked for it, as a NEW revision
--      whose previous content is kept (History and Restore undo it), and NEVER when the
--      company's saved run of that month ("Send to dashboard") is approved: then the whole
--      company is refused as PH_MONTH_APPROVED and nothing of it is stored.
--
--   If anything fails, nothing of that company is stored: not the company, not its setup, not
--   any month. Other companies of the file are separate calls and are not affected.
--
--   SECURITY DEFINER because the functions it calls are; it applies the rules first itself
--   (signed in; admin of that company, or of at least one company for a new one), and each
--   function it calls applies its own again. search_path = '' and fully qualified names.
--
-- Errors the dashboard recognises (message prefix), as in 0003, 0013 and 0014:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_NOT_FOUND, PH_INVALID_INPUT, PH_TOO_LARGE, PH_STALE,
--   PH_DUPLICATE_BRN, and new: PH_MONTH_APPROVED (the month named after the colon, YYYY-MM)
-- =====================================================================

create or replace function public.import_payroll_company(
  -- An existing company; or null, with p_new_company.
  p_company_id  uuid,
  -- A new company: { "name", "brn", "address" }; or null.
  p_new_company jsonb,
  -- Only for a company with no column setup yet:
  --   { "shared_setup_id", "create": true|false, "name" (when create), "shared_body" (when
  --     create), "company_body" }; otherwise null.
  p_setup       jsonb,
  -- Only for a company that has a column setup: { "shared_revision", "company_revision" }, the
  -- revisions the caller checked the file against; otherwise null.
  p_expected    jsonb,
  -- [{ "period": "YYYY-MM-01", "employees": [...], "expected_revision": n, "replace": bool }]
  p_months      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user           uuid := (select auth.uid());
  v_company        public.companies%rowtype;
  v_company_id     uuid;
  v_created        boolean := false;
  v_attached       boolean := false;
  v_shared_created boolean := false;
  v_own            public.payroll_company_setups%rowtype;
  v_setup_id       uuid;
  v_shared_rev     integer;
  v_month          jsonb;
  v_period         date;
  v_periods        date[] := '{}';
  v_exists         boolean;
  v_saved          jsonb;
  v_months         jsonb := '[]'::jsonb;
  v_uuid           text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  -- ---------- who is calling: before any input is looked at ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if p_company_id is not null then
    -- Admin of THIS company. A company that does not exist gives the same answer.
    if not exists (
      select 1 from public.company_members m
      where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
    ) then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.company_members m where m.user_id = v_user and m.role = 'admin'
  ) then
    -- A new company, as create_company: only an admin of at least one company.
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks (the dashboard validates first; this is the backstop) ----------
  -- Exactly one of the two: no company id with a new company, or a company id without one.
  if (p_company_id is null) <> (jsonb_typeof(p_new_company) is not distinct from 'object') then
    raise exception 'PH_INVALID_INPUT: give either the company or the new company'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_months) is distinct from 'array'
     or jsonb_array_length(p_months) not between 1 and 24 then
    raise exception 'PH_INVALID_INPUT: the months must be a list of 1 to 24' using errcode = '22023';
  end if;

  for v_month in select value from jsonb_array_elements(p_months) loop
    if jsonb_typeof(v_month) is distinct from 'object'
       or jsonb_typeof(v_month -> 'period') is distinct from 'string'
       or (v_month ->> 'period') !~ '^\d{4}-(0[1-9]|1[0-2])-01$'
       or jsonb_typeof(v_month -> 'employees') is distinct from 'array'
       or jsonb_typeof(v_month -> 'expected_revision') is distinct from 'number'
       or jsonb_typeof(v_month -> 'replace') is distinct from 'boolean' then
      raise exception 'PH_INVALID_INPUT: a month is missing or malformed' using errcode = '22023';
    end if;
    v_period := (v_month ->> 'period')::date;
    if v_period = any (v_periods) then
      raise exception 'PH_INVALID_INPUT: a month is named twice' using errcode = '22023';
    end if;
    v_periods := v_periods || v_period;
  end loop;

  if p_setup is not null and jsonb_typeof(p_setup) <> 'null' and (
       jsonb_typeof(p_setup) <> 'object'
       or coalesce(p_setup ->> 'shared_setup_id', '') !~ v_uuid
       or jsonb_typeof(p_setup -> 'create') is distinct from 'boolean'
       or jsonb_typeof(p_setup -> 'company_body') is distinct from 'object'
       or ((p_setup ->> 'create')::boolean
           and (jsonb_typeof(p_setup -> 'shared_body') is distinct from 'object'
                or jsonb_typeof(p_setup -> 'name') is distinct from 'string'))) then
    raise exception 'PH_INVALID_INPUT: the column setup is missing or malformed' using errcode = '22023';
  end if;

  -- ---------- 1. the company ----------
  if p_company_id is null then
    v_company := public.create_company(
      p_new_company ->> 'name', p_new_company ->> 'address', p_new_company ->> 'brn', null
    );
    v_company_id := v_company.id;
    v_created := true;
  else
    select * into v_company from public.companies c where c.id = p_company_id;
    if not found then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;
    v_company_id := p_company_id;
  end if;

  -- ---------- 2. its column setup ----------
  select * into v_own from public.payroll_company_setups cs where cs.company_id = v_company_id;
  if not found then
    if p_setup is null or jsonb_typeof(p_setup) = 'null' then
      raise exception 'PH_NOT_FOUND: the company has no payroll column setup' using errcode = 'P0002';
    end if;
    v_setup_id := (p_setup ->> 'shared_setup_id')::uuid;
    if (p_setup ->> 'create')::boolean then
      perform public.save_payroll_shared_setup(
        v_setup_id, p_setup ->> 'name', p_setup -> 'shared_body', 0, '[]'::jsonb
      );
      v_shared_created := true;
    end if;
    perform public.attach_payroll_company(v_company_id, v_setup_id, p_setup -> 'company_body');
    v_attached := true;
    select * into v_own from public.payroll_company_setups cs where cs.company_id = v_company_id;
  else
    -- It has a setup: it is kept, and must be the one the caller checked the file against.
    if p_setup is not null and jsonb_typeof(p_setup) <> 'null' then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_expected) is distinct from 'object'
       or jsonb_typeof(p_expected -> 'shared_revision') is distinct from 'number'
       or jsonb_typeof(p_expected -> 'company_revision') is distinct from 'number' then
      raise exception 'PH_INVALID_INPUT: the column setup revisions checked are missing'
        using errcode = '22023';
    end if;
  end if;

  -- The setup as it is now: every month is saved with it. Locked, so it cannot change meanwhile.
  select s.revision into v_shared_rev
  from public.payroll_shared_setups s where s.id = v_own.shared_setup_id for update;
  if not v_attached and (
       (p_expected ->> 'shared_revision')::integer <> v_shared_rev
       or (p_expected ->> 'company_revision')::integer <> v_own.revision) then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  -- ---------- 3. its months ----------
  for v_month in select value from jsonb_array_elements(p_months) loop
    v_period := (v_month ->> 'period')::date;
    v_exists := exists (
      select 1 from public.payroll_months pm
      where pm.company_id = v_company_id and pm.period = v_period
    );
    if v_exists then
      -- Saved already: replaced only when asked, and never when its run is approved.
      if not (v_month ->> 'replace')::boolean then
        raise exception 'PH_STALE' using errcode = 'P0001';
      end if;
      if exists (
        select 1 from public.payroll_runs r
        where r.company_id = v_company_id and r.period = v_period
          and r.status = 'approved' and r.deleted_at is null
      ) then
        raise exception 'PH_MONTH_APPROVED: %', to_char(v_period, 'YYYY-MM') using errcode = 'P0001';
      end if;
    end if;
    v_saved := public.save_payroll_month(
      v_company_id,
      v_period,
      v_month -> 'employees',
      (v_month ->> 'expected_revision')::integer,
      v_shared_rev,
      v_own.revision,
      v_exists
    );
    v_months := v_months || jsonb_build_object(
      'period',         v_period,
      'revision',       v_saved -> 'revision',
      'employee_count', v_saved -> 'employee_count',
      'replaced',       v_exists
    );
  end loop;

  -- What was stored, without the employees.
  return jsonb_build_object(
    'company_id',       v_company_id,
    'brn',              v_company.brn,
    'name',             v_company.name,
    'created',          v_created,
    'shared_setup_id',  v_own.shared_setup_id,
    'shared_created',   v_shared_created,
    'attached',         v_attached,
    'shared_revision',  v_shared_rev,
    'company_revision', v_own.revision,
    'months',           v_months
  );
end;
$$;

revoke all on function public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon;
grant execute on function public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)
  to authenticated;

-- Ask the Data API to pick up the new function straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select count(*) = 1 from pg_proc where proname = 'import_payroll_company')
    as exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)'::regprocedure)
    as definer_with_empty_search_path,
  (has_function_privilege('authenticated',
     'public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)', 'execute')
   and not has_function_privilege('anon',
     'public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'))
    as signed_in_only_can_call,
  (select p.prosrc like '%public.save_payroll_month(%'
          and p.prosrc like '%public.create_company(%'
          and p.prosrc like '%public.attach_payroll_company(%'
          and p.prosrc like '%PH_MONTH_APPROVED%'
   from pg_proc p
   where p.oid = 'public.import_payroll_company(uuid, jsonb, jsonb, jsonb, jsonb)'::regprocedure)
    as saves_through_the_existing_functions,
  (select count(*) = 1 from pg_proc where proname = 'save_payroll_month')
    and (select count(*) = 1 from pg_proc where proname = 'create_company')
    as existing_functions_unchanged_in_number;
