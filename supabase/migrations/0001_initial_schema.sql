-- =====================================================================
-- Payroll schema for Supabase
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Assumes project settings:
--   Data API: ON | Automatically expose new tables: OFF | Automatic RLS: ON
-- (so this script grants access explicitly and enables RLS explicitly)
-- =====================================================================

-- ---------- TABLES ----------

-- One row per company (replaces Company Name / Address / BRN / VAT repeated in every JSON row)
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  brn         text unique,
  vat         text,                      -- stored as text, e.g. '12%'
  created_at  timestamptz not null default now()
);

-- Which logged-in user can access which company, and with what role
create table public.company_members (
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index on public.company_members (user_id);

-- Employees (JSON: ID, Surname, Other names, Full time / Part time)
create table public.employees (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  national_id      text not null,        -- JSON "ID" (sensitive personal data)
  surname          text not null,
  other_names      text,
  employment_type  text,                 -- 'Full Time' / 'Part Time' (trim spaces on import)
  deleted_at       timestamptz,          -- soft delete: dashboard filters "deleted_at is null"
  created_at       timestamptz not null default now(),
  unique (company_id, national_id)
);

-- One row per company per month (JSON file name: ...-2026-09.json -> period 2026-09-01)
create table public.payroll_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  period      date not null check (period = date_trunc('month', period)::date),
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (company_id, period)
);

-- One row per employee per run: all the numeric columns from your JSON
create table public.payroll_entries (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id              uuid not null references public.employees(id) on delete restrict,

  basic_salary             numeric(12,2) not null default 0,  -- "Basic Salary"
  govt_increment           numeric(12,2) not null default 0,  -- "Govt Increment"
  new_basic_salary         numeric(12,2) not null default 0,  -- "New Basic Salary"
  allowances               numeric(12,2) not null default 0,  -- "Allowances"
  emoluments               numeric(12,2) not null default 0,  -- "Emoluments"
  travelling               numeric(12,2) not null default 0,  -- "Travelling"
  gross_pay                numeric(12,2) not null default 0,  -- "Gross Pay"
  age_60_plus              boolean       not null default false, -- "Age 60+" ("Yes"/"No")
  csg                      numeric(12,2) not null default 0,  -- "CSG"
  nsf                      numeric(12,2) not null default 0,  -- "NSF"
  paye                     numeric(12,2) not null default 0,  -- "PAYE"
  total_deductions         numeric(12,2) not null default 0,  -- "Total deductions"
  net_pay                  numeric(12,2) not null default 0,  -- "Net Pay"
  levy                     numeric(12,2) not null default 0,  -- "Levy"
  prgf                     numeric(12,2) not null default 0,  -- "PRGF"
  total_mra_contributions  numeric(12,2) not null default 0,  -- "Total MRA contributions"
  edf                      numeric(12,2) not null default 0,  -- "EDF"
  edf_monthly              numeric(12,2) not null default 0,  -- "EDF (monthly)"
  total                    numeric(12,2) not null default 0,  -- "Total"

  extra                    jsonb not null default '{}'::jsonb, -- any future JSON fields, no schema change needed
  created_at               timestamptz not null default now(),
  unique (run_id, employee_id)
);
create index on public.payroll_entries (employee_id);

-- ---------- ROW LEVEL SECURITY ----------

alter table public.companies        enable row level security;
alter table public.company_members  enable row level security;
alter table public.employees        enable row level security;
alter table public.payroll_runs     enable row level security;
alter table public.payroll_entries  enable row level security;

-- Helper functions (security definer so policies can check membership without recursion)
create or replace function public.is_company_member(cid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_company_admin(cid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = (select auth.uid()) and m.role = 'admin'
  );
$$;

revoke all on function public.is_company_member(uuid) from public, anon;
revoke all on function public.is_company_admin(uuid)  from public, anon;
grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.is_company_admin(uuid)  to authenticated;

-- companies: members can read, admins can edit. Create/delete companies via SQL editor only.
create policy "companies_select" on public.companies
  for select to authenticated using (public.is_company_member(id));
create policy "companies_update" on public.companies
  for update to authenticated
  using (public.is_company_admin(id)) with check (public.is_company_admin(id));

-- company_members: you see your own membership; admins see everyone in their company.
-- Add/remove members via SQL editor only.
create policy "members_select" on public.company_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_company_admin(company_id));

-- employees: members read, admins write
create policy "employees_select" on public.employees
  for select to authenticated using (public.is_company_member(company_id));
create policy "employees_insert" on public.employees
  for insert to authenticated with check (public.is_company_admin(company_id));
create policy "employees_update" on public.employees
  for update to authenticated
  using (public.is_company_admin(company_id)) with check (public.is_company_admin(company_id));
create policy "employees_delete" on public.employees
  for delete to authenticated using (public.is_company_admin(company_id));

-- payroll_runs: members read, admins write
create policy "runs_select" on public.payroll_runs
  for select to authenticated using (public.is_company_member(company_id));
create policy "runs_insert" on public.payroll_runs
  for insert to authenticated with check (public.is_company_admin(company_id));
create policy "runs_update" on public.payroll_runs
  for update to authenticated
  using (public.is_company_admin(company_id)) with check (public.is_company_admin(company_id));
create policy "runs_delete" on public.payroll_runs
  for delete to authenticated using (public.is_company_admin(company_id));

-- payroll_entries: access follows the parent run's company
create policy "entries_select" on public.payroll_entries
  for select to authenticated
  using (exists (select 1 from public.payroll_runs r
                 where r.id = run_id and public.is_company_member(r.company_id)));
create policy "entries_insert" on public.payroll_entries
  for insert to authenticated
  with check (exists (select 1 from public.payroll_runs r
                      where r.id = run_id and public.is_company_admin(r.company_id)));
create policy "entries_update" on public.payroll_entries
  for update to authenticated
  using (exists (select 1 from public.payroll_runs r
                 where r.id = run_id and public.is_company_admin(r.company_id)))
  with check (exists (select 1 from public.payroll_runs r
                      where r.id = run_id and public.is_company_admin(r.company_id)));
create policy "entries_delete" on public.payroll_entries
  for delete to authenticated
  using (exists (select 1 from public.payroll_runs r
                 where r.id = run_id and public.is_company_admin(r.company_id)));

-- ---------- GRANTS (needed because "automatically expose new tables" is OFF) ----------
-- Only logged-in users get access. Nothing is granted to the anon (public) role.

grant usage on schema public to authenticated;
grant select, update                 on public.companies       to authenticated;
grant select                         on public.company_members to authenticated;
grant select, insert, update, delete on public.employees       to authenticated;
grant select, insert, update, delete on public.payroll_runs    to authenticated;
grant select, insert, update, delete on public.payroll_entries to authenticated;

-- ---------- FIRST-TIME SETUP (run separately, after creating your user in Authentication -> Users) ----------
-- Un-comment, change the email, and run once. The SQL editor bypasses RLS, so this works.
--
-- insert into public.companies (name, address, brn, vat)
-- values ('ABC Co Ltd', 'Mauritius', 'C1234567', '12%');
--
-- insert into public.company_members (company_id, user_id, role)
-- select c.id, u.id, 'admin'
-- from public.companies c, auth.users u
-- where c.brn = 'C1234567' and u.email = 'you@example.com';

-- ---------- HARDENING APPLIED AFTER FIRST RUN (already executed on the dev project) ----------
-- Removes leftover default privileges that the Data API never uses.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;