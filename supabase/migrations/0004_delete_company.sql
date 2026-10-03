-- =====================================================================
-- Delete a company from the dashboard
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001, 0002 and 0003. Safe to re-run (create or replace).
--
-- What it does: PERMANENTLY deletes one company and everything that belongs to it: its payroll
-- entries, payroll runs, employees and memberships (so every member loses access at once).
-- Soft-deleted runs and employees are deleted too. There is no undo; the only way back is a
-- database backup.
--
-- Who may call it: an admin of THAT company. Not an admin of some other company, not a viewer,
-- not a signed-in user with no company, not an anonymous visitor.
--
-- Safeguards:
--   * The caller must pass the company's exact name as well as its id, so a delete can never be
--     triggered by an id alone.
--   * A company with any approved run is refused, whether or not that run is soft-deleted. An
--     admin has to set those runs back to draft first (the same rule as replacing a run).
--   * Everything happens inside this one function, which is one transaction: it either deletes
--     all of it or changes nothing.
--
-- Why SECURITY DEFINER: there is deliberately no DELETE policy or grant on public.companies or
-- public.company_members, and this migration adds none. Deleting a company therefore has to go
-- through this function, which runs with its owner's rights and applies the rules above itself.
-- search_path = '' and fully qualified names, so nothing can be shadowed.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN       no logged-in user
--   PH_NOT_ADMIN           the caller is not an admin of this company (or it does not exist)
--   PH_NAME_MISMATCH       the name passed is not the company's name
--   PH_HAS_APPROVED_RUNS   the company has at least one approved run
-- =====================================================================

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
  v_approved  integer;
  v_entries   integer;
  v_runs      integer;
  v_employees integer;
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

  -- Lock the company row for the rest of the transaction, so nothing (an import, another
  -- delete) can change what belongs to it while it is being removed.
  select * into v_company
  from public.companies
  where id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- the caller must name what they are deleting ----------
  if p_confirm_name is null or btrim(p_confirm_name) <> btrim(v_company.name) then
    raise exception 'PH_NAME_MISMATCH' using errcode = '22023';
  end if;

  -- ---------- approved runs protect the company, soft-deleted or not ----------
  select count(*) into v_approved
  from public.payroll_runs r
  where r.company_id = p_company_id and r.status = 'approved';

  if v_approved > 0 then
    raise exception 'PH_HAS_APPROVED_RUNS' using errcode = 'P0001', detail = v_approved::text;
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

  delete from public.company_members m where m.company_id = p_company_id;
  get diagnostics v_members = row_count;

  delete from public.companies c where c.id = p_company_id;

  -- Counts only: nothing about the company's data is returned.
  return jsonb_build_object(
    'company_id', p_company_id,
    'entries',    v_entries,
    'runs',       v_runs,
    'employees',  v_employees,
    'members',    v_members
  );
end;
$$;

-- Only logged-in users may call it. The function itself then requires an admin of the company.
revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;

-- Ask the Data API to pick up the new function straight away.
notify pgrst, 'reload schema';
