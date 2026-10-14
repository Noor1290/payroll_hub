-- =====================================================================
-- Payroll column setup: one shared setup that companies are attached to, and each
-- company's own columns
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0012. Safe to re-run.
--
-- It only ADDS things (four tables, four read policies, seven functions) and replaces one
-- function, public.delete_company, with the same function plus the new tables. No existing
-- table, column or row is changed.
--
-- 1. public.payroll_shared_setups: the payroll app's shared setup, which is the identity fields,
--    which of them is the ID field, and the Global columns with their formulas, categories,
--    decimal places, value types, order and builder settings. A JSON body, written by the
--    payroll app and stored exactly as sent, and a revision number that goes up by one on
--    every save. It holds no employee and no payroll figure.
--
-- 2. public.payroll_company_setups: one row per company, naming the shared setup the company
--    is attached to (exactly one) and holding the company's own columns and its own company
--    details, again as a JSON body with a revision number.
--
-- 3. public.payroll_shared_setup_history and public.payroll_company_setup_history: EVERY
--    revision ever saved, none dropped, because a payroll month will record the revisions it
--    was saved with (Phase 3) and must always be able to find them.
--
--    Who can do what:
--      * A shared setup: read by any member of a company attached to it. Changed only by
--        someone who is an admin of EVERY company attached to it, because a change reaches
--        all of them. Before any company is attached, only the person who created it can
--        read or change it.
--      * A company's own setup: read by the company's members, changed by its admins.
--      * Attaching a company: an admin of that company who may also change the shared setup.
--        A company is attached once.
--      * Nobody, through the API: insert, update or delete a row directly.
--      * Everyone else, and anonymous visitors: nothing.
--
-- 4. public.save_payroll_shared_setup: creates a shared setup (last revision seen = 0) or
--    saves over it. It can save some attached companies' own setups in the same step, all or
--    nothing (a change of a Global column's key rewrites formulas in company columns too).
--    public.save_payroll_company_setup: saves over a company's own setup.
--    public.attach_payroll_company: attaches a company to a shared setup, with its own setup.
--    Every save names the revision the caller last saw; if someone else saved since, it is
--    refused instead of overwriting their work.
--
--    public.can_read_payroll_shared_setup, public.can_change_payroll_shared_setup and
--    public.payroll_shared_setup_access answer the rules above for the signed-in user. The
--    third is what the dashboard asks so the app can show the Global columns read-only.
--
--    All are SECURITY DEFINER: the tables have no write policy or grant, and the rules look
--    at companies the caller may not be a member of, so each function applies the rules
--    itself. search_path = '' and fully qualified names, so nothing can be shadowed.
--
-- 5. public.delete_company (migration 0012) is replaced: it now also deletes the company's
--    own setup and its revisions, and the shared setup with its revisions when no other
--    company is attached to it any more. It returns their counts as
--    "payroll_company_setups", "payroll_company_setup_history", "payroll_shared_setups" and
--    "payroll_shared_setup_history". Nothing else about it changes. If you ever run an older
--    delete_company file again after this one, run this file again too.
--
-- Limits: a name is 1 to 80 characters; a body is a JSON object of at most 256 KB; one save
-- of a shared setup carries at most 200 company setups.
--
-- Errors the dashboard recognises (message prefix):
--   PH_NOT_SIGNED_IN      no logged-in user
--   PH_NOT_ADMIN          the caller may not make this change
--   PH_NOT_FOUND          there is no such setup (or the caller cannot see it)
--   PH_INVALID_INPUT      something is missing or malformed
--   PH_TOO_LARGE          a body is larger than 256 KB
--   PH_STALE              the revision the caller last saw is not the current one
--   PH_ALREADY_ATTACHED   the company already has a setup
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.payroll_shared_setups (
  -- Chosen by the app, so a save that is sent twice cannot make two setups.
  id          uuid primary key,
  name        text not null
              check (name = btrim(name) and char_length(name) between 1 and 80),
  body        jsonb not null
              check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 262144),
  revision    integer not null check (revision >= 1),
  -- Become empty if that user account is ever removed; the row itself stays.
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.payroll_shared_setup_history (
  shared_setup_id  uuid not null references public.payroll_shared_setups(id) on delete cascade,
  revision         integer not null check (revision >= 1),
  name             text not null,
  body             jsonb not null,
  saved_by         uuid references auth.users(id) on delete set null,
  saved_at         timestamptz not null default now(),
  primary key (shared_setup_id, revision)
);

create table if not exists public.payroll_company_setups (
  company_id       uuid primary key references public.companies(id) on delete cascade,
  shared_setup_id  uuid not null references public.payroll_shared_setups(id) on delete restrict,
  body             jsonb not null
                   check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 262144),
  revision         integer not null check (revision >= 1),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);

