-- =====================================================================
-- Issued payslips: what was issued to each employee for a month, kept as it was
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0010. Safe to re-run.
--
-- 1. public.issued_payslips: one row per employee, per month, per revision. A row is a
--    SNAPSHOT: the template version used, the statutory rates the figures were cross-checked
--    against (empty = not cross-checked), the exact lines shown on the payslip, and the
--    differences that were accepted, with the reason. It holds salaries, so it is ADMIN-ONLY.
--
--    Rows are never changed and never removed. Issuing again is a NEW row for the same
--    employee and month with the next revision number.
--
--    Who can do what:
--      * Admins of the company: read, and issue ONLY through public.issue_payslips below.
--      * Viewers of the company: nothing. Not even a count.
--      * Nobody, through the API: insert, update or delete a row directly. There is no such
--        policy and no such grant, so the revision, the issuer and the time cannot be chosen
--        or altered by a caller.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 2. public.issue_payslips: issues a whole month's selection in ONE transaction: every
--    payslip in the call is stored, or none is. SECURITY DEFINER because the table has no
--    insert policy or grant; the function applies the rules itself: signed in, admin of THAT
--    company, every employee and every template version belongs to that company, and for each
--    employee the caller must say which revision they last saw for that month (0 for none).
--    If someone issued since, or the same save arrives twice, the whole call is refused.
--    search_path = '' and fully qualified names, so nothing can be shadowed.
--
--    A refusal about one payslip says WHICH by its position in the list, counted from 1
--    ("payslip 3"), and nothing else: never a national ID or a name.
--
-- 3. public.issued_payslips_for_month: reads a month, the latest revision of each employee,
--    as one JSON value. SECURITY INVOKER: it runs as the caller, so the read policy decides;
--    anyone who is not an admin of the company gets an empty list.
--
-- 4. public.employees gets a second unique index, (id, company_id). It changes nothing by
--    itself (id is already unique); it lets a payslip point at its employee AND its company
--    together.
--
-- 5. public.delete_company (migration 0010) is replaced: it now also deletes this table's
--    rows by name, first, and returns their count as "issued_payslips". Nothing else about it
--    changes. If you ever run an older delete_company file again after this one, run this
--    file again too.
--
-- Limits: 1000 payslips per call; per payslip, lines of at most 32 KB (1 to 200 of them),
-- accepted differences of at most 8 KB, a rates snapshot of at most 2 KB; 50 revisions per
-- employee per month.
--
-- Errors the dashboard recognises (message prefix; "payslip N" follows where one is at fault):
--   PH_NOT_SIGNED_IN      no logged-in user
--   PH_NOT_ADMIN          the caller is not an admin of this company (or it does not exist)
--   PH_INVALID_INPUT      the month or a payslip is missing or malformed
--   PH_TOO_LARGE          too many payslips in one call, or one is too large
--   PH_UNKNOWN_EMPLOYEE   a payslip is for someone who is not a current employee here
--   PH_UNKNOWN_TEMPLATE   a payslip names a template version this company does not have
--   PH_STALE              for an employee, the revision last seen is not the latest
--   PH_LIMIT              an employee already has 50 revisions for that month
-- =====================================================================

-- ---------- employees: let a row be referenced together with its company ----------
create unique index if not exists employees_id_company_idx
  on public.employees (id, company_id);

-- ---------- table ----------
create table if not exists public.issued_payslips (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  employee_id           uuid not null,
  -- Always the first day of the month the payslip is for.
  period                date not null
                        check (extract(day from period) = 1
                               and period between date '2000-01-01' and date '2100-12-01'),
  revision              integer not null check (revision between 1 and 50),
  -- The published template version the payslip was laid out with.
  template_id           uuid not null,
  template_version      integer not null check (template_version >= 1),
  -- The statutory rates the figures were cross-checked against, copied as they were.
  -- Empty = not cross-checked.
  rates_snapshot        jsonb
                        check (rates_snapshot is null
                               or (jsonb_typeof(rates_snapshot) = 'object'
                                   and octet_length(rates_snapshot::text) <= 2048)),
  -- The exact lines shown on the payslip, in order.
  lines                 jsonb not null
                        check (case when jsonb_typeof(lines) = 'array'
                                    then jsonb_array_length(lines) between 1 and 200
                                         and octet_length(lines::text) <= 32768
                                    else false end),
  -- The differences that were accepted, each with its reason. Accepted by issued_by.
  accepted_differences  jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(accepted_differences) = 'array'
                               and octet_length(accepted_differences::text) <= 8192),
  -- Becomes empty if that user account is ever removed; the row itself stays.
  issued_by             uuid references auth.users(id) on delete set null,
  issued_at             timestamptz not null default now(),
  unique (company_id, employee_id, period, revision),
  -- The employee belongs to the same company. RESTRICT: an employee with an issued payslip
  -- cannot be removed on their own.
  foreign key (employee_id, company_id)
    references public.employees (id, company_id) on delete restrict,
  -- The template belongs to the same company, and that version of it exists.
  foreign key (template_id, company_id)
    references public.payslip_templates (id, company_id) on delete restrict,
  foreign key (template_id, template_version)
    references public.payslip_template_versions (template_id, version) on delete restrict
);

create index if not exists issued_payslips_company_period_idx
  on public.issued_payslips (company_id, period);

-- ---------- row level security: admins read; no write policy at all ----------
alter table public.issued_payslips enable row level security;

drop policy if exists "issued_payslips_select" on public.issued_payslips;
create policy "issued_payslips_select" on public.issued_payslips
  for select to authenticated
  using (public.is_company_admin(company_id));

-- ---------- grants: logged-in users may read (the policy then requires an admin); nothing
-- ---------- else, and nothing for anon ----------
revoke all on table public.issued_payslips from public, anon, authenticated;
grant select on table public.issued_payslips to authenticated;

