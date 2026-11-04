-- =====================================================================
-- Companies from an Excel file: create ONE company with all its details, all of it or nothing
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0021 (and 0022 when it is run; this file does not depend on it).
-- Safe to re-run.
-- Undo (only if asked): supabase/undo/0023_create_company_with_details_undo.sql
--
-- Nothing that exists is changed: no table, column, row, policy, grant or function. This file
-- only ADDS one function.
--
-- public.create_company_with_details: what the dashboard's "Import companies from Excel" saves
-- for one row of the file, in ONE transaction, so a company is created fully or not at all:
--
--   1. The company, through public.create_company (migration 0003) with all its rules: the caller
--      must already be an admin of at least one company, and becomes the new company's admin.
--      The BRN is stored in capitals with every space removed, and must be letters and digits
--      only. Before that, it is refused as PH_DUPLICATE_BRN when a company already has the same
--      BRN with capitals and spaces ignored (create_company itself ignores only capitals and the
--      spaces around it).
--   2. Its Company profile details (public.company_details, migration 0005), each a label and a
--      text value, not sensitive. There is no function for those; this one writes them itself,
--      with the same limits as the table.
--   3. Its MRA details, through public.save_mra_company_details (migration 0020), when any of
--      them is given.
--   4. Its column setup, through public.attach_payroll_company (migration 0013), when a shared
--      setup is named: attached with no columns of its own yet.
--   5. The MRA templates named, each through public.attach_mra_template (migration 0020), with no
--      values of its own yet: shared, as MRA Returns' "Use them for all my companies" does.
--
--   If anything fails, nothing of that company is stored. Other rows of the file are separate
--   calls and are not affected.
--
--   SECURITY DEFINER, like the functions it calls: the details of a company that does not exist
--   yet when the call starts are written here, in the same transaction. It checks who is calling
--   first, before any input is looked at, and each function it calls applies its own rules again. search_path = '' and
--   fully qualified names, so nothing can be shadowed.
--
-- Errors the dashboard recognises (message prefix), as in 0003, 0013 and 0020:
--   PH_NOT_SIGNED_IN, PH_NOT_ADMIN, PH_DUPLICATE_BRN, PH_INVALID_INPUT, PH_NOT_FOUND,
--   PH_TOO_LARGE, PH_LIMIT, PH_DUPLICATE_NAME
-- =====================================================================