create index if not exists payroll_company_setups_shared_idx
  on public.payroll_company_setups (shared_setup_id);

create table if not exists public.payroll_company_setup_history (
  company_id       uuid not null references public.companies(id) on delete cascade,
  revision         integer not null check (revision >= 1),
  -- Which shared setup the company was attached to when this revision was saved.
  shared_setup_id  uuid not null references public.payroll_shared_setups(id) on delete restrict,
  body             jsonb not null,
  saved_by         uuid references auth.users(id) on delete set null,
  saved_at         timestamptz not null default now(),
  primary key (company_id, revision)
);

-- ---------- who may read or change a shared setup ----------
-- SECURITY DEFINER because the answer depends on companies the caller may not be a member
-- of (they are attached all the same). Each answers only true or false, about the caller.

-- A member of at least one attached company; or, while no company is attached, its creator.
create or replace function public.can_read_payroll_shared_setup(p_setup_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1
      from public.payroll_company_setups cs
      join public.company_members m on m.company_id = cs.company_id
      where cs.shared_setup_id = p_setup_id and m.user_id = (select auth.uid())
    )
    or (
      not exists (select 1 from public.payroll_company_setups cs where cs.shared_setup_id = p_setup_id)
      and exists (
        select 1 from public.payroll_shared_setups s
        where s.id = p_setup_id and s.created_by = (select auth.uid())
      )
    )
  );
$$;

