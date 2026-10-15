-- =====================================================================
-- Payroll months: each company's employees and the values typed for them, one month at a time
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0013. Safe to re-run.
--
-- It only ADDS things (two tables, two read policies, five functions) and replaces one
-- function, public.delete_company, with the same function plus the new tables. No existing
-- table, column or row is changed. It does not use public.employees, public.payroll_runs or
-- public.payroll_entries: those keep holding the results sent with "Send to dashboard". These
-- tables hold what is typed in the payroll app, which is a different thing.
--
-- 1. public.payroll_months: one row per company per month. The whole month in one JSON list,
--    exactly as the payroll app keeps it: [{ "id": "...", "values": { "<column key>": ... } }].
--    It holds national IDs and salaries, so it is ADMIN-ONLY: viewers of the company see
--    nothing, not even a count. Each row also records which column setup it was saved with:
--    the shared setup, its revision and the company's own setup revision (migration 0013).
--    Those revisions must exist; they are checked, not trusted.
--
-- 2. public.payroll_month_history: a record of EVERY save of every month: its revision, who
--    saved it and when, the setup revisions it was saved with and how many employees it had.
--    The month's content is kept with a record when it would otherwise be lost for good:
--      * the last revision of each day (UTC; 04:00 in Mauritius): copied when the first
--        save of a later day comes in, so any day's work can be looked at again;
--      * a revision saved by someone else, when another person saves over it;
--      * a revision the caller asked to keep before replacing it ("Save mine over it", or an
--        import that replaces a month).
--    Typing produces a save a moment after each pause, so keeping the content of every one of
--    them would grow by megabytes a day for one company. The records themselves are all kept.
--
--    Who can do what, for both tables:
--      * Admins of the company: read, and save ONLY through the functions below.
--      * Viewers of the company: nothing.
--      * Nobody, through the API: insert, update or delete a row directly.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 3. public.save_payroll_month: saves one month of one company, all of it or nothing. The
--    caller names the revision they last saw (0 for a month that does not exist yet); if
--    someone else saved since, or the same save arrives twice, it is refused instead of
--    overwriting their work.
--
-- 4. public.save_payroll_key_change: a column's (or an identity field's) key changed. In ONE
--    transaction it saves the column setup that carries the new key, through
--    save_payroll_shared_setup or save_payroll_company_setup (migration 0013, unchanged, with
--    all their checks), and moves the values from the old key to the new one in every saved
--    month of every company the key reaches: every company attached to the shared setup for a
--    Global column or an identity field, the one company for a company column. All of it is
--    stored, or none of it, so the setup and the months never disagree about a key.
--
-- 5. Three small helpers the two functions share: payroll_month_employee_count (checks the
--    shape of a month and counts its employees), payroll_month_value_keys (the column keys a
--    month holds values under: names only, never a value) and payroll_month_rename_key. They
--    can only be called from inside the functions above.
--
--    The two save functions are SECURITY DEFINER: the tables have no write policy or grant,
--    so each applies the rules itself. search_path = '' and fully qualified names, so nothing
--    can be shadowed.
--
-- 6. public.delete_company (migration 0013) is replaced: it now also deletes the company's
--    months and their history, before its column setup. It returns their counts as
--    "payroll_months" and "payroll_month_history". Nothing else about it changes. If you ever
--    run an older delete_company file again after this one, run this file again too.
--
-- Limits: a month is at most 1 MB as JSON (400 employees take about 90 KB) and 5000
-- employees; an employee id is 1 to 100 characters; a month is between January 2000 and
-- December 2100; one key change moves at most 20 keys.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN      no logged-in user
--   PH_NOT_ADMIN          the caller is not an admin of this company (or it does not exist)
--   PH_NOT_FOUND          the company has no column setup, or there is no such month
--   PH_INVALID_INPUT      the month, an employee or a key is missing or malformed
--   PH_TOO_LARGE          the month is larger than 1 MB or has more than 5000 employees
--   PH_STALE              the revision the caller last saw is not the current one
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.payroll_months (
  company_id        uuid not null references public.companies(id) on delete cascade,
  -- Always the first day of the month.
  period            date not null
                    check (extract(day from period) = 1
                           and period between date '2000-01-01' and date '2100-12-01'),
  revision          integer not null check (revision >= 1),
  -- The column setup this revision was saved with.
  shared_setup_id   uuid not null,
  shared_revision   integer not null check (shared_revision >= 1),
  company_revision  integer not null check (company_revision >= 1),
  employees         jsonb not null
                    check (jsonb_typeof(employees) = 'array'
                           and octet_length(employees::text) <= 1048576),
  -- Worked out by the save functions from `employees`; never sent by a caller.
  employee_count    integer not null check (employee_count between 0 and 5000),
  value_keys        text[] not null default '{}',
  -- Become empty if that user account is ever removed; the row itself stays.
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  primary key (company_id, period),
  -- The revisions it was saved with are kept for good (migration 0013 never drops one).
  foreign key (shared_setup_id, shared_revision)
    references public.payroll_shared_setup_history (shared_setup_id, revision) on delete restrict,
  foreign key (company_id, company_revision)
    references public.payroll_company_setup_history (company_id, revision) on delete restrict
);

