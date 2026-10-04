-- =====================================================================
-- Company profile: custom details per company, and who may edit a company's core fields
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0004. Safe to re-run.
--
-- 1. public.company_details: free-form "label: value" facts about a company (a tax office
--    reference, a contact phone number, a filing deadline...). NOT for passwords.
--
--    Who can do what, enforced here by row-level security:
--      * Admins of the company: read, add, change and remove every detail.
--      * Other members (viewers): read the details that are NOT marked sensitive.
--        A row with is_sensitive = true is invisible to them: not its value, not its label,
--        not even that it exists.
--      * Everyone else: nothing.
--
-- 2. public.companies: admins may now change only the name, address and VAT from the
--    dashboard. The BRN can no longer be changed through the API at all, because imports are
--    matched to a company by BRN; change it here in the SQL editor if you ever need to.
--    (Before this migration an admin could update any column of their company.)
--
-- Deleting a company (delete_company, migration 0004) needs no change: these rows reference
-- the company with ON DELETE CASCADE and go with it.
-- =====================================================================

-- ---------- shared: keep updated_at current ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- A trigger function is never called directly.
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------- table ----------
create table if not exists public.company_details (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  label         text not null
                check (label = btrim(label) and char_length(label) between 1 and 80),
  value         text check (value is null or char_length(value) <= 2000),
  field_type    text not null default 'text'
                check (field_type in ('text', 'link', 'email', 'phone', 'date', 'number')),
  is_sensitive  boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, label)
);

create index if not exists company_details_company_order_idx
  on public.company_details (company_id, sort_order);

drop trigger if exists company_details_set_updated_at on public.company_details;
create trigger company_details_set_updated_at
  before update on public.company_details
  for each row execute function public.set_updated_at();

-- ---------- row level security ----------
alter table public.company_details enable row level security;

drop policy if exists "company_details_select" on public.company_details;
drop policy if exists "company_details_insert" on public.company_details;
drop policy if exists "company_details_update" on public.company_details;
drop policy if exists "company_details_delete" on public.company_details;

-- Admins see everything; other members only what is not sensitive.
create policy "company_details_select" on public.company_details
  for select to authenticated
  using (
    public.is_company_admin(company_id)
    or (not is_sensitive and public.is_company_member(company_id))
  );

create policy "company_details_insert" on public.company_details
  for insert to authenticated
  with check (public.is_company_admin(company_id));

create policy "company_details_update" on public.company_details
  for update to authenticated
  using (public.is_company_admin(company_id))
  with check (public.is_company_admin(company_id));

create policy "company_details_delete" on public.company_details
  for delete to authenticated
  using (public.is_company_admin(company_id));

-- ---------- grants: logged-in users only, nothing for anon ----------
revoke all on public.company_details from anon;
grant select, insert, update, delete on public.company_details to authenticated;
revoke truncate, references, trigger on public.company_details from anon, authenticated;

-- ---------- companies: the BRN is no longer editable through the API ----------
-- Replace the table-wide UPDATE grant from 0001 with one limited to three columns.
-- The existing "companies_update" policy still requires the caller to be an admin.
revoke update on public.companies from authenticated;
grant update (name, address, vat) on public.companies to authenticated;

-- Ask the Data API to pick up the new table straight away.
notify pgrst, 'reload schema';