-- An admin of EVERY attached company; or, while no company is attached, its creator.
create or replace function public.can_change_payroll_shared_setup(p_setup_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (select 1 from public.payroll_shared_setups s where s.id = p_setup_id)
    and case
      when exists (select 1 from public.payroll_company_setups cs where cs.shared_setup_id = p_setup_id)
      then not exists (
        select 1
        from public.payroll_company_setups cs
        where cs.shared_setup_id = p_setup_id
          and not exists (
            select 1 from public.company_members m
            where m.company_id = cs.company_id
              and m.user_id = (select auth.uid())
              and m.role = 'admin'
          )
      )
      else exists (
        select 1 from public.payroll_shared_setups s
        where s.id = p_setup_id and s.created_by = (select auth.uid())
      )
    end;
$$;

-- What the app shows: whether the caller may change it, how many companies are attached, and
-- of how many of those the caller is an admin. Counts only, never which companies. Someone
-- who may not read the setup gets false and zeros, as for a setup that does not exist.
create or replace function public.payroll_shared_setup_access(p_setup_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.can_read_payroll_shared_setup(p_setup_id) then jsonb_build_object(
      'can_change', public.can_change_payroll_shared_setup(p_setup_id),
      'companies', (
        select count(*) from public.payroll_company_setups cs where cs.shared_setup_id = p_setup_id
      ),
      'admin_of', (
        select count(*)
        from public.payroll_company_setups cs
        join public.company_members m on m.company_id = cs.company_id
        where cs.shared_setup_id = p_setup_id
          and m.user_id = (select auth.uid())
          and m.role = 'admin'
      )
    )
    else jsonb_build_object('can_change', false, 'companies', 0, 'admin_of', 0)
  end;
$$;

revoke all on function public.can_read_payroll_shared_setup(uuid) from public, anon;
revoke all on function public.can_change_payroll_shared_setup(uuid) from public, anon;
revoke all on function public.payroll_shared_setup_access(uuid) from public, anon;
grant execute on function public.can_read_payroll_shared_setup(uuid) to authenticated;
grant execute on function public.can_change_payroll_shared_setup(uuid) to authenticated;
grant execute on function public.payroll_shared_setup_access(uuid) to authenticated;

-- ---------- row level security: read policies only ----------
alter table public.payroll_shared_setups         enable row level security;
alter table public.payroll_shared_setup_history  enable row level security;
alter table public.payroll_company_setups        enable row level security;
alter table public.payroll_company_setup_history enable row level security;

drop policy if exists "payroll_shared_setups_select" on public.payroll_shared_setups;
create policy "payroll_shared_setups_select" on public.payroll_shared_setups
  for select to authenticated
  using (public.can_read_payroll_shared_setup(id));

drop policy if exists "payroll_shared_setup_history_select" on public.payroll_shared_setup_history;
create policy "payroll_shared_setup_history_select" on public.payroll_shared_setup_history
  for select to authenticated
  using (public.can_read_payroll_shared_setup(shared_setup_id));

drop policy if exists "payroll_company_setups_select" on public.payroll_company_setups;
create policy "payroll_company_setups_select" on public.payroll_company_setups
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists "payroll_company_setup_history_select" on public.payroll_company_setup_history;
create policy "payroll_company_setup_history_select" on public.payroll_company_setup_history
  for select to authenticated
  using (public.is_company_member(company_id));

-- ---------- grants: logged-in users may read; nothing else, and nothing for anon ----------
revoke all on table public.payroll_shared_setups         from public, anon, authenticated;
revoke all on table public.payroll_shared_setup_history  from public, anon, authenticated;
revoke all on table public.payroll_company_setups        from public, anon, authenticated;
revoke all on table public.payroll_company_setup_history from public, anon, authenticated;
grant select on table public.payroll_shared_setups         to authenticated;
grant select on table public.payroll_shared_setup_history  to authenticated;
grant select on table public.payroll_company_setups        to authenticated;
grant select on table public.payroll_company_setup_history to authenticated;

-- ---------- create the shared setup, or save over it ----------
-- p_companies: attached companies whose own setups change in the same step, as
--   [{ "company_id": "...", "body": { ... }, "expected_revision": 3 }, ...]
-- All of it is stored, or none of it.
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

-- ---------- save over a company's own setup ----------
create or replace function public.save_payroll_company_setup(
  p_company_id        uuid,
  p_body              jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_company public.payroll_company_setups%rowtype;
begin
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

  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the setup body must be a JSON object' using errcode = '22023';
  end if;

  if octet_length(p_body::text) > 262144 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'PH_INVALID_INPUT: the last revision seen is missing' using errcode = '22023';
  end if;

  -- Never while the company is being deleted.
  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  select * into v_company
  from public.payroll_company_setups cs
  where cs.company_id = p_company_id
  for update;

  if not found then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_company.revision <> p_expected_revision then
    raise exception 'PH_STALE' using errcode = 'P0001';
  end if;

  update public.payroll_company_setups cs
     set body       = p_body,
         revision   = cs.revision + 1,
         updated_by = v_user,
         updated_at = now()
   where cs.company_id = p_company_id
  returning * into v_company;

  insert into public.payroll_company_setup_history (
    company_id, revision, shared_setup_id, body, saved_by, saved_at
  )
  values (
    v_company.company_id, v_company.revision, v_company.shared_setup_id, v_company.body,
    v_user, v_company.updated_at
  );

  return jsonb_build_object(
    'company_id',      v_company.company_id,
    'shared_setup_id', v_company.shared_setup_id,
    'revision',        v_company.revision,
    'updated_at',      v_company.updated_at
  );
end;
$$;

revoke all on function public.save_payroll_company_setup(uuid, jsonb, integer) from public, anon;
grant execute on function public.save_payroll_company_setup(uuid, jsonb, integer) to authenticated;

-- ---------- attach a company to a shared setup, with its own setup ----------
create or replace function public.attach_payroll_company(
  p_company_id      uuid,
  p_shared_setup_id uuid,
  p_body            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_company public.payroll_company_setups%rowtype;
begin
  if v_user is null then
    raise exception 'PH_NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- Admin of THIS company.
  if p_company_id is null or not exists (
    select 1
    from public.company_members m
    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'
  ) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  if p_shared_setup_id is null then
    raise exception 'PH_INVALID_INPUT: the shared setup is missing' using errcode = '22023';
  end if;

  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'PH_INVALID_INPUT: the setup body must be a JSON object' using errcode = '22023';
  end if;

  if octet_length(p_body::text) > 262144 then
    raise exception 'PH_TOO_LARGE' using errcode = '54000';
  end if;

  -- The shared setup first, then the company: the same order as every other save here.
  perform 1 from public.payroll_shared_setups s where s.id = p_shared_setup_id for update;
  if not found or not public.can_read_payroll_shared_setup(p_shared_setup_id) then
    raise exception 'PH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Attaching a company gives its admins a say over the shared setup's other companies and
  -- puts the shared setup's rules on this one: it needs the right to change the shared setup.
  if not public.can_change_payroll_shared_setup(p_shared_setup_id) then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  perform 1 from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'PH_NOT_ADMIN' using errcode = '42501';
  end if;

  -- A company has exactly one setup. Attaching twice is refused, never a second row.
  if exists (select 1 from public.payroll_company_setups cs where cs.company_id = p_company_id) then
    raise exception 'PH_ALREADY_ATTACHED' using errcode = '23505';
  end if;

  insert into public.payroll_company_setups (
    company_id, shared_setup_id, body, revision, created_by, created_at, updated_by, updated_at
  )
  values (p_company_id, p_shared_setup_id, p_body, 1, v_user, now(), v_user, now())
  returning * into v_company;

  insert into public.payroll_company_setup_history (
    company_id, revision, shared_setup_id, body, saved_by, saved_at
  )
  values (
    v_company.company_id, v_company.revision, v_company.shared_setup_id, v_company.body,
    v_user, v_company.updated_at
  );

  return jsonb_build_object(
    'company_id',      v_company.company_id,
    'shared_setup_id', v_company.shared_setup_id,
    'revision',        v_company.revision,
    'updated_at',      v_company.updated_at
  );
end;
$$;

revoke all on function public.attach_payroll_company(uuid, uuid, jsonb) from public, anon;
grant execute on function public.attach_payroll_company(uuid, uuid, jsonb) to authenticated;

-- ---------- delete_company: as in 0012, plus the payroll setups ----------
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
  -- a save of rates or of a template, an issue of payslips, another delete) can change it or
  -- what belongs to it meanwhile.
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
  (select bool_and(c.relrowsecurity) and count(*) = 4
   from pg_class c
   where c.oid in ('public.payroll_shared_setups'::regclass,
                   'public.payroll_shared_setup_history'::regclass,
                   'public.payroll_company_setups'::regclass,
                   'public.payroll_company_setup_history'::regclass))
    as row_security_on_all_four,
  (select count(*) = 4 and bool_and(cmd = 'SELECT' and roles = '{authenticated}')
   from pg_policies
   where schemaname = 'public'
     and tablename in ('payroll_shared_setups', 'payroll_shared_setup_history',
                       'payroll_company_setups', 'payroll_company_setup_history'))
    as only_read_policies,
  (select count(*) = 2 and bool_and(qual like '%can_read_payroll_shared_setup(%')
   from pg_policies
   where schemaname = 'public'
     and tablename in ('payroll_shared_setups', 'payroll_shared_setup_history'))
    as shared_read_by_attached_members,
  (select count(*) = 2 and bool_and(qual like '%is_company_member(%')
   from pg_policies
   where schemaname = 'public'
     and tablename in ('payroll_company_setups', 'payroll_company_setup_history'))
    as company_read_by_members,
  (select bool_and(has_table_privilege('authenticated', t, 'select'))
   from unnest(array['public.payroll_shared_setups', 'public.payroll_shared_setup_history',
                     'public.payroll_company_setups', 'public.payroll_company_setup_history']) t)
    as signed_in_can_read,
  (select bool_and(not has_table_privilege('authenticated', t,
                     'insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.payroll_shared_setups', 'public.payroll_shared_setup_history',
                     'public.payroll_company_setups', 'public.payroll_company_setup_history']) t)
    as signed_in_cannot_write_directly,
  (select bool_and(not has_table_privilege('anon', t,
                     'select, insert, update, delete, truncate, references, trigger'))
   from unnest(array['public.payroll_shared_setups', 'public.payroll_shared_setup_history',
                     'public.payroll_company_setups', 'public.payroll_company_setup_history']) t)
    as anon_has_nothing,
  (select count(*) = 6 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)'::regprocedure,
     'public.save_payroll_company_setup(uuid, jsonb, integer)'::regprocedure,
     'public.attach_payroll_company(uuid, uuid, jsonb)'::regprocedure,
     'public.can_read_payroll_shared_setup(uuid)'::regprocedure,
     'public.can_change_payroll_shared_setup(uuid)'::regprocedure,
     'public.payroll_shared_setup_access(uuid)'::regprocedure))
    as functions_are_definer_with_empty_search_path,
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.save_payroll_shared_setup(uuid, text, jsonb, integer, jsonb)',
     'public.save_payroll_company_setup(uuid, jsonb, integer)',
     'public.attach_payroll_company(uuid, uuid, jsonb)',
     'public.can_read_payroll_shared_setup(uuid)',
     'public.can_change_payroll_shared_setup(uuid)',
     'public.payroll_shared_setup_access(uuid)']) f)
    as signed_in_only_can_call_them,
  (select count(*) = 6 from pg_proc
   where proname in ('save_payroll_shared_setup', 'save_payroll_company_setup',
                     'attach_payroll_company', 'can_read_payroll_shared_setup',
                     'can_change_payroll_shared_setup', 'payroll_shared_setup_access'))
    as each_exists_once,
  (select p.prosecdef and p.proconfig = array['search_path=""']
          and p.prosrc like '%public.payroll_company_setup_history%'
          and p.prosrc like '%public.payroll_company_setups%'
          and p.prosrc like '%public.payroll_shared_setups%'
          and p.prosrc like '%public.pdf_template_history%'
          and p.prosrc like '%public.issued_payslips%'
   from pg_proc p where p.oid = 'public.delete_company(uuid, text)'::regprocedure)
    as delete_company_updated,
  (has_function_privilege('authenticated', 'public.delete_company(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_company(uuid, text)', 'execute'))
    as delete_company_still_signed_in_only;
