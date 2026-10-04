-- =====================================================================
-- Links: useful web addresses per company
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0005. Safe to re-run.
--
-- public.company_links: a titled link (tax portal, bank, a shared folder...) shown as a card
-- on the dashboard's Links page for that company.
--
-- Who can do what, enforced here by row-level security:
--   * Members of the company: read its links.
--   * Admins of the company: add, change, remove and reorder them.
--   * Everyone else: nothing.
--
-- A link must start with http:// or https://, so nothing like "javascript:" can be stored.
-- The same URL cannot appear twice in one company. The dashboard tidies a URL before saving
-- (trims it, lower-cases the host, drops a trailing slash) so near-duplicates collide too.
--
-- Deleting a company (delete_company, migration 0004) needs no change: these rows reference
-- the company with ON DELETE CASCADE and go with it.
-- =====================================================================

-- Also defined in 0005; repeated so this file does not depend on it.
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

revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------- table ----------
create table if not exists public.company_links (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  title        text not null
               check (title = btrim(title) and char_length(title) between 1 and 80),
  url          text not null
               check (url ~* '^https?://' and url = btrim(url) and char_length(url) <= 2000),
  description  text check (description is null or char_length(description) <= 200),
  category     text check (category is null or char_length(category) <= 40),
  -- Names chosen from fixed lists in the dashboard. Anything it does not recognise is shown
  -- with a default icon and colour, so these are never used as code or styling.
  icon         text check (icon is null or char_length(icon) <= 40),
  accent       text check (accent is null or char_length(accent) <= 20),
  is_pinned    boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, url)
);

create index if not exists company_links_company_order_idx
  on public.company_links (company_id, sort_order);

drop trigger if exists company_links_set_updated_at on public.company_links;
create trigger company_links_set_updated_at
  before update on public.company_links
  for each row execute function public.set_updated_at();

-- ---------- row level security ----------
alter table public.company_links enable row level security;

drop policy if exists "company_links_select" on public.company_links;
drop policy if exists "company_links_insert" on public.company_links;
drop policy if exists "company_links_update" on public.company_links;
drop policy if exists "company_links_delete" on public.company_links;

create policy "company_links_select" on public.company_links
  for select to authenticated
  using (public.is_company_member(company_id));

create policy "company_links_insert" on public.company_links
  for insert to authenticated
  with check (public.is_company_admin(company_id));

create policy "company_links_update" on public.company_links
  for update to authenticated
  using (public.is_company_admin(company_id))
  with check (public.is_company_admin(company_id));

create policy "company_links_delete" on public.company_links
  for delete to authenticated
  using (public.is_company_admin(company_id));

-- ---------- grants: logged-in users only, nothing for anon ----------
revoke all on public.company_links from anon;
grant select, insert, update, delete on public.company_links to authenticated;
revoke truncate, references, trigger on public.company_links from anon, authenticated;

-- Ask the Data API to pick up the new table straight away.
notify pgrst, 'reload schema';
