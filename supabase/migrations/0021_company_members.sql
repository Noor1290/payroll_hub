-- =====================================================================
-- The Members card on the Company profile: who belongs to a company, and every change to that
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0020. Safe to re-run.
-- Undo (only if asked): supabase/undo/0021_company_members_undo.sql
--
-- Nothing that exists is changed: no existing table, column, row, policy or grant. This file
-- only ADDS one table, one read policy and four functions, and replaces public.delete_company
-- with the same function plus the new table. Until now members could be changed only in this
-- SQL editor; that still works, but such a change is not recorded in the new table.
--
-- 1. public.company_member_history: one row for every change made through these functions: who
--    made it, when, whose membership and what changed. Emails are kept as they were at the time,
--    so a record still reads the same after an account is deleted. Read by the company's admins
--    only. Nobody can write to it through the API, and nothing here ever changes or deletes a
--    row of it, except that it goes with its company when the company is deleted.
--
-- 2. The functions. All are for an ADMIN of THAT company, checked first, before any input is
--    looked at, and all work on one company at a time:
--      public.list_company_members: the members, with their emails.
--      public.add_company_member: adds an existing user by email, as admin or viewer. An email
--        with no account is refused as PH_NO_ACCOUNT, which tells an admin that there is no
--        account with it. Nobody is invited and no email is sent.
--      public.set_company_member_role: changes a member's role.
--      public.remove_company_member: removes a member.
--
--    The rules:
--      * The last admin of a company can never be removed or made a viewer (PH_LAST_ADMIN).
--      * An admin cannot remove themselves, or make themselves a viewer (PH_NOT_YOURSELF):
--        another admin does it, so nobody locks themselves out by accident.
--      * Two changes at once wait for each other: the company's row is locked first, so two
--        admins cannot each remove the other.
--
--    All are SECURITY DEFINER: company_members has no write grant, and the emails are in
--    auth.users, which no API user can read. search_path = '' and fully qualified names, so
--    nothing can be shadowed.
--
-- 3. public.delete_company (newest in migration 0020) is replaced: the same function, which now
--    also deletes the company's rows in public.company_member_history, by name, like every
--    other table of a company.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_INVALID_INPUT, PH_NOT_FOUND (not a member of this
--   company), and new: PH_NO_ACCOUNT, PH_ALREADY_MEMBER, PH_SAME_ROLE, PH_LAST_ADMIN,
--   PH_NOT_YOURSELF
-- =====================================================================

create table if not exists public.company_member_history (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references public.companies(id) on delete cascade,
  action           text not null check (action in ('added', 'role-changed', 'removed')),
  member_id        uuid references auth.users(id) on delete set null,
  member_email     text not null,
  old_role         text check (old_role in ('admin', 'viewer')),
  new_role         text check (new_role in ('admin', 'viewer')),
  changed_by       uuid references auth.users(id) on delete set null,
  changed_by_email text not null,
  changed_at       timestamptz not null default now()
);

create index if not exists company_member_history_company_idx
  on public.company_member_history (company_id, changed_at desc);

alter table public.company_member_history enable row level security;

revoke all on public.company_member_history from public, anon, authenticated;
grant select on public.company_member_history to authenticated;

drop policy if exists "company_member_history_select" on public.company_member_history;
create policy "company_member_history_select" on public.company_member_history
  for select to authenticated
  using (public.is_company_admin(company_id));