create table if not exists public.payroll_month_history (
  company_id        uuid not null,
  period            date not null,
  revision          integer not null check (revision >= 1),
  shared_setup_id   uuid not null,
  shared_revision   integer not null,
  company_revision  integer not null,
  employee_count    integer not null,
  -- The month as it was at this revision, when it is kept (see above); otherwise empty.
  employees         jsonb,
  -- Whether it is: readable without reading the content itself.
  content_kept      boolean generated always as (employees is not null) stored,
  saved_by          uuid references auth.users(id) on delete set null,
  saved_at          timestamptz not null default now(),
  primary key (company_id, period, revision),
  foreign key (company_id, period)
    references public.payroll_months (company_id, period) on delete cascade
);

-- ---------- helpers, callable only from the functions below ----------

-- Checks that a month is a list of { "id": "...", "values": { ... } } and returns how many
-- employees it has. Raises PH_INVALID_INPUT or PH_TOO_LARGE. Never looks at a value.
create or replace function public.payroll_month_employee_count(p_employees jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item  jsonb;
  v_count integer;
begin
  if p_employees is null or jsonb_typeof(p_employees) <> 'array' then
    raise exception 'PH_INVALID_INPUT: the employees must be a list' using errcode = '22023';
  end if;

  if octet_length(p_employees::text) > 1048576 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  v_count := jsonb_array_length(p_employees);
  if v_count > 5000 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  for v_item in select value from jsonb_array_elements(p_employees) loop
    -- Written with "is distinct from": a missing key must fail the check, not slip through
    -- it as null.
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item -> 'id') is distinct from 'string'
       or char_length(v_item ->> 'id') not between 1 and 100
       or jsonb_typeof(v_item -> 'values') is distinct from 'object' then
      raise exception 'PH_INVALID_INPUT: an employee is missing its id or its values'
        using errcode = '22023';
    end if;
  end loop;

  if (select count(distinct value ->> 'id') from jsonb_array_elements(p_employees)) <> v_count then
    raise exception 'PH_INVALID_INPUT: an employee id appears twice' using errcode = '22023';
  end if;

  return v_count;
end;
$$;

-- The column keys a month holds values under, sorted. Names only.
create or replace function public.payroll_month_value_keys(p_employees jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct k order by k), '{}')
  from jsonb_array_elements(p_employees) e,
       jsonb_object_keys(e -> 'values') k;
$$;

