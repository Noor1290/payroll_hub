-- =====================================================================
-- A new shared column setup needs an admin of at least one company
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0015. Safe to re-run.
--
-- It replaces ONE function, public.save_payroll_shared_setup, with the same function (same
-- name, arguments, result and grants) plus one rule. No table, column, row or policy is changed,
-- and no other function.
--
-- Why: until now any signed-in user could CREATE a new shared setup, even someone who belongs
-- to no company (migration 0013: "before any company is attached, its creator" may change it).
-- Such a setup could not reach any company (attaching one needs an admin of that company), but
-- it was a write that a stranger to every company could make, as often as they liked.
--
-- The rule: a save that creates a setup (expected revision 0) is refused with PH_NOT_ADMIN
-- unless the caller is an admin of at least one company. It is checked first, before the
-- input, and again just before the setup is stored. Everything else is exactly as in 0013:
--   * changing an existing setup still needs an admin of every attached company, or its
--     creator while nothing is attached;
--   * the first company is still made in the SQL editor with its admin, who can then create the
--     first setup and attach the company;
--   * save_payroll_key_change (0014), which calls this function for existing setups only, is
--     unchanged.
-- The two added blocks are marked "0016" inside the function; a test checks that removing them
-- gives back the 0013 function exactly.
-- =====================================================================

