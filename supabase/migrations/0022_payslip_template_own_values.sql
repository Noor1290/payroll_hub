-- =====================================================================
-- Payslip templates: a company's own values ("this company only")
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0021. Safe to re-run.
-- Undo (only if asked): supabase/undo/0022_payslip_template_own_values_undo.sql
--
-- Nothing that exists is changed: no existing row's data, column, policy or grant. This file
-- only ADDS two columns and one function.
--
-- 1. public.payslip_templates gets own_values and values_revision. A layout uploaded in the
--    payslip app ("From your file") can have a fixed value for all companies, and a value for
--    this company only. Publishing to several companies replaces each company's draft body, and
--    the app cannot read another company's draft, so a value kept in the body would be lost
--    without a word. These columns are not part of the body: publishing does not touch them.
--    A template's own values are read and changed without a new version. Issued payslips hold
--    the text as printed, so a later change never reaches them.
--
--    Who can do what:
--      * Members of the company: read, by the table's existing policy.
--      * Admins of the company: change them, ONLY through the function below.
--      * Nobody, through the API: update a row directly. There is no such policy or grant.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 2. public.save_payslip_template_values: an admin of the company replaces the template's own
--    values. The caller states the values revision it saw; if that is no longer so, it is
--    refused as PH_STALE and nothing is stored. SECURITY DEFINER because the table has no write
--    grant; it checks: signed in, admin of THAT company, the template belongs to that company.
--    search_path = '' and fully qualified names, so nothing can be shadowed.
--
-- Errors the dashboard recognises (message prefix), as in 0010:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_NOT_FOUND, PH_INVALID_INPUT, PH_TOO_LARGE, PH_STALE
-- =====================================================================

-- ---------- columns ----------
alter table public.payslip_templates
  add column if not exists own_values jsonb not null default '{}'::jsonb
    check (jsonb_typeof(own_values) = 'object' and octet_length(own_values::text) <= 65536);
alter table public.payslip_templates
  add column if not exists values_revision integer not null default 1
    check (values_revision >= 1);

-- ---------- replace a template's own values ----------
create or replace function public.save_payslip_template_values(
  p_company_id        uuid,
  p_template_id       uuid,
  p_own_values        jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_template public.payslip_templates%rowtype;
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
  if p_own_values is null or jsonb_typeof(p_own_values) <> 'object' then
    raise exception 'PH_INVALID_INPUT: own values must be an object' using errcode = '22023';
  end if;
  if octet_length(p_own_values::text) > 65536 then
    raise exception 'PH_TOO_LARGE: own values are limited to 64 KB' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'PH_INVALID_INPUT: the revision is missing' using errcode = '22023';
  end if;

  select t.* into v_template
  from public.payslip_templates t
  where t.id = p_template_id and t.company_id = p_company_id
  for update;
  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_template.values_revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = '40001';
  end if;

  update public.payslip_templates t
     set own_values = p_own_values,
         values_revision = t.values_revision + 1
   where t.id = p_template_id and t.company_id = p_company_id
  returning t.* into v_template;

  return jsonb_build_object(
    'template_id', v_template.id,
    'values_revision', v_template.values_revision
  );
end;
$$;

revoke all on function public.save_payslip_template_values(uuid, uuid, jsonb, integer)
  from public, anon;
grant execute on function public.save_payslip_template_values(uuid, uuid, jsonb, integer)
  to authenticated;

-- ---------- verification: one row, every column true ----------
select
  (select count(*) = 2 from information_schema.columns
   where table_schema = 'public' and table_name = 'payslip_templates'
     and column_name in ('own_values', 'values_revision'))
    as columns_exist,
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.save_payslip_template_values(uuid, uuid, jsonb, integer)'::regprocedure)
    as function_is_definer_with_empty_search_path,
  has_function_privilege('authenticated',
    'public.save_payslip_template_values(uuid, uuid, jsonb, integer)', 'execute')
    as signed_in_can_call_it,
  not has_function_privilege('anon',
    'public.save_payslip_template_values(uuid, uuid, jsonb, integer)', 'execute')
    as anon_cannot_call_it,
  has_column_privilege('authenticated', 'public.payslip_templates', 'own_values', 'select')
    as signed_in_can_read_them,
  not has_column_privilege('authenticated', 'public.payslip_templates', 'own_values', 'update')
    as signed_in_cannot_write_directly,
  not has_column_privilege('anon', 'public.payslip_templates', 'own_values', 'select')
    as anon_cannot_read_them,
  (select count(*) = 1 from pg_proc where proname = 'save_payslip_template_values')
    as exists_once;