-- The month with every value under p_old moved to p_new. An employee without p_old is left
-- exactly as it is.
create or replace function public.payroll_month_rename_key(p_employees jsonb, p_old text, p_new text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      case
        when (e -> 'values') ? p_old then
          jsonb_set(e, '{values}',
                    ((e -> 'values') - p_old) || jsonb_build_object(p_new, (e -> 'values') -> p_old))
        else e
      end
      order by i
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(p_employees) with ordinality as t(e, i);
$$;

revoke all on function public.payroll_month_employee_count(jsonb) from public, anon, authenticated;
revoke all on function public.payroll_month_value_keys(jsonb) from public, anon, authenticated;
revoke all on function public.payroll_month_rename_key(jsonb, text, text)
  from public, anon, authenticated;

-- ---------- row level security: read policies only, admins only ----------
alter table public.payroll_months        enable row level security;
alter table public.payroll_month_history enable row level security;

drop policy if exists "payroll_months_select" on public.payroll_months;
create policy "payroll_months_select" on public.payroll_months
  for select to authenticated
  using (public.is_company_admin(company_id));

drop policy if exists "payroll_month_history_select" on public.payroll_month_history;
create policy "payroll_month_history_select" on public.payroll_month_history
  for select to authenticated
  using (public.is_company_admin(company_id));

-- ---------- grants: logged-in users may read (the policies say what); nothing for anon ----------
revoke all on table public.payroll_months        from public, anon, authenticated;
revoke all on table public.payroll_month_history from public, anon, authenticated;
grant select on table public.payroll_months        to authenticated;
grant select on table public.payroll_month_history to authenticated;

-- ---------- save one month ----------
create or replace function public.save_payroll_month(
  p_company_id        uuid,
  p_period            date,
  p_employees         jsonb,
  p_expected_revision integer,
  p_shared_revision   integer,
  p_company_revision  integer,
  p_keep_previous     boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_setup  public.payroll_company_setups%rowtype;
  v_month  public.payroll_months%rowtype;
  v_count  integer;
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
  if p_period is null or extract(day from p_period) <> 1
     or p_period not between date '2000-01-01' and date '2100-12-01' then
    raise exception 'PH_INVALID_INPUT: the month must be the first day of a month from 2000 to 2100'
      using errcode = '22023';
  end if;

  v_count := public.payroll_month_employee_count(p_employees);

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  if p_shared_revision is null or p_company_revision is null then
    raise exception 'PH_INVALID_INPUT: the column setup revisions are missing' using errcode = '22023';
  end if;

  -- Never while the company is being deleted, and one save at a time per company.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- the column setup it was saved with ----------
  select * into v_setup
  from public.payroll_company_setups cs
  where cs.company_id = p_company_id;

  if not found then
    raise exception 'PH_NOT_FOUND: the company has no payroll column setup' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.payroll_shared_setup_history h
    where h.shared_setup_id = v_setup.shared_setup_id and h.revision = p_shared_revision
  ) or not exists (
    select 1 from public.payroll_company_setup_history h
    where h.company_id = p_company_id and h.revision = p_company_revision
  ) then
    raise exception 'PH_INVALID_INPUT: those column setup revisions are not this company''s'
      using errcode = '22023';
  end if;

  -- ---------- the month ----------
  select * into v_month
  from public.payroll_months pm
  where pm.company_id = p_company_id and pm.period = p_period
  for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    begin
      insert into public.payroll_months (
        company_id, period, revision, shared_setup_id, shared_revision, company_revision,
        employees, employee_count, value_keys, created_by, created_at, updated_by, updated_at
      )
      values (
        p_company_id, p_period, 1, v_setup.shared_setup_id, p_shared_revision, p_company_revision,
        p_employees, v_count, public.payroll_month_value_keys(p_employees),
        v_user, now(), v_user, now()
      )
      returning * into v_month;
    exception when unique_violation then
      -- Saved by someone else in the same moment.
      raise exception 'PH_STALE' using errcode = 'P0001';
    end;
  else
    -- Someone else saved since the caller loaded it (or this very save already went
    -- through): refuse, never overwrite.
    if v_month.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    -- What is about to be replaced is kept when it would otherwise be lost for good.
    update public.payroll_month_history h
       set employees = v_month.employees
     where h.company_id = v_month.company_id
       and h.period = v_month.period
       and h.revision = v_month.revision
       and h.employees is null
       and (coalesce(p_keep_previous, false)
            or v_month.updated_by is distinct from v_user
            or (v_month.updated_at at time zone 'UTC')::date < (now() at time zone 'UTC')::date);

    update public.payroll_months pm
       set revision         = pm.revision + 1,
           shared_setup_id  = v_setup.shared_setup_id,
           shared_revision  = p_shared_revision,
           company_revision = p_company_revision,
           employees        = p_employees,
           employee_count   = v_count,
           value_keys       = public.payroll_month_value_keys(p_employees),
           updated_by       = v_user,
           updated_at       = now()
     where pm.company_id = p_company_id and pm.period = p_period
    returning * into v_month;
  end if;

  -- ---------- the record of this save ----------
  insert into public.payroll_month_history (
    company_id, period, revision, shared_setup_id, shared_revision, company_revision,
    employee_count, employees, saved_by, saved_at
  )
  values (
    v_month.company_id, v_month.period, v_month.revision, v_month.shared_setup_id,
    v_month.shared_revision, v_month.company_revision, v_month.employee_count, null,
    v_user, v_month.updated_at
  );

  -- What was stored, without the employees.
  return jsonb_build_object(
    'company_id',       v_month.company_id,
    'period',           v_month.period,
    'revision',         v_month.revision,
    'shared_revision',  v_month.shared_revision,
    'company_revision', v_month.company_revision,
    'employee_count',   v_month.employee_count,
    'updated_at',       v_month.updated_at
  );
end;
$$;

revoke all on function public.save_payroll_month(uuid, date, jsonb, integer, integer, integer, boolean)
  from public, anon;
grant execute on function public.save_payroll_month(uuid, date, jsonb, integer, integer, integer, boolean)
  to authenticated;

-- ---------- a change of key: the setup and every month, together ----------
-- p_moves:   [{ "old_key": "basicSalary", "new_key": "basicPay", "company_id": null }, ...]
--            company_id null or left out = every company attached to the shared setup (a Global column or
--            an identity field); otherwise that one company (a company column). Applied in order.
-- p_shared:  { "setup_id", "name", "body", "expected_revision", "companies": [...] }, the same
--            as save_payroll_shared_setup takes; or null
-- p_company: { "company_id", "body", "expected_revision" }, as save_payroll_company_setup
--            takes; or null. Exactly one of p_shared and p_company is given.
create or replace function public.save_payroll_key_change(
  p_moves   jsonb,
  p_shared  jsonb default null,
  p_company jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user       uuid := (select auth.uid());
  v_setup_id   uuid;
  v_saved      jsonb;
  v_move       jsonb;
  v_targets    uuid[];
  v_company_id uuid;
  v_month      public.payroll_months%rowtype;
  v_after      public.payroll_months%rowtype;
  v_employees  jsonb;
  v_shared_rev integer;
  v_company_rev integer;
  v_count      integer;
  v_months     jsonb := '[]'::jsonb;
  v_key        text := '^[A-Za-z_$][A-Za-z0-9_$]{0,99}$';
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- ---------- input checks ----------
  if (jsonb_typeof(p_shared) is not distinct from 'object')
     = (jsonb_typeof(p_company) is not distinct from 'object') then
    raise exception 'PH_INVALID_INPUT: give either the shared setup or the company setup'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_moves) is distinct from 'array'
     or jsonb_array_length(p_moves) not between 1 and 20 then
    raise exception 'PH_INVALID_INPUT: the keys to move must be a list of 1 to 20'
      using errcode = '22023';
  end if;

  for v_move in select value from jsonb_array_elements(p_moves) loop
    if jsonb_typeof(v_move) is distinct from 'object'
       or jsonb_typeof(v_move -> 'old_key') is distinct from 'string'
       or jsonb_typeof(v_move -> 'new_key') is distinct from 'string'
       or (v_move ->> 'old_key') !~ v_key
       or (v_move ->> 'new_key') !~ v_key
       or (v_move ->> 'old_key') = (v_move ->> 'new_key')
       or (coalesce(jsonb_typeof(v_move -> 'company_id'), 'null') <> 'null'
           and (jsonb_typeof(v_move -> 'company_id') is distinct from 'string'
                or coalesce(v_move ->> 'company_id', '')
                   !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
      raise exception 'PH_INVALID_INPUT: a key to move is missing or malformed'
        using errcode = '22023';
    end if;
  end loop;

  -- ---------- 1. the setup, with every check it always has ----------
  if p_shared is not null and jsonb_typeof(p_shared) = 'object' then
    if jsonb_typeof(p_shared -> 'expected_revision') is distinct from 'number'
       or coalesce(p_shared ->> 'setup_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'PH_INVALID_INPUT: the shared setup is missing its id or last revision seen'
        using errcode = '22023';
    end if;
    v_setup_id := (p_shared ->> 'setup_id')::uuid;
    -- A key change is a change of an existing setup, never the creation of one.
    if (p_shared ->> 'expected_revision')::integer < 1 then
      raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
    end if;
    v_saved := public.save_payroll_shared_setup(
      v_setup_id,
      p_shared ->> 'name',
      p_shared -> 'body',
      (p_shared ->> 'expected_revision')::integer,
      coalesce(p_shared -> 'companies', '[]'::jsonb)
    );
  else
    if jsonb_typeof(p_company -> 'expected_revision') is distinct from 'number'
       or coalesce(p_company ->> 'company_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'PH_INVALID_INPUT: the company setup is missing its company or last revision seen'
        using errcode = '22023';
    end if;
    v_company_id := (p_company ->> 'company_id')::uuid;
    v_saved := public.save_payroll_company_setup(
      v_company_id,
      p_company -> 'body',
      (p_company ->> 'expected_revision')::integer
    );
    v_setup_id := (v_saved ->> 'shared_setup_id')::uuid;
    -- A company setup alone can only carry a company column's key.
    if exists (
      select 1 from jsonb_array_elements(p_moves) m
      where (m.value ->> 'company_id') is distinct from v_company_id::text
    ) then
      raise exception 'PH_INVALID_INPUT: a company setup can only move keys in its own months'
        using errcode = '22023';
    end if;
  end if;

  -- ---------- 2. the months, every one the keys reach ----------
  for v_move in select value from jsonb_array_elements(p_moves) loop
    if jsonb_typeof(v_move -> 'company_id') = 'string' then
      v_targets := array[(v_move ->> 'company_id')::uuid];
      if not exists (
        select 1 from public.payroll_company_setups cs
        where cs.company_id = v_targets[1] and cs.shared_setup_id = v_setup_id
      ) then
        raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
      end if;
    else
      select coalesce(array_agg(cs.company_id order by cs.company_id), '{}') into v_targets
      from public.payroll_company_setups cs
      where cs.shared_setup_id = v_setup_id;
    end if;

    foreach v_company_id in array v_targets loop
      -- Months are admin-only: so is moving them. (For a Global key the shared setup's own
      -- rule already demands it; this is the backstop.)
      if not exists (
        select 1 from public.company_members m
        where m.company_id = v_company_id and m.user_id = v_user and m.role = 'admin'
      ) then
        raise exception 'PH_NOT_ADMIN' using errcode = '42501';
      end if;

      select cs.revision into v_company_rev
      from public.payroll_company_setups cs where cs.company_id = v_company_id;
      select s.revision into v_shared_rev
      from public.payroll_shared_setups s where s.id = v_setup_id;

      for v_month in
        select * from public.payroll_months pm
        where pm.company_id = v_company_id and (v_move ->> 'old_key') = any (pm.value_keys)
        order by pm.period
        for update
      loop
        v_employees := public.payroll_month_rename_key(
          v_month.employees, v_move ->> 'old_key', v_move ->> 'new_key');
        if octet_length(v_employees::text) > 1048576 then
          raise exception 'PH_TOO_LARGE' using errcode = '54000';
        end if;
        v_count := public.payroll_month_employee_count(v_employees);

        update public.payroll_month_history h
           set employees = v_month.employees
         where h.company_id = v_month.company_id
           and h.period = v_month.period
           and h.revision = v_month.revision
           and h.employees is null
           and (v_month.updated_by is distinct from v_user
                or (v_month.updated_at at time zone 'UTC')::date < (now() at time zone 'UTC')::date);

        update public.payroll_months pm
           set revision         = pm.revision + 1,
               shared_setup_id  = v_setup_id,
               shared_revision  = v_shared_rev,
               company_revision = v_company_rev,
               employees        = v_employees,
               employee_count   = v_count,
               value_keys       = public.payroll_month_value_keys(v_employees),
               updated_by       = v_user,
               updated_at       = now()
         where pm.company_id = v_month.company_id and pm.period = v_month.period
        returning * into v_after;

        insert into public.payroll_month_history (
          company_id, period, revision, shared_setup_id, shared_revision, company_revision,
          employee_count, employees, saved_by, saved_at
        )
        values (
          v_after.company_id, v_after.period, v_after.revision, v_after.shared_setup_id,
          v_after.shared_revision, v_after.company_revision, v_after.employee_count, null,
          v_user, v_after.updated_at
        );

        v_months := v_months || jsonb_build_object(
          'company_id', v_after.company_id,
          'period',     v_after.period,
          'revision',   v_after.revision
        );
      end loop;
    end loop;
  end loop;

  -- What was stored: the setup's answer, as its own function gives it, and each month moved.
  return jsonb_build_object('setup', v_saved, 'months', v_months);
end;
$$;

revoke all on function public.save_payroll_key_change(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_payroll_key_change(jsonb, jsonb, jsonb) to authenticated;

-- ---------- delete_company: as in 0013, plus the payroll months ----------
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

-- Ask the Data API to pick up the new tables and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select bool_and(c.relrowsecurity) and count(*) = 2
   from pg_class c
   where c.oid in ('public.payroll_months'::regclass, 'public.payroll_month_history'::regclass))
    as row_security_on_both,
  (select count(*) = 2
          and bool_and(cmd = 'SELECT' and roles = '{authenticated}'
                       and qual like '%is_company_admin(%')
   from pg_policies
   where schemaname = 'public' and tablename in ('payroll_months', 'payroll_month_history'))
    as only_admins_read,
  (select bool_and(has_table_privilege('authenticated', t, 'select'))
   from unnest(array['public.payroll_months', 'public.payroll_month_history']) t)
    as signed_in_can_read,
  (select bool_and(not has_table_privilege('authenticated', t,
                     'insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.payroll_months', 'public.payroll_month_history']) t)
    as signed_in_cannot_write_directly,
  (select bool_and(not has_table_privilege('anon', t,
                     'select, insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.payroll_months', 'public.payroll_month_history']) t)
    as anon_has_nothing,
  (select count(*) = 2 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.save_payroll_month(uuid, date, jsonb, integer, integer, integer, boolean)'::regprocedure,
     'public.save_payroll_key_change(jsonb, jsonb, jsonb)'::regprocedure))
    as saves_are_definer_with_empty_search_path,
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.save_payroll_month(uuid, date, jsonb, integer, integer, integer, boolean)',
     'public.save_payroll_key_change(jsonb, jsonb, jsonb)']) f)
    as signed_in_only_can_save,
  (select count(*) = 3
          and bool_and(not p.prosecdef and p.proconfig = array['search_path=""']
                       and not has_function_privilege('authenticated', p.oid, 'execute')
                       and not has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.oid in (
     'public.payroll_month_employee_count(jsonb)'::regprocedure,
     'public.payroll_month_value_keys(jsonb)'::regprocedure,
     'public.payroll_month_rename_key(jsonb, text, text)'::regprocedure))
    as helpers_only_from_inside,
  (select count(*) = 5 from pg_proc
   where proname in ('save_payroll_month', 'save_payroll_key_change',
                     'payroll_month_employee_count', 'payroll_month_value_keys',
                     'payroll_month_rename_key'))
    as each_exists_once,
  (select count(*) = 2 from pg_constraint
   where conrelid = 'public.payroll_months'::regclass and contype = 'f'
     and confrelid in ('public.payroll_shared_setup_history'::regclass,
                       'public.payroll_company_setup_history'::regclass))
    as months_point_at_kept_setup_revisions,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.payroll_month_history%'
          and p.prosrc like '%public.payroll_months%'
          and p.prosrc like '%public.payroll_company_setup_history%'
          and p.prosrc like '%public.pdf_template_history%'
          and p.prosrc like '%public.issued_payslips%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
