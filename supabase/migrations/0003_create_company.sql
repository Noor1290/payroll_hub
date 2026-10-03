-- =====================================================================
-- Create a company from the dashboard
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001 and 0002. Safe to re-run (create or replace).
--
-- What it allows: a user who is ALREADY an admin of at least one company can create another
-- company, and becomes its admin. Nobody else can: not a viewer, not a signed-in user with no
-- company, not an anonymous visitor. The very first company (and its first admin) is still
-- created by hand in this SQL editor, as described at the end of 0001.
--
-- Why a function, and why SECURITY DEFINER:
--   * There is deliberately no INSERT policy or grant on public.companies, and none on
--     public.company_members. This migration does not add any. Creating a company therefore
--     has to go through this one function, which runs with its owner's rights and applies the
--     rule above itself.
--   * The company and the caller's admin membership are inserted in the same function body,
--     which is one transaction: you never get a company nobody can see, or a membership for a
--     company that does not exist.
--   * search_path = '' and fully qualified names, so nothing can be shadowed.
--   * Only logged-in users may call it; nothing is granted to anon or public.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN   no logged-in user
--   PH_NOT_ADMIN       the caller is not an admin of any company
--   PH_DUPLICATE_BRN   a company with this BRN already exists
--   PH_INVALID_INPUT   name or BRN missing, or a value too long
--
-- Note on PH_DUPLICATE_BRN: BRNs are unique across ALL companies, so this error tells the
-- caller that the BRN is already in use even when it belongs to a company they cannot see.
-- That is inherent in BRNs being unique; nothing else about that company is revealed.
-- =====================================================================

create or replace function public.create_company(
  p_name    text,
  p_address text,
  p_brn     text,
  p_vat     text
)
returns public.companies
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_name    text := btrim(coalesce(p_name, ''));
  v_brn     text := btrim(coalesce(p_brn, ''));
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_vat     text := nullif(btrim(coalesce(p_vat, '')), '');
  v_company public.companies%rowtype;
begin
  -- ---------- who is calling ----------
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

  -- ---------- input checks (the dashboard validates first; this is the backstop) ----------
  if v_name = '' then
    raise exception 'PH_INVALID_INPUT: the company name is required' using errcode = '22023';
  end if;
  if v_brn = '' then
    raise exception 'PH_INVALID_INPUT: the BRN is required' using errcode = '22023';
  end if;
  if char_length(v_name) > 200 or char_length(v_brn) > 50
     or char_length(coalesce(v_address, '')) > 500 or char_length(coalesce(v_vat, '')) > 50 then
    raise exception 'PH_INVALID_INPUT: a value is too long' using errcode = '22023';
  end if;

  -- ---------- BRN must be new ----------
  -- Compared ignoring case and surrounding spaces, the same way the import matches a file's
  -- BRN to a company, so two companies can never both match one file.
  if exists (
    select 1 from public.companies c where upper(btrim(c.brn)) = upper(v_brn)
  ) then
    raise exception 'PH_DUPLICATE_BRN' using errcode = '23505';
  end if;

  -- ---------- create the company and make the caller its admin, together ----------
  begin
    insert into public.companies (name, address, brn, vat)
    values (v_name, v_address, v_brn, v_vat)
    returning * into v_company;
  exception when unique_violation then
    -- Someone created the same BRN between the check above and this insert.
    raise exception 'PH_DUPLICATE_BRN' using errcode = '23505';
  end;

  insert into public.company_members (company_id, user_id, role)
  values (v_company.id, v_user, 'admin');

  return v_company;
end;
$$;

-- Only logged-in users may call it. The function itself then requires an existing admin.
revoke all on function public.create_company(text, text, text, text) from public, anon;
grant execute on function public.create_company(text, text, text, text) to authenticated;

-- Ask the Data API to pick up the new function straight away.
notify pgrst, 'reload schema';