-- ---------- issue a month's selection: all of it, or none ----------
create or replace function public.issue_payslips(
  p_company_id uuid,
  p_period     date,
  p_payslips   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid := (select auth.uid());
  v_now         timestamptz := now();
  v_el          jsonb;
  v_n           bigint;
  v_national_id text;
  v_seen        text[] := '{}';
  v_expected    numeric;
  v_version     numeric;
  v_template    uuid;
  v_employee    uuid;
  v_latest      integer;
  v_count       integer := 0;
  v_issued      jsonb := '[]'::jsonb;
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
  if p_period is null
     or extract(day from p_period) <> 1
     or p_period < date '2000-01-01' or p_period > date '2100-12-01' then
    raise exception 'PH_INVALID_INPUT: the month is missing or is not the first day of a month'
      using errcode = '22023';
  end if;

  if p_payslips is null or jsonb_typeof(p_payslips) <> 'array' then
    raise exception 'PH_INVALID_INPUT: the payslips must be a list' using errcode = '22023';
  end if;

  if jsonb_array_length(p_payslips) = 0 then
    raise exception 'PH_INVALID_INPUT: there is no payslip to issue' using errcode = '22023';
  end if;

  if jsonb_array_length(p_payslips) > 1000 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  -- ---------- one save at a time per company ----------
  -- Locks the company row for the rest of the transaction, so two calls cannot both read the
  -- same "latest revision", and a delete of the company cannot run in between.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- each payslip, in the order sent ----------
  -- Any refusal undoes the whole call, and names the first payslip at fault by its position
  -- in the list, counted from 1. Never by a national ID or a name.
  for v_el, v_n in
    select t.el, t.n
    from jsonb_array_elements(p_payslips) with ordinality as t(el, n)
    order by t.n
  loop
    -- Every part present and of the right kind, checked before anything is cast.
    -- "rates" may be absent or null: not cross-checked.
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'PH_INVALID_INPUT: payslip %: it must be an object', v_n
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_el -> 'national_id') is distinct from 'string'
       or jsonb_typeof(v_el -> 'expected_revision') is distinct from 'number'
       or jsonb_typeof(v_el -> 'template_id') is distinct from 'string'
       or jsonb_typeof(v_el -> 'template_version') is distinct from 'number'
       or jsonb_typeof(v_el -> 'lines') is distinct from 'array'
       or jsonb_typeof(v_el -> 'accepted_differences') is distinct from 'array'
       or coalesce(jsonb_typeof(v_el -> 'rates'), 'null') not in ('object', 'null') then
      raise exception 'PH_INVALID_INPUT: payslip %: a part is missing or of the wrong kind', v_n
        using errcode = '22023';
    end if;

    v_national_id := btrim(v_el ->> 'national_id');
    v_expected    := (v_el ->> 'expected_revision')::numeric;
    v_version     := (v_el ->> 'template_version')::numeric;

    if v_national_id = '' then
      raise exception 'PH_INVALID_INPUT: payslip %: the national ID is empty', v_n
        using errcode = '22023';
    end if;

    -- One payslip per employee in a call.
    if v_national_id = any (v_seen) then
      raise exception 'PH_INVALID_INPUT: payslip %: the same employee appears earlier in the list', v_n
        using errcode = '22023';
    end if;
    v_seen := v_seen || v_national_id;

    if v_expected <> trunc(v_expected) or v_expected < 0 or v_expected > 50
       or v_version <> trunc(v_version) or v_version < 1 or v_version > 1000000
       or (v_el ->> 'template_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'PH_INVALID_INPUT: payslip %: a revision, a template version or a template id is not valid', v_n
        using errcode = '22023';
    end if;
    v_template := (v_el ->> 'template_id')::uuid;

    if jsonb_array_length(v_el -> 'lines') = 0 then
      raise exception 'PH_INVALID_INPUT: payslip %: it has no lines', v_n
        using errcode = '22023';
    end if;

    if jsonb_array_length(v_el -> 'lines') > 200
       or octet_length((v_el -> 'lines')::text) > 32768
       or octet_length((v_el -> 'accepted_differences')::text) > 8192
       or octet_length(coalesce(v_el -> 'rates', 'null'::jsonb)::text) > 2048 then
      raise exception 'PH_TOO_LARGE: payslip %', v_n using errcode = '54000';
    end if;

    -- A current employee of THIS company.
    select e.id into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.national_id = v_national_id
      and e.deleted_at is null;

    if not found then
      raise exception 'PH_UNKNOWN_EMPLOYEE: payslip %', v_n using errcode = 'P0002';
    end if;

    -- A published version of a template of THIS company.
    if not exists (
      select 1
      from public.payslip_template_versions v
      where v.company_id = p_company_id
        and v.template_id = v_template
        and v.version = v_version
    ) then
      raise exception 'PH_UNKNOWN_TEMPLATE: payslip %', v_n using errcode = 'P0002';
    end if;

    select coalesce(max(i.revision), 0) into v_latest
    from public.issued_payslips i
    where i.company_id = p_company_id
      and i.employee_id = v_employee
      and i.period = p_period;

    -- The caller must have seen the latest revision for this employee and month. This is also
    -- what stops the same save from being stored twice when its first answer was lost.
    if v_latest <> v_expected then
      raise exception 'PH_STALE: payslip %', v_n using errcode = 'P0001';
    end if;

    if v_latest >= 50 then
      raise exception 'PH_LIMIT: payslip %', v_n using errcode = '54000';
    end if;

    -- The revision, the issuer and the time are set here, never by the caller.
    insert into public.issued_payslips (
      company_id, employee_id, period, revision,
      template_id, template_version, rates_snapshot, lines, accepted_differences,
      issued_by, issued_at
    )
    values (
      p_company_id, v_employee, p_period, v_latest + 1,
      v_template, v_version::integer, nullif(v_el -> 'rates', 'null'::jsonb), v_el -> 'lines',
      v_el -> 'accepted_differences',
      v_user, v_now
    );

    v_count  := v_count + 1;
    v_issued := v_issued || jsonb_build_object(
      'national_id', v_national_id,
      'revision',    v_latest + 1
    );
  end loop;

  -- What was stored: which revision each employee is now at. No figures.
  return jsonb_build_object(
    'period',    p_period,
    'issued',    v_count,
    'issued_at', v_now,
    'payslips',  v_issued
  );
end;
$$;

-- Only logged-in users may call it. The function itself then requires an admin of the company.
revoke all on function public.issue_payslips(uuid, date, jsonb) from public, anon;
grant execute on function public.issue_payslips(uuid, date, jsonb) to authenticated;

-- ---------- read a month: the latest revision of each employee ----------
-- SECURITY INVOKER: the read policy above applies, so only an admin of the company gets rows.
create or replace function public.issued_payslips_for_month(
  p_company_id uuid,
  p_period     date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(latest) order by latest.national_id), '[]'::jsonb)
  from (
    select distinct on (i.employee_id)
           e.national_id,
           i.revision,
           i.template_id,
           i.template_version,
           i.rates_snapshot as rates,
           i.lines,
           i.accepted_differences,
           i.issued_by,
           i.issued_at
    from public.issued_payslips i
    join public.employees e on e.id = i.employee_id
    where i.company_id = p_company_id and i.period = p_period
    order by i.employee_id, i.revision desc
  ) as latest;