create or replace function public.save_payroll_shared_setup(
  p_setup_id          uuid,
  p_name              text,
  p_body              jsonb,
  p_expected_revision integer,
  p_companies         jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := (select auth.uid());
  v_name      text := btrim(coalesce(p_name, ''));
  v_companies jsonb := coalesce(p_companies, '[]'::jsonb);
  v_setup     public.payroll_shared_setups%rowtype;
  v_company   public.payroll_company_setups%rowtype;
  v_item      jsonb;
  v_item_id   uuid;
  v_saved     jsonb := '[]'::jsonb;
begin
  -- ---------- who is calling ----------
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- ---------- 0016: creating a setup needs an admin of at least one company ----------
  -- Decided from who is calling alone, before the input is looked at and without looking for
  -- the setup, so someone who may not create one learns nothing more. A change of an
  -- existing setup (expected revision 1 or more) is not affected.
  if p_expected_revision = 0 and not exists (
    select 1 from public.company_members m where m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;
  -- ---------- end of 0016 ----------

  -- ---------- input checks (the dashboard validates first; this is the backstop) ----------
  if p_setup_id is null then
    raise exception 'PH_INVALID_INPUT: the setup id is missing' using errcode = '22023';
  end if;

  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'PH_INVALID_INPUT: the setup name must be 1 to 80 characters'
      using errcode = '22023';
  end if;

  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the setup body must be a JSON object' using errcode = '22023';
  end if;

  if octet_length(p_body::text) > 262144 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  if jsonb_typeof(v_companies) <> 'array' then
    raise exception 'PH_INVALID_INPUT: the company setups must be a list of at most 200'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_companies) > 200 then
    raise exception 'PH_INVALID_INPUT: the company setups must be a list of at most 200'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(v_companies) loop
    -- Written with "is distinct from" and coalesce: a missing key must fail the check, not
    -- slip through it as null.
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item -> 'company_id') is distinct from 'string'
       or coalesce(v_item ->> 'company_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_item -> 'body') is distinct from 'object'
       or jsonb_typeof(v_item -> 'expected_revision') is distinct from 'number'
       or coalesce(v_item ->> 'expected_revision', '') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'PH_INVALID_INPUT: a company setup is missing its company, body or last revision seen'
        using errcode = '22023';
    end if;
    if octet_length((v_item -> 'body')::text) > 262144 then
      raise exception 'PH_TOO_LARGE' using errcode = '54000';
    end if;
  end loop;

  if (select count(distinct value ->> 'company_id') from jsonb_array_elements(v_companies))
     <> jsonb_array_length(v_companies) then
    raise exception 'PH_INVALID_INPUT: a company is named twice' using errcode = '22023';
  end if;

  -- One save at a time per shared setup. Attaching a company takes the same lock, so the
  -- companies attached cannot change while this decides who may save.
  select * into v_setup
  from public.payroll_shared_setups s
  where s.id = p_setup_id
  for update;

  if not found then
    -- ---------- a new shared setup ----------
    if p_expected_revision <> 0 then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;
    -- Nothing is attached to a setup that does not exist yet.
    if jsonb_array_length(v_companies) > 0 then
      raise exception 'PH_INVALID_INPUT: a new setup has no companies yet' using errcode = '22023';
    end if;

    -- ---------- 0016: checked again where the setup is created ----------
    if not exists (
      select 1 from public.company_members m where m.user_id = v_user and m.role = 'admin'
    ) then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;
    -- ---------- end of 0016 ----------

    begin
      insert into public.payroll_shared_setups (
        id, name, body, revision, created_by, created_at, updated_by, updated_at
      )
      values (p_setup_id, v_name, p_body, 1, v_user, now(), v_user, now())
      returning * into v_setup;
    exception when unique_violation then
      -- Created by someone else in the same moment.
      raise exception 'PH_STALE' using errcode = 'P0001';
    end;
  else
    -- ---------- an existing shared setup ----------
    -- Someone who cannot even read it is told it does not exist.
    if not public.can_read_payroll_shared_setup(p_setup_id) then
      raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- The change reaches every attached company: the caller must be an admin of all of them.
    if not public.can_change_payroll_shared_setup(p_setup_id) then
      raise exception 'PH_NOT_ADMIN' using errcode = '42501';
    end if;

    -- Someone else saved since the caller loaded it (or this very save already went
    -- through): refuse, never overwrite.
    if v_setup.revision <> p_expected_revision then
      raise exception 'PH_STALE' using errcode = 'P0001';
    end if;

    update public.payroll_shared_setups s
       set name       = v_name,
           body       = p_body,
           revision   = s.revision + 1,
           updated_by = v_user,
           updated_at = now()
     where s.id = v_setup.id
    returning * into v_setup;

    -- ---------- the company setups saved with it ----------
    for v_item in select value from jsonb_array_elements(v_companies) loop
      v_item_id := (v_item ->> 'company_id')::uuid;

      select * into v_company
      from public.payroll_company_setups cs
      where cs.company_id = v_item_id and cs.shared_setup_id = p_setup_id
      for update;

      -- Only companies attached to THIS setup.
      if not found then
        raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
      end if;

      if v_company.revision <> (v_item ->> 'expected_revision')::integer then
        raise exception 'PH_STALE' using errcode = 'P0001';
      end if;

      update public.payroll_company_setups cs
         set body       = v_item -> 'body',
             revision   = cs.revision + 1,
             updated_by = v_user,
             updated_at = now()
       where cs.company_id = v_company.company_id
      returning * into v_company;

      insert into public.payroll_company_setup_history (
        company_id, revision, shared_setup_id, body, saved_by, saved_at
      )
      values (
        v_company.company_id, v_company.revision, v_company.shared_setup_id, v_company.body,
        v_user, v_company.updated_at
      );

      v_saved := v_saved || jsonb_build_object(
        'company_id', v_company.company_id,
        'revision',   v_company.revision
      );
    end loop;
  end if;

  -- ---------- keep this revision: every one, none dropped ----------
  insert into public.payroll_shared_setup_history (
    shared_setup_id, revision, name, body, saved_by, saved_at
  )
  values (v_setup.id, v_setup.revision, v_setup.name, v_setup.body, v_user, v_setup.updated_at);

  -- What was stored, without the bodies.
  return jsonb_build_object(
    'shared_setup_id', v_setup.id,
    'name',            v_setup.name,
    'revision',        v_setup.revision,
    'updated_at',      v_setup.updated_at,
    'companies',       v_saved
  );
end;
$$;

revoke all on function public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)
  from public, anon;
grant execute on function public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)
  to authenticated;

-- ---------- verification: one row, every column true ----------
select
  (select count(*) = 1 from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_payroll_shared_setup')
    as exists_once,
  (to_regprocedure('public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)') is not null)
    as same_arguments,
  (select p.prorettype = 'jsonb'::regtype and p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)'::regprocedure)
    as definer_with_empty_search_path,
  (has_function_privilege('authenticated',
     'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)', 'execute')
   and not has_function_privilege('anon',
     'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)', 'execute'))
    as signed_in_only_can_call_it,
  (select p.prosrc like '%p_expected_revision = 0 and not exists%'
          and p.prosrc like '%m.role = ''admin''%'
   from pg_proc p
   where p.oid = 'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)'::regprocedure)
    as creating_needs_an_admin,
  (select p.prosrc like '%can_read_payroll_shared_setup(p_setup_id)%'
          and p.prosrc like '%can_change_payroll_shared_setup(p_setup_id)%'
          and p.prosrc like '%insert into public.payroll_shared_setup_history%'
   from pg_proc p
   where p.oid = 'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)'::regprocedure)
    as changing_a_setup_unchanged;