-- ---------- list_company_members ----------
create or replace function public.list_company_members(p_company_id uuid)
returns table (user_id uuid, email text, role text, added_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = (select auth.uid()) and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.company_members m
    join auth.users u on u.id = m.user_id
    where m.company_id = p_company_id
    order by lower(u.email::text);
end;
$$;

-- ---------- add_company_member ----------
create or replace function public.add_company_member(
  p_company_id uuid,
  p_email      text,
  p_role       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_by_email text;
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_member   uuid;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('admin', 'viewer') then
    raise exception 'PH_INVALID_INPUT: the role must be admin or viewer' using errcode = '22023';
  end if;
  if length(v_email) not between 3 and 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'PH_INVALID_INPUT: that is not an email address' using errcode = '22023';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;

  select u.id into v_member from auth.users u where lower(u.email::text) = v_email;
  if not found then
    raise exception 'PH_NO_ACCOUNT' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_member
  ) then
    raise exception 'PH_ALREADY_MEMBER' using errcode = '23505';
  end if;

  insert into public.company_members (company_id, user_id, role)
  values (p_company_id, v_member, p_role);

  select u.email::text into v_by_email from auth.users u where u.id = v_user;
  insert into public.company_member_history
    (company_id, action, member_id, member_email, new_role, changed_by, changed_by_email)
  values (p_company_id, 'added', v_member, v_email, p_role, v_user, coalesce(v_by_email, ''));

  return jsonb_build_object('user_id', v_member, 'email', v_email, 'role', p_role);
end;
$$;

-- ---------- set_company_member_role ----------
create or replace function public.set_company_member_role(
  p_company_id uuid,
  p_user_id    uuid,
  p_role       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_old      text;
  v_email    text;
  v_by_email text;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('admin', 'viewer') then
    raise exception 'PH_INVALID_INPUT: the role must be admin or viewer' using errcode = '22023';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;

  select m.role into v_old from public.company_members m
  where m.company_id = p_company_id and m.user_id = p_user_id;
  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_old = p_role then
    raise exception 'PH_SAME_ROLE' using errcode = 'P0001';
  end if;

  if v_old = 'admin' then
    if (select count(*) from public.company_members m
        where m.company_id = p_company_id and m.role = 'admin') = 1 then
      raise exception 'PH_LAST_ADMIN' using errcode = 'P0001';
    end if;
    if p_user_id = v_user then
      raise exception 'PH_NOT_YOURSELF' using errcode = 'P0001';
    end if;
  end if;

  update public.company_members m set role = p_role
  where m.company_id = p_company_id and m.user_id = p_user_id;

  select u.email::text into v_email from auth.users u where u.id = p_user_id;
  select u.email::text into v_by_email from auth.users u where u.id = v_user;
  insert into public.company_member_history
    (company_id, action, member_id, member_email, old_role, new_role, changed_by, changed_by_email)
  values (p_company_id, 'role-changed', p_user_id, coalesce(v_email, ''), v_old, p_role, v_user,
          coalesce(v_by_email, ''));

  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end;
$$;

-- ---------- remove_company_member ----------
create or replace function public.remove_company_member(
  p_company_id uuid,
  p_user_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_old      text;
  v_email    text;
  v_by_email text;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;

  select m.role into v_old from public.company_members m
  where m.company_id = p_company_id and m.user_id = p_user_id;
  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_old = 'admin' and (select count(*) from public.company_members m
                          where m.company_id = p_company_id and m.role = 'admin') = 1 then
    raise exception 'PH_LAST_ADMIN' using errcode = 'P0001';
  end if;
  if p_user_id = v_user then
    raise exception 'PH_NOT_YOURSELF' using errcode = 'P0001';
  end if;

  delete from public.company_members m
  where m.company_id = p_company_id and m.user_id = p_user_id;

  select u.email::text into v_email from auth.users u where u.id = p_user_id;
  select u.email::text into v_by_email from auth.users u where u.id = v_user;
  insert into public.company_member_history
    (company_id, action, member_id, member_email, old_role, changed_by, changed_by_email)
  values (p_company_id, 'removed', p_user_id, coalesce(v_email, ''), v_old, v_user,
          coalesce(v_by_email, ''));

  return jsonb_build_object('user_id', p_user_id);
end;
$$;

-- ---------- delete_company: as in 0020, plus the record of changes to members ----------
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
  v_mra_ids           uuid[];
  v_mra_links         integer;
  v_mra_history       integer;
  v_mra_templates     integer;
  v_mra_details       integer;
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
    'members',                       v_members
  );
end;
$$;

revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;

revoke all on function public.list_company_members(uuid) from public, anon;
revoke all on function public.add_company_member(uuid, text, text) from public, anon;
revoke all on function public.set_company_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.remove_company_member(uuid, uuid) from public, anon;
grant execute on function public.list_company_members(uuid) to authenticated;
grant execute on function public.add_company_member(uuid, text, text) to authenticated;
grant execute on function public.set_company_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_company_member(uuid, uuid) to authenticated;

-- Ask the Data API to pick up the new table and functions straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select c.relrowsecurity from pg_class c
   where c.oid = 'public.company_member_history'::regclass)
    as history_has_row_level_security,
  (select count(*) = 1 from pg_policies
   where schemaname = 'public' and tablename = 'company_member_history' and cmd = 'SELECT')
    as history_has_one_read_policy,
  (not has_table_privilege('authenticated', 'public.company_member_history',
                           'insert, update, delete, truncate')
   and not has_table_privilege('authenticated', 'public.company_members',
                               'insert, update, delete, truncate'))
    as signed_in_cannot_write_directly,
  (not has_table_privilege('anon', 'public.company_member_history',
                           'select, insert, update, delete, truncate, references, trigger'))
    as anon_has_nothing,
  (select count(*) = 4 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.list_company_members(uuid)'::regprocedure,
     'public.add_company_member(uuid, text, text)'::regprocedure,
     'public.set_company_member_role(uuid, uuid, text)'::regprocedure,
     'public.remove_company_member(uuid, uuid)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.list_company_members(uuid)',
     'public.add_company_member(uuid, text, text)',
     'public.set_company_member_role(uuid, uuid, text)',
     'public.remove_company_member(uuid, uuid)']) f)
    as signed_in_only_can_call_them,
  (select count(*) = 4 from pg_proc
   where proname in ('list_company_members', 'add_company_member',
                     'set_company_member_role', 'remove_company_member'))
    as each_exists_once,
  (select bool_and(p.prosrc like '%PH_LAST_ADMIN%' and p.prosrc like '%PH_NOT_YOURSELF%')
   from pg_proc p
   where p.oid in ('public.set_company_member_role(uuid, uuid, text)'::regprocedure,
                   'public.remove_company_member(uuid, uuid)'::regprocedure))
    as last_admin_and_self_are_refused,
  (select p.prosrc like '%public.company_member_history%'
          and p.prosrc like '%public.mra_template_companies%'
          and p.prosrc like '%public.issued_payslips%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated;