create or replace function public.create_company_with_details(
  p_name              text,
  p_brn               text,
  p_address           text,
  p_vat               text,
  p_details           jsonb,
  p_mra               jsonb,
  p_shared_setup_id   uuid,
  p_mra_template_ids  uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_brn      text := upper(regexp_replace(coalesce(p_brn, ''), '\s', '', 'g'));
  v_company  public.companies%rowtype;
  v_detail   jsonb;
  v_label    text;
  v_value    text;
  v_labels   text[] := array[]::text[];
  v_order    integer := 0;
  v_template uuid;
begin
  -- ---------- who is calling: first, before any input is looked at ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.company_members m
    where m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- ---------- input checks (the dashboard checks first; this is the backstop) ----------
  if v_brn = '' then
    raise exception 'PH_INVALID_INPUT: the BRN is required' using errcode = '22023';
  end if;
  if v_brn !~ '^[A-Z0-9]+$' then
    raise exception 'PH_INVALID_INPUT: the BRN must be letters and digits only'
      using errcode = '22023';
  end if;

  if p_details is null or jsonb_typeof(p_details) <> 'array' then
    raise exception 'PH_INVALID_INPUT: the details must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_details) > 50 then
    raise exception 'PH_INVALID_INPUT: at most 50 details' using errcode = '22023';
  end if;
  for v_detail in select value from jsonb_array_elements(p_details) loop
    if jsonb_typeof(v_detail) <> 'object'
       or jsonb_typeof(v_detail -> 'label') is distinct from 'string'
       or jsonb_typeof(v_detail -> 'value') is distinct from 'string' then
      raise exception 'PH_INVALID_INPUT: a detail must have a label and a value'
        using errcode = '22023';
    end if;
    v_label := btrim(v_detail ->> 'label');
    v_value := btrim(v_detail ->> 'value');
    if char_length(v_label) not between 1 and 80 or char_length(v_value) not between 1 and 2000 then
      raise exception 'PH_INVALID_INPUT: a detail''s label must be 1 to 80 characters and its value 1 to 2000'
        using errcode = '22023';
    end if;
    if lower(v_label) = any (v_labels) then
      raise exception 'PH_INVALID_INPUT: two details have the same label' using errcode = '22023';
    end if;
    v_labels := v_labels || lower(v_label);
  end loop;

  if p_mra is not null and jsonb_typeof(p_mra) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the MRA details must be an object' using errcode = '22023';
  end if;

  if coalesce(cardinality(p_mra_template_ids), 0) > 20 then
    raise exception 'PH_LIMIT' using errcode = '54000';
  end if;

  -- ---------- the BRN must be new, capitals and every space ignored ----------
  if exists (
    select 1 from public.companies c
    where upper(regexp_replace(c.brn, '\s', '', 'g')) = v_brn
  ) then
    raise exception 'PH_DUPLICATE_BRN' using errcode = '23505';
  end if;

  -- ---------- 1. the company, and the caller as its admin ----------
  select * into v_company from public.create_company(p_name, p_address, v_brn, p_vat);

  -- ---------- 2. its Company profile details ----------
  for v_detail in select value from jsonb_array_elements(p_details) loop
    insert into public.company_details (company_id, label, value, field_type, is_sensitive, sort_order)
    values (
      v_company.id, btrim(v_detail ->> 'label'), btrim(v_detail ->> 'value'), 'text', false, v_order
    );
    v_order := v_order + 1;
  end loop;

  -- ---------- 3. its MRA details, when any is given ----------
  if p_mra is not null and (
       coalesce(btrim(p_mra ->> 'ern'), '') <> ''
       or coalesce(btrim(p_mra ->> 'telephone'), '') <> ''
       or coalesce(btrim(p_mra ->> 'mobile'), '') <> ''
       or coalesce(btrim(p_mra ->> 'declarant'), '') <> ''
     ) then
    perform public.save_mra_company_details(
      v_company.id,
      p_mra ->> 'ern',
      p_mra ->> 'telephone',
      p_mra ->> 'mobile',
      p_mra ->> 'declarant',
      0
    );
  end if;

  -- ---------- 4. its column setup ----------
  if p_shared_setup_id is not null then
    perform public.attach_payroll_company(
      v_company.id, p_shared_setup_id, '{"columns": [], "customFields": []}'::jsonb
    );
  end if;

  -- ---------- 5. the MRA templates ----------
  foreach v_template in array coalesce(p_mra_template_ids, array[]::uuid[]) loop
    perform public.attach_mra_template(v_template, v_company.id, '{}'::jsonb);
  end loop;

  return jsonb_build_object(
    'id',         v_company.id,
    'name',       v_company.name,
    'address',    v_company.address,
    'brn',        v_company.brn,
    'vat',        v_company.vat,
    'details',    v_order,
    'setup',      p_shared_setup_id is not null,
    'templates',  coalesce(cardinality(p_mra_template_ids), 0)
  );
end;
$$;

-- Only logged-in users may call it. The function itself then requires an existing admin.
revoke all on function public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])
  from public, anon;
grant execute on function public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])
  to authenticated;

-- Ask the Data API to pick up the new function straight away.
notify pgrst, 'reload schema';

-- ---------- verification ----------
-- The result of running this file is the one row below. Every column should be true.
select
  (select count(*) = 1 from pg_proc where proname = 'create_company_with_details')
    as function_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])'::regprocedure)
    as function_is_definer_with_empty_search_path,
  (has_function_privilege('authenticated',
     'public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])', 'execute')
   and not has_function_privilege('anon',
     'public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])', 'execute'))
    as signed_in_only_can_call_it,
  (select p.prosrc like '%public.create_company(%'
          and p.prosrc like '%public.save_mra_company_details(%'
          and p.prosrc like '%public.attach_payroll_company(%'
          and p.prosrc like '%public.attach_mra_template(%'
   from pg_proc p
   where p.oid = 'public.create_company_with_details(text, text, text, text, jsonb, jsonb, uuid, uuid[])'::regprocedure)
    as uses_the_existing_functions,
  (not has_table_privilege('authenticated', 'public.companies', 'insert, delete, truncate')
   and not has_table_privilege('authenticated', 'public.company_members',
                               'insert, update, delete, truncate'))
    as companies_and_members_still_have_no_write_grant;