$$;

revoke all on function public.issued_payslips_for_month(uuid, date) from public, anon;
grant execute on function public.issued_payslips_for_month(uuid, date) to authenticated;

-- ---------- delete_company: as in 0010, plus issued_payslips ----------
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

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id',        p_company_id,
    'issued_payslips',   v_issued,
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

-- Ask the Data API to pick up the new table and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select relrowsecurity from pg_class where oid = 'public.issued_payslips'::regclass)
    as row_security_on,
  (select count(*) = 1
          and bool_and(cmd = 'SELECT' and roles = '{authenticated}'
                       and qual like '%is_company_admin(%')
   from pg_policies where schemaname = 'public' and tablename = 'issued_payslips')
    as only_an_admin_read_policy,
  has_table_privilege('authenticated', 'public.issued_payslips', 'select')
    as signed_in_can_read,
  not has_table_privilege('authenticated', 'public.issued_payslips',
    'insert, update, delete, truncate, references, trigger')
    as signed_in_cannot_write_directly,
  not has_table_privilege('anon', 'public.issued_payslips',
    'select, insert, update, delete, truncate, references, trigger')
    as anon_has_nothing,
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'public.issue_payslips(uuid, date, jsonb)'::regprocedure)
    as issue_is_definer_with_empty_search_path,
  (select not p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.issued_payslips_for_month(uuid, date)'::regprocedure)
    as read_is_invoker_with_empty_search_path,
  (has_function_privilege('authenticated', 'public.issue_payslips(uuid, date, jsonb)', 'execute')
    and has_function_privilege('authenticated',
          'public.issued_payslips_for_month(uuid, date)', 'execute'))
    as signed_in_can_call_them,
  (not has_function_privilege('anon', 'public.issue_payslips(uuid, date, jsonb)', 'execute')
    and not has_function_privilege('anon',
          'public.issued_payslips_for_month(uuid, date)', 'execute'))
    as anon_cannot_call_them,
  (select count(*) = 2 from pg_proc
   where proname in ('issue_payslips', 'issued_payslips_for_month'))
    as each_exists_once,
  (select count(*) = 3 from pg_constraint
   where conrelid = 'public.issued_payslips'::regclass and contype = 'f' and confdeltype = 'r')
    as employee_and_template_are_protected,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.issued_payslips%'
          and p.prosrc like '%public.payslip_template_versions%'
          and p.prosrc like '%public.statutory_rates%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
