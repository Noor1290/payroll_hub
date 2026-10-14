# Migration plan: from browser storage to Supabase

13 October 2026, third version: every open point of the second version (12 October) is now decided, see section 4. The live Supabase project was not contacted: every measurement and test below ran on this machine with fake data, with all outside requests blocked (0 were attempted). This file is kept in `payroll_hub/docs/`, next to `FUTURE_WORK.md`, whose section 3 is its summary.

Covers `Payroll_sys` (payroll), `PDF Editor` (PDF form filler), `payslip` and `payroll_hub` (the dashboard).

## In short

- Today the payroll app and the PDF form filler keep everything in one browser's storage. The payslip app keeps nothing in the browser. The dashboard keeps only preferences there; its data is in Supabase.
- Payroll data is small (400 employees for 12 months is about a fifth of the storage). PDF files are what fill it: one 3.8 MB form uses all of it. The bigger problem is that the data exists in one browser only, with no backup.
- Route: the apps stay frontend-only and never talk to Supabase. Saving and loading goes through the dashboard and the bridge, as the payslip app already does. Opened on their own, the apps keep working from browser storage exactly as today.
- **Order (decided):** (1) PDF templates, with the PDF files in a Storage bucket; (2) payroll column setup and companies; (3) payroll monthly data. A short Phase 0 comes first.
- **Saving (decided):** automatic inside the dashboard. No "Save to cloud" or "Load from cloud" buttons. Existing browser data is imported once.
- **Global columns (decided):** they keep working as now: one shared setup, and a change reaches every company. It is stored as a record of its own that companies are attached to (section 5.3).
- **Tested:** typing inside an app's frame did NOT stop the dashboard's sign-out for inactivity. The fix is the `activity` message (section 5.8, step 0c).
- **The password gate (decided 13 October):** it locks after 10 minutes without activity (up to 30 in Settings), not 10 minutes after unlocking, and work inside an app counts as activity (section 5.8).
- **Nothing is left to confirm.** Every decision is in section 4.
- **Phase 0 is built** (13 October 2026): the backup files, the storage interfaces, the `activity` message and the gate. What was built, and what it leaves for Phase 1, is in section 5.11. No migration was needed.
- **Phase 2 is built** (14 October 2026), not merged: migration 0013 (not run yet), the `payroll-setup` data type, and the payroll app's setup in the dashboard with its import. Section 5.14.

## 1. Where each app saves its data today

Confirmed by reading the code and by running each app with fake data and listing what it stored.

### Payroll_sys: browser localStorage only

| What | Key | Notes |
|---|---|---|
| Identity fields, which one is the ID field, Global columns (with their formulas), every company (name, its own columns and formulas, column widths, the month being viewed, details: address, BRN, custom fields), the selected company | `payroll_app_state_v1` | One key for everything. Rewritten in full on every change |
| One month of employees for one company | `payroll_period_<company id>_<YYYY-MM>` | `{ employees: [{ id, values }] }`, `values` keyed by column key. One key per company per month. Rewritten in full on every change, with no delay |
| Light or dark theme | `payroll_theme` | Only once the theme has been switched |

No sessionStorage, no Supabase. Code: `src/lib/storage.js`, `src/lib/theme.js`. The only thing that leaves the browser is "Send to dashboard" (the month's results) and the file exports.

### PDF Editor: browser localStorage only

| What | Key | Notes |
|---|---|---|
| Every template: name, PDF file name, **the PDF itself as text**, the fields (position, size, font, alignment, colour, type), the company details of that template (employer fields), the values last typed, and the People list | `pdf-editor:templates` | One key holds all templates and all PDFs. Rewritten in full on every save |
| Company details from before they became per-template | `pdf-editor:employer-fields`, and older still `pdf-editor:employer-profile`, `pdf-editor:employer-field-labels` | Read only, offered once as "copy my existing company details". Nothing writes them any more |
| Light or dark theme | `pdf-editor:theme` | |

No sessionStorage, no Supabase. Code: `src/lib/template.ts`, `src/lib/employerProfile.ts`, `src/lib/theme.ts`.

### payslip: nothing in the browser; Supabase through the dashboard

Measured: 0 keys in localStorage and 0 in sessionStorage. The app has no Supabase code. It asks the dashboard over the bridge, and the dashboard reads and writes:

| What | Tables | Written only through |
|---|---|---|
| Templates (a draft and published versions) | `payslip_templates`, `payslip_template_versions` | `save_payslip_template_draft`, `publish_payslip_template` (migration 0010) |
| Issued payslips | `issued_payslips` | `issue_payslips`; read with `issued_payslips_for_month` (migration 0011) |
| Statutory rates (cross-check only) | `statutory_rates` | `save_statutory_rates` (migration 0009) |

### payroll_hub: Supabase for data, browser for preferences

Supabase tables (migrations 0001 to 0011): `companies`, `company_members`, `employees`, `payroll_runs`, `payroll_entries`, `company_details`, `company_links`, `statutory_rates`, `payslip_templates`, `payslip_template_versions`, `issued_payslips`. No Storage bucket is used today: none appears in any migration.

Browser, all keys prefixed `payroll-hub:` (code: `src/lib/storage.ts`):

| Where | Keys | Holds |
|---|---|---|
| localStorage | `theme`, `sidebar-collapsed`, `company`, `unlock-minutes`, `database-refresh-seconds`, `idle-minutes`, `transfer-open-after`, `mapping-templates` | Preferences. `mapping-templates` holds column names only (at most 50 saved mappings). No payroll value |
| sessionStorage | `auth` (and `demo-session` in the development demo) | The sign-in session. Gone when the browser closes |

## 2. How much browser storage each app uses now

Method: each app was started on this machine, loaded with fake data, left to save, and its storage read back (key length plus value length, in characters). The limit for the whole site in this browser is 5,242,880 characters (measured in the audit). On the deployed site all four apps share that one limit.

### Payroll_sys

Fake data: the test fixture, 3 identity fields, 14 Global columns, 7 company columns.

| Case | Characters | Share of the limit |
|---|---|---|
| Column setup and one company (`payroll_app_state_v1`) | 5,773 | 0.1% |
| The same with 5 companies | 15,533 (about 2,440 for each further company) | 0.3% |
| The fixture as it is: 1 company, 6 employees, 2 months, everything | 8,132 | 0.2% |
| One month, 10 employees | 2,391 (239 each) | |
| One month, 50 employees | 11,216 (224 each) | |
| One month, 100 employees | 22,387 (224 each) | |
| One month, 400 employees | 89,337 (223 each) | 1.7% |
| 12 months of 100 employees, everything | 274,417 | 5.2% |
| 12 months of 400 employees, everything | 1,077,817 | 20.6% |

### PDF Editor

Fake data: one template, 6 fields, 4 company details, the 983-byte test PDF.

| Case | Characters |
|---|---|
| The template with no people | 2,931 (the PDF as text: 1,312; everything else: 1,597) |
| The same with 100 people | 19,736 |
| The same with 500 people | 87,338 (about 169 per person) |

A PDF is stored as text 1.33 times the size of the file. Calculated from that, not measured: a 100 KB form takes about 136,500 characters, 300 KB about 409,600, 1,000 KB about 1,365,300, and 3,000 KB about 4,096,000 (78% of the limit). The audit measured the largest single PDF that fits, with nothing else stored, at about 3,840 KB.

### payslip and payroll_hub

| App | localStorage | sessionStorage |
|---|---|---|
| payslip | 0 keys, 0 characters | 0 keys, 0 characters |
| payroll_hub, demo mode, after signing in and switching theme and sidebar | 2 keys, 51 characters | 1 key, 25 characters (the demo flag) |

Not measured: the dashboard's real sign-in session in sessionStorage, because that needs the live project.

### What the numbers say

- Payroll data is small. Room is not the reason to move it.
- PDF files are the only thing that can fill the storage, and when they do, every app on the site is affected (audit risk R2). This is why PDF templates now go first.
- The reason to move all three is risk R3: one browser, no backup, nothing shared between two people.

## 3. Rules this plan keeps

Taken from the four `CLAUDE.md` files and `payroll_hub/docs/INTEGRATION.md`. None is changed.

- Only the dashboard talks to Supabase, with the public anon key. No service-role key anywhere. No backend.
- The apps stay frontend-only and reach the database only through the dashboard and the bridge: exact origin, never `"*"`, every message validated with Zod.
- No schema change from the browser. Each migration is a numbered SQL file for you to review and run by hand.
- Row-level security is the real protection. Members read, admins write, and writes go only through `SECURITY DEFINER` functions that check who is calling. Nothing for anonymous visitors.
- Every app keeps working on its own. Opened outside the dashboard, it behaves as today.
- Payroll values are never put in the dashboard's browser storage, URLs, logs or the transfer log.
- A new table that refers to `companies` is added to `delete_company` in the same migration.
- Fake data only in tests, samples and docs.
- Nothing is recalculated, rounded or filled in on the way. What is stored is exactly what the app sent.

## 4. Decisions

### 4.1 Decided on 12 October 2026

| # | Decision |
|---|---|
| D1 | Global columns keep working as now: one shared setup, and a change reaches every company. Not per company |
| D3, D8 | Order: PDF templates, then payroll column setup and companies, then monthly data. PDF files go in a Storage bucket. Saving is automatic, with no Save or Load buttons for the database. Existing browser data is imported once. This replaces `FUTURE_WORK.md` section 3, which is updated |
| D5 | Monthly data: admins only. The password gate must be open to load or save, with no prompt on each load. If the gate locks while someone is typing, the save is refused, nothing is stored, the figures stay marked "NOT saved", and they are saved once the dashboard is unlocked. When the gate locks: changed on 13 October, see 4.2 |
| D6 | PDF templates: the file goes to the bucket (5 MB limit), the fields and the template's company details to a table. The values last typed and the People list are not moved in this migration and stay in browser storage. Later item added: an option to clear the People list after a download (section 7) |
| Sign-out | Tested before the monthly-data phase, as asked. Result and fix: section 5.8 |

### 4.2 Decided on 13 October 2026

These were the points left "to confirm" in the second version. All are now decided.

| # | Decision |
|---|---|
| D1, how the shared setup is stored | Confirmed. The shared setup (identity fields and Global columns) is a record of its own that companies are attached to: not owned by one person, and without a general "organisation" in the dashboard (section 5.3). **Read:** any member of an attached company. **Change:** only an admin of every attached company, because the change reaches all of them |
| D2, draft and publish | Confirmed: no publish step. Every save is a kept, numbered revision, and each month records the revisions it was saved with (the shared setup's and the company's own) |
| D4, the browser copy after import | Confirmed. It is kept, untouched, as the fallback, and is what the app uses when opened on its own, under the label "This browser only. Not the dashboard's copy." Removing it is a later, separate action, only after a backup file exists |
| D7, linking companies | Confirmed, with one addition. By BRN: a browser company is linked only when a dashboard company has the same BRN and you are that company's admin. The import never creates a dashboard company. Name and address: the dashboard's values are kept, and differences are shown, never overwritten. **Added:** a manual "Link this company to..." choice for a browser company whose BRN is missing or matches nothing. It lists only the dashboard companies you are an admin of that are not linked yet, shows both BRNs side by side, and still changes nothing in the dashboard company |
| PDF templates and companies | Confirmed. A template belongs to the company selected in the dashboard, with "Copy to another company" for the same form. One shared template for several companies stays a later item (section 7) |
| Existing buttons | Confirmed. No new Save or Load buttons for the database. Buttons the apps already have ("Save template" in the field editor, "Save" in company details) stay, and inside the dashboard they save to the database. Whatever saves by itself today keeps doing so |
| The gate locking during payroll work | Confirmed. When the password gate locks, the payroll app covers the month's table with "Unlock the dashboard to continue" instead of leaving salaries on an unattended screen. What was typed stays in memory and is saved on unlocking |
| **D5, changed: when the gate locks** | The password gate locks after 10 minutes of **inactivity** (1 to 30 in Settings), not 10 minutes after unlocking. Activity is the same signal the sign-out uses: a click, a key, the wheel or a touch in the dashboard, and the `activity` message from the app that is showing (section 5.8). So it never locks while someone is actively typing in any app. Unchanged: it still locks when the tab has been hidden for more than two minutes, on "Lock now", and when the session ends |

## 5. Proposed design

### 5.1 The route

```
app (in the dashboard's frame)  <->  bridge  <->  dashboard  <->  Supabase tables and bucket
app (opened on its own)         <->  browser storage, as today
```

New bridge data types, in the order they are built. The protocol stays version 1: these are additions, as the payslip data types were.

| Phase | Data type | App | Requests | Saves (exactly one row each) | Gate |
|---|---|---|---|---|---|
| 1 | `pdf-template` | pdf-editor | `list`, `load`, `history` | `save`, `restore`, `copy-to-company` | none |
| 1 | `pdf-file` | pdf-editor | `exists`, `download` (by content hash) | `upload` | none |
| 2 | `payroll-setup` | payroll | `load` (the shared setup and every attached company you can read), `history` | `save-shared`, `save-company`, `attach-company` | none (no employee in it) |
| 3 | `payroll-month` | payroll | `list` (months that exist), `load` | `save` | open, admins only |

Same conventions as the payslip data types: every save carries `expected_revision` (and `brn` where it is about one company); refusals carry a `code` (`stale`, `forbidden`, `wrong-company`, `invalid`, `not-found`, `too-large`, `unavailable`, and `locked` for `payroll-month`); after "no answer" or `unavailable` the app reloads and compares the revision before saving again; every exchange is a row in the transfer log without values.

Limits: a template body 256 KB; a PDF 5 MB; a setup body 256 KB (the fixture's whole setup is under 6 KB); a month 1 MB (400 employees measure 89 KB).

A PDF travels as text inside one message. The dashboard checks its size, that it starts as a PDF, and that its SHA-256 hash is the one stated, before uploading. Uploading the same file twice is harmless: the hash is the file's name.

**Saving automatically.** One save goes out a moment after the last change (about a second), never one per keystroke, and never two at once for the same thing. The app always shows one of "Saved", "Saving" or "NOT saved". A refused or unanswered save follows the offline rules in section 5.7.

### 5.2 Phase 1, migration 0012: PDF templates and the bucket

Sketch, not the final file:

```sql
create table public.pdf_templates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  name           text not null check (name = btrim(name) and char_length(name) between 1 and 80),
  body           jsonb not null          -- the fields and this template's company details
                 check (jsonb_typeof(body) = 'object'
                        and octet_length(body::text) <= 262144),
  revision       integer not null check (revision >= 1),
  pdf_sha256     text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),   -- which file in the bucket
  pdf_file_name  text not null check (char_length(pdf_file_name) between 1 and 200),
  pdf_bytes      integer not null check (pdf_bytes between 1 and 5242880),
  pdf_pages      integer not null check (pdf_pages >= 1),
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (id, company_id)
);
create unique index pdf_templates_company_name_idx
  on public.pdf_templates (company_id, lower(name));

-- every save, kept behind the scenes, for "restore a previous version"
create table public.pdf_template_history (
  template_id  uuid not null,
  company_id   uuid not null references public.companies(id) on delete cascade,
  revision     integer not null,
  name         text not null,
  body         jsonb not null,
  pdf_sha256   text not null,
  saved_by     uuid references auth.users(id) on delete set null,
  saved_at     timestamptz not null default now(),
  primary key (template_id, revision),
  foreign key (template_id, company_id)
    references public.pdf_templates (id, company_id) on delete cascade
);
```

The PDF files, in a private bucket and not in a table:

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdf-forms', 'pdf-forms', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

-- A file's path is <company id>/<sha256>.pdf. This reads the company from it,
-- and answers "no company" for any path that is not shaped like that.
create or replace function public.pdf_form_company(object_name text)
returns uuid language sql immutable set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.pdf$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

create policy "pdf_forms_select" on storage.objects for select to authenticated
  using (bucket_id = 'pdf-forms' and public.is_company_member(public.pdf_form_company(name)));
create policy "pdf_forms_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'pdf-forms' and public.is_company_admin(public.pdf_form_company(name)));
create policy "pdf_forms_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'pdf-forms' and public.is_company_admin(public.pdf_form_company(name)));
-- no update policy: a stored file is never changed
```

- Why a bucket and not a table: a PDF in a table row is carried by every read of that row, counts against the database's size, and cannot be limited by type or size as simply. A bucket is made for files, and a file named by its hash is stored once however many templates of that company use it.
- The hash and page count are the "fingerprint" asked for earlier: a revised government form is detected instead of silently misplacing fields.
- `save_pdf_template` refuses a template whose file is not in the bucket yet. The app uploads the file first, then saves the template.
- History: every save is a row; the list shown groups one person's saves within 30 minutes into one entry, and "Restore" makes the chosen one the newest revision. A cap per template (I suggest 200 revisions, oldest dropped) keeps automatic saving from growing it without end.
- Moving a field saves by itself only if that is how the screen works today. The field editor's "Save template" button stays, and inside the dashboard it saves to the database (decided, 4.2).
- Not moved (D6): the values last typed and the People list. They stay in `pdf-editor:templates` in the browser, which after the import holds only those two things per template and no PDF.
- Deleting a company: files must be removed through the Storage service, by the dashboard, before `delete_company` runs. To check before building: I believe current Supabase projects refuse deleting file rows by SQL, and where SQL is allowed it leaves the file behind.

### 5.3 Phase 2, migration 0013: the shared column setup and each company's own columns

How Global columns work today: one list, in one browser, used by every company in that browser. To keep that with two people and a database organised by company, the shared setup becomes a record of its own, and companies are attached to it.

```sql
-- The shared setup: identity fields, which one is the ID field, the Global columns.
create table public.payroll_shared_setups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (name = btrim(name) and char_length(name) between 1 and 80),
  body        jsonb not null
              check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 262144),
  revision    integer not null check (revision >= 1),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- One row per company: which shared setup it uses, and its own columns.
create table public.payroll_company_setups (
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
create index on public.payroll_company_setups (shared_setup_id);

-- Every revision of each, kept (see D2): what a month's revision numbers point at.
create table public.payroll_shared_setup_history  (shared_setup_id uuid, revision integer, body jsonb, saved_by uuid, saved_at timestamptz, primary key (shared_setup_id, revision));
create table public.payroll_company_setup_history (company_id uuid, revision integer, shared_setup_id uuid, body jsonb, saved_by uuid, saved_at timestamptz, primary key (company_id, revision));
```

Who may do what with a shared setup (confirmed, D1):

| | Rule |
|---|---|
| Read | You are a member of at least one company attached to it |
| Change (`save-shared`) | You are an admin of EVERY company attached to it. The change reaches all of them, so it needs authority over all of them |
| Attach a company (`attach-company`) | You are an admin of that company, and may change the shared setup. A company has exactly one shared setup |
| Before any company is attached | Only the person who created it |

- For two people who are both admins of all the companies, this behaves as today: either of you edits a Global column, and it applies everywhere at once.
- Someone who is an admin of only some of the attached companies can see the Global columns but not change them. That is deliberate: otherwise they could change the payroll rules of a company they do not administer.
- **Why not "owned by one person":** the other person would not see it, and their formulas would show Error.
- **Why not a general "organisation" now:** it would add its own table, its own member list and a second kind of access rule across the dashboard, for the same result. If an organisation is wanted later for other things, a shared setup can be attached to it then; nothing here blocks that.
- The two bodies are defined by the payroll app. The dashboard stores and returns them exactly as sent and never looks inside.
- One load returns the shared setup and every attached company's columns that you may read, because the app's checks need them (for example "these formulas use it" looks at every company's formulas).
- **Companies need no new table.** `companies` and `company_details` already hold the name, address, BRN and extra details. The browser company is linked to one by BRN, or by hand with "Link this company to..." when its BRN is missing or matches nothing (D7).
- **Not moved, on purpose:** column widths, the month being viewed, the selected company, the theme. They are per-browser preferences with no payroll value in them.
- Between Phase 2 and Phase 3 the months are still in the browser, keyed as today. The import's small marker (section 5.6) records which browser company is which dashboard company.
- Changing a column's key also moves that column's values in every saved month (audit fixes 10 and H1). While months are in the browser, the app does that as today. From Phase 3 it has to be one all-or-nothing database function across every month of every attached company, saved together with the setup. It is listed under Phase 3.

### 5.4 Phase 3, migration 0014: payroll monthly data

```sql
create table public.payroll_months (
  company_id        uuid not null references public.companies(id) on delete cascade,
  period            date not null check (period = date_trunc('month', period)::date),
  revision          integer not null check (revision >= 1),
  shared_revision   integer not null,     -- the shared setup revision this month was last saved with
  company_revision  integer not null,     -- and the company's own
  employees         jsonb not null
                    check (jsonb_typeof(employees) = 'array'
                           and octet_length(employees::text) <= 1048576),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  primary key (company_id, period)
);
```

- One row per company per month, holding the whole month, because that is how the app works today: it loads and saves a month as one piece. A save is then all or nothing.
- The alternative, one row per employee, gives finer conflict checks but many more rows and saves that can half-succeed. Not needed at these sizes.
- This is the payroll app's working data (what was typed). It does not replace `payroll_runs` and `payroll_entries`, which hold the results sent with "Send to dashboard". That button stays as it is.
- Functions: `save_payroll_month(company, period, employees, expected_revision, shared_revision, company_revision)`, admin only, with the version and size checks; and `rename_payroll_value_key(...)` for a change of key (see 5.3).
- Worth adding: `payroll_month_history`, keeping the month as it was before the first save of each day, so a mistake can be undone. One row per month per day at most.
- Access (D5): admins only, gate open. The table is covered when the gate locks, and what was typed is kept in memory and saved on unlocking (4.2). The gate locks after inactivity, and typing in the payroll app counts as activity, so this happens when the screen is left, not in the middle of data entry.

### 5.5 Row-level security, in one table

"Your own data" means the data of companies you are a member of. That is how every existing table works, through `company_members`, `is_company_member` and `is_company_admin`.

| Table or bucket | No link to the company | Viewer (member) | Admin | Anonymous |
|---|---|---|---|---|
| `pdf_templates`, `pdf_template_history` | nothing | read | read; write only through the functions | nothing |
| Bucket `pdf-forms` | nothing | download that company's files | download, upload, delete that company's files | nothing |
| `payroll_company_setups` and its history | nothing | read | read; write only through the functions | nothing |
| `payroll_shared_setups` and its history | nothing (no attached company of yours) | read | read; write only through the function, and only as admin of every attached company | nothing |
| `payroll_months` (and its history) | nothing | **nothing** (D5) | read; write only through the functions | nothing |

For every table: row-level security on; one `select` policy; no insert, update or delete policy and no such grant; `revoke all ... from public, anon, authenticated` then `grant select ... to authenticated`; functions are `SECURITY DEFINER` with `set search_path = ''`, executable by `authenticated` only. Each migration ends with a query you can run to verify it.

The dashboard's Database page gets one read-only entry per new table, with the app-written JSON masked.

### 5.6 Importing what is in the browser, once

One import per app, per browser, started by the user. Nothing is imported by itself.

1. **Offer.** Inside the dashboard, when the browser holds data that has not been imported, the app shows a notice with one button. Opened on its own, nothing changes.
2. **Back up first.** The app downloads a full backup file (Phase 0 adds this; today neither app has one). The import does not continue until that file has been saved.
3. **Preview, nothing written yet.**
   - PDF templates: every template in the browser, its file's size against the 5 MB limit, and the company it will go to (the one selected in the dashboard, see 4.2).
   - Payroll: for each company, matched by BRN or not, and why not; the shared setup that will be created and the companies that will be attached to it.
   - Payroll, a company with a missing or unmatched BRN: "Link this company to..." (D7). The choice lists only dashboard companies you are an admin of that are not linked yet, shows the browser's BRN beside the dashboard's, and is confirmed once more before it counts. It never creates a dashboard company and never changes the dashboard company's name, address or BRN. A company left unlinked stays in the browser, as it is.
   - Every conflict. A conflict is "the database already has a template of that name, a setup for this company, or that month". A conflict is never resolved silently: the choices are keep the database's, replace it with the browser's as a new revision, or skip.
4. **Import, one item at a time.** Each template, each company's setup, each month is one all-or-nothing call. PDF files go first (named by hash, so a repeat is harmless), then the template that refers to them. The shared setup goes before the companies attached to it.
5. **Check.** The app loads back what it just saved and compares it with the browser copy: each template and setup field by field, each PDF by hash, each month by its number of employees and a hash of its content. Only when they are equal is the item marked as imported, in a small browser key that holds names, the BRN, the date and the revision, and no payroll value.
6. **Keep the browser copy** (D4). For PDF templates the one exception is the PDF text itself: once a template is checked, its file can be dropped from the browser key to give the room back, but only on a separate, explicit confirmation, and never before the backup file exists.

**If it fails:**

| What fails | What happens |
|---|---|
| The backup is not saved | The import does not start |
| No connection, not signed in, not an admin, gate closed | Refused before anything is written; the message says which |
| One item's call is refused | That item stays browser-only and fully usable. The others are not affected. The message names the step and the reason |
| The connection drops during a call | The existing rule: reload, compare the revision, and only then try again. An all-or-nothing call was either stored or not |
| The check in step 5 finds a difference | The item is NOT marked as imported, the difference is shown, and the browser copy stays the one in use. The database rows are left for you to look at; the next preview reports them as a conflict |
| A second browser has its own copy of something already imported | Shown as a conflict in the preview. Never merged |

For Phase 3, months saved under a company that no longer exists in the browser are listed and left alone.

### 5.7 When offline, signed out or locked

| Situation | What happens |
|---|---|
| App opened on its own | No change. Browser storage, works offline as today |
| In the dashboard, the database cannot be reached when the app opens | The app says so and offers "Try again". If this browser still has its own copy, it can be opened **read-only**, labelled with its date. It is never opened for editing in place of the database copy: that would create two versions |
| The connection is lost while working | What is on screen stays, in memory. A blocking "This was NOT saved" warning the first time, then a notice that stays, as in the PDF form filler today. The app retries by itself and when the connection returns, and "Try saving again" is always there |
| The dashboard signs out for inactivity while the app is in use | Should no longer happen once step 0c is done. If the session ends anyway: the same "NOT saved" state, and after signing in again the save goes through with its revision check |
| Leaving or closing with something unsaved | As in the fix of 12 October: held back once behind the warning; on closing the page the browser asks first |
| The tab has to be closed while offline | "Download what is on screen" saves a backup file that can be loaded later |
| Back online, and someone else saved meanwhile | The save is refused as `stale`. Both versions are shown and the user chooses. Nothing is merged automatically |
| The password gate locks with figures not yet saved (monthly data) | It cannot lock while someone is typing: it locks after inactivity, and typing in the app counts (4.2). When it does lock (the screen was left, the tab was hidden for two minutes, or "Lock now"): D5, the save is refused as `locked`, nothing stored, the table is covered, what was typed is kept in memory and saved once unlocked |

Unsaved work is **not** written to browser storage while waiting. For monthly data the dashboard's rule forbids it. For setups and templates it would be allowed, but one rule everywhere is simpler to trust. The cost: closing the tab while offline loses unsaved changes unless the backup file is downloaded, and the app says so.

### 5.8 The sign-out for inactivity: test and fix

**Test** (dashboard in its demo mode, idle time set to its minimum of 1 minute, fake sign-in, no Supabase):

| What was done for 100 seconds | Result |
|---|---|
| Nothing at all | Signed out after about 60 seconds |
| A key pressed in the dashboard itself every 3 seconds | Still signed in |
| A click and a key every 3 seconds inside an app's frame (the frame counted 25 keys and 25 clicks) | **Signed out after about 75 seconds** |

So typing inside an app does not count. The cause is in `payroll_hub/src/lib/idle.ts`: it listens for clicks, keys, the wheel and touch on the dashboard's own window, and a browser does not pass those on from a frame to the page around it. With the default of 15 minutes, anyone working in an app for more than 15 minutes without touching the dashboard is signed out. This is already true today for the payslip app; with automatic saving it would also turn every later save into "NOT saved".

**Fix (step 0c), recommended:** a new bridge message, `activity`.
- `bridge.js` sends it when the user clicks, types or scrolls in the app, at most once every 30 seconds, with nothing in it. No reply is expected.
- The dashboard treats it exactly like a key pressed in the dashboard, and only from the frame of the app that is showing, in a visible tab.
- It is an addition to protocol version 1. An app that still has the older `bridge.js` keeps working and simply does not send it. The new `bridge.js` is copied, unchanged, into the three apps.
- It keeps working when the dashboard later moves to its own origin.

**Not recommended:**
- The dashboard listening inside the apps' frames directly. It needs no change in the apps, but it only works while everything shares one origin, which `FUTURE_WORK.md` plans to end, and it would then stop without any sign.
- Counting the bridge's own 15-second ping as activity. Nobody would ever be signed out.

**Tests for it:** the three rows above become a dashboard test that must end "still signed in" for the third; a test that 100 `activity` messages in a second count once; a test that a hidden tab or a frame that is not showing is ignored; `payslip`'s `npm run check` and the other apps' bridge tests after the new file is copied in.

**The password gate (changed on 13 October, D5).** Until now it locked a fixed time after unlocking, whatever the activity. It now locks after that time without activity: 10 minutes, 1 to 30 in Settings.
- One activity signal in the dashboard (`src/lib/activity.ts`) feeds both the sign-out and the gate: a click, a key, the wheel or a touch in the dashboard itself, and an `activity` message from the app that is showing in a visible tab.
- So neither the sign-out nor the gate can happen while someone is typing in any app. An app reports at most every 30 seconds, and both times are at least 1 minute.
- Unchanged: the gate locks when the tab has been hidden for more than two minutes, on "Lock now", and when the session ends; its state stays in memory only; locking wipes the gated data from memory.
- The time shown as "Unlocked until" moves forward with activity. The gate's own text and the Settings label say "without activity".

**Tests for the gate:** it stays open while there is activity past the old fixed deadline and locks the set time after the last activity; an `activity` message from the app that is showing keeps it open, and one from a hidden frame or a hidden tab does not; the hidden-tab lock is not postponed by activity.

### 5.9 Tests to add or change

**payroll_hub**
- Add, per migration, a database test in the in-memory Postgres (as `deleteCompany.db.test.ts` does): no access without a link to the company; a viewer cannot write; an admin can write only through the function; a save carrying an old revision is refused; the same save sent twice stores once; sizes over the limit are refused; `delete_company` removes the new rows.
- Add, for the shared setup: a member of one attached company can read it; an admin of some but not all attached companies cannot change it; an admin of all can; attaching needs both rights; a company cannot be attached twice.
- Add tests for the bucket rules against a stand-in for the Storage table, because the in-memory Postgres has no Storage. Plus a short checklist for you to run once on the development project.
- Add protocol and handler tests for the data types: shapes, limits, exactly one row per save, every refusal code, another company's BRN refused, an answer within 8 seconds, nothing but counts in the transfer log.
- Add the `activity` tests and the password gate tests of section 5.8.
- Change: `baseline.test.tsx` recordings (read each difference), the Database page's table list, the test that `MIGRATION` in `deleteCompany.ts` names the newest file, the test that keeps `bridge.js` and the origin constant equal, and `npm run test:prove`.
- Add the data types to the mock apps in demo mode, so the dashboard side can be tried before the real apps change.

**PDF Editor** (Phase 1)
- First, with no change in behaviour: put all reading and saving behind one small interface with two versions, browser and dashboard. The safety net (6) and the audit (28) must pass untouched. They are the proof that the app on its own is unchanged.
- Add: the hash and page count of a file; upload and download through a stand-in dashboard, byte for byte; a file over the limit refused before it is sent, with a message that says why (this also answers audit item M17); a template whose file is missing from the bucket is a visible error; history and restore; copy to another company.
- Add: automatic saving (one save after the last change, never two at once), "Saved / Saving / NOT saved", `stale`, `unavailable`, and "no answer" followed by reload-and-compare.
- Add: the import (the preview writes nothing; each conflict choice; a repeat imports nothing twice; a failed check leaves the item unmarked and the browser copy in use), each proven able to fail.
- Change: the walkthrough for `check:text` and `check:a11y`, and the approved wording.

**Payroll_sys** (Phases 2 and 3)
- The same interface step first: the 300 unit tests, 130 browser tests and the safety-net recordings must pass untouched.
- Add: the dashboard version against a fake bridge, as for the PDF form filler, plus `locked` for months.
- Add: a Global column changed by one admin is what a second admin loads; a `stale` save of the shared setup shows both versions; someone who cannot change the shared setup sees Global columns read-only.
- Add: the import (BRN matching; the shared setup created once and every matched company attached; conflicts; the check).
- Add, Phase 3: one save a moment after typing stops instead of one per key (this is the code path of audit fixes 6 and 7); the covered table when the gate locks; a change of key moving values in every month, all or nothing.
- Add: browser tests inside a stand-in dashboard, as the PDF form filler's tests have.
- Change: the text check (new wording through the approved list; new screens in the walkthrough), the embedded text collector, and the full-flow test (one round trip through a stand-in dashboard).

**payslip**
- No change in behaviour. The new `bridge.js` is copied in for `activity`; `npm run check` must stay green.

**By hand, on the deployed development project** (the bridge trusts only the deployed dashboard): a checklist per phase, including signing in as someone who is not a member of the company and confirming they see nothing.

### 5.10 Order of work

Each step ends with tests passing and a stop for your review. Each migration is written for you to read and run by hand before the dashboard code that needs it is deployed.

| Step | Where | What |
|---|---|---|
| 0a | PDF Editor, Payroll_sys | A full backup file, export and import, in each app. Useful by itself (audit risk R3) and needed by every import. **Done 13 Oct 2026** |
| 0b | PDF Editor, Payroll_sys | The storage interface, with no change in behaviour. **Done 13 Oct 2026** |
| 0c | payroll_hub, then the three apps | The `activity` message, so working in an app keeps the session alive, and the password gate locking after inactivity on the same signal (D5 as changed on 13 October). Done in Phase 0 because automatic saving makes a sign-out in the middle of work matter from Phase 1. **Done 13 Oct 2026** |
| 1a | payroll_hub | Migration 0012, the bucket, `pdf-template` and `pdf-file`, mock app |
| 1b | PDF Editor | Templates and files in the dashboard, automatic saving, the import |
| 2a | payroll_hub | Migration 0013, `payroll-setup`, mock app |
| 2b | Payroll_sys | Company link by BRN, the shared setup and company columns in the dashboard, the import |
| 3a | payroll_hub | Migration 0014, `payroll-month` behind the gate, the change-of-key function, mock app |
| 3b | Payroll_sys | Monthly data in the dashboard, the import |

### 5.11 Phase 0 as built (13 October 2026)

Committed on each folder's own branch, not pushed. No migration file: Phase 0 changes nothing in the database.

**0a, the backup files.**

| | Payroll | PDF form filler |
|---|---|---|
| Where | "Back up" and "Restore" at the foot of the company list | "Back up" and "Restore" on the template list |
| File | `payroll-backup-YYYY-MM-DD.json` | `pdf-form-filler-backup-YYYY-MM-DD.json` |
| Holds | The setup, every company, every saved month of every company | Every template with its PDF, fields, company details, the values last typed and the People list; the older company details |
| Does not hold | The theme | The theme |

- A backup holds what is stored, exactly: nothing is recalculated, rounded or filled in. Stored text that cannot be read is carried along as it is.
- Restore first shows what is in the file and what is in the browser, and replaces nothing until "Replace with this backup". It replaces everything that app keeps in the browser, all or nothing: if the browser refuses a write, what was there is put back and the app says "The backup was NOT restored".
- A file that is not a usable backup (another kind of file, another version, damaged, empty) is refused in plain words and nothing is changed.
- A backup file holds real figures and people's details. It belongs where the payroll is kept, never in a repository.

**0b, the storage interfaces.** `Payroll_sys/src/lib/dataStore.js` and `PDF Editor/src/lib/templateStore.ts`. Every screen reads and saves through them; a test in each app fails if a screen reaches past them to the browser's storage. The one store today is the browser, so nothing behaves differently.
- Left for Phase 1b and 2b: the operations answer at once, as the browser does. A store that saves through the dashboard answers later, so those phases add the "Saving / Saved / NOT saved" states at the interface and the screens that show them. Phase 0 did not change how any screen saves.

**0c, `activity` and the gate.** As section 5.8, with two details settled while building:
- `bridge.js` reports the first thing done at once and then at most once every 30 seconds; something done in between is reported when its turn comes, so the dashboard never thinks work stopped earlier than it did.
- The dashboard counts an app's `activity` at most once every 5 seconds, whatever the app sends, and only from the app that is showing in a visible tab.
- Order of deployment: the dashboard first, then the apps. A dashboard that does not know `activity` drops it and writes a warning to its console each time.
- Checked in a real browser in demo mode, idle time 1 minute, outside requests blocked (0 attempted): 100 seconds of a click and a key every 3 seconds inside the app's frame, still signed in, 4 `activity` messages; then nothing, signed out with the usual notice.

**Found on the way, not fixed** (each in its folder's `docs/KNOWN_ISSUES.md`): the dashboard's whole test run times out on a busy machine, also on the code before Phase 0 (`npm test -- --maxWorkers=4` passes); in the PDF form filler, a reload in the same instant as a key can store a listed person without that key.

### 5.12 Phase 1 as built (13 October 2026), before the migration is run

On the branch `migration-phase-1` in `payroll_hub` and `PDF Editor`; not merged, not deployed. The live project was not contacted: everything below ran in the in-memory Postgres, the demo store and a stand-in dashboard. The test against the real database comes after migration 0012 is run.

**Database: `supabase/migrations/0012_pdf_templates.sql`.** As sketched in 5.2, with these differences:
- The app chooses a template's id, for a new template too, so a save that is sent twice cannot make two templates.
- The history table also keeps each revision's file (hash, name, size, pages), so restoring a revision restores the form it was drawn on.
- One more function, `delete_pdf_template`: the tool already has "Delete", and the sketch had no way to carry it out. It answers whether the file is still used, and the dashboard removes an unused file from the bucket.
- At most 50 templates per company, as for payslip templates.
- `delete_company` is replaced to delete the two new tables too. The files are removed by the dashboard, through Storage, before it calls the function.
- It only adds. A test reads the file and fails if it drops, alters or truncates anything that existed before.

**Dashboard.** Data types `pdf-template` (`list`, `load`, `history`, `companies`; saves `save`, `restore`, `copy-to-company`, `delete`) and `pdf-file` (`exists`, `download`; save `upload`). No dialog and no gate. A file is checked before it is stored: base64, 5 MB, starts as a PDF, SHA-256 as stated. The wire contract is in `docs/INTEGRATION.md`.

**PDF form filler.** Inside the dashboard the templates of the selected company are loaded from it, with their PDFs; a change is saved a moment after it is made, one save at a time per template; a bar says "Saved", "Saving..." or "NOT saved" with the reason. "Copy to another company" and "Import to the dashboard" are on the template list. Opened on its own, or inside a dashboard that does not keep templates yet, it uses the browser exactly as before.

**Decided while building, to confirm:**
- Inside the dashboard, the values last typed and the People list are kept in the browser under their own key (`pdf-editor:dashboard-values`), by dashboard template id, so the browser's own copy of the templates stays untouched (D4). The import copies them there once. The backup file includes that key and the note of what was imported.
- The import offers each browser template once, for the company selected at that moment. A template that is already in the dashboard under the same name is left alone unless "replace it with this browser's" is chosen.
- Someone who is not an admin can open and fill in; a change they make is refused and shown as NOT saved.

**Not built in this phase** (each was in the plan or its tests):
- A screen for a template's history and "Restore". The database and the dashboard keep and restore revisions; the tool has no button for it yet.
- The Database page's read-only tabs for the two new tables.
- The mock app in demo mode for these data types (the tool's own tests use a stand-in dashboard instead).
- Opening the browser's copy read-only when the dashboard cannot be reached. The tool says so, offers "Try again", and points to opening it on its own.
- "Download what is on screen" for a tab that has to be closed while offline.
- Dropping the PDF text from the browser's copy after an import (plan 5.6, step 6). The browser's copy is left exactly as it is.
- Grouping one person's saves within 30 minutes in a history list (there is no list yet).

**Tested against the real database (13 October 2026), after 0012 was run** (all 14 columns of its check true). The two branch builds were served in place of the live sites inside one browser window, so the real bridge and the real project were used with nothing deployed; the owner signed in by hand. Only the company "TEST Co Ltd" was written to, and what the test made was removed at the end. 18 of 18 checks passed on the second run:
- a new template is stored at revision 1, its PDF is in the bucket under its hash and downloads back byte for byte;
- a drawn field and a rename are revisions 2 and 3, and all three are kept; after a reload everything comes back from the database and the bucket;
- a value typed into the form is not sent; a save with an old revision is refused, and so is a template whose PDF is not in the bucket;
- the import stores a browser template, checks it, leaves out the People list, and leaves the browser's copy as it was;
- after the clean-up the company holds no template, no file and no kept revision of the test.

The first run found one fault: the import refused a template that had been stored correctly, because the database returns a JSON object's properties in its own order and the check compared text. Fixed in the PDF form filler (comparison by content), and the stand-in dashboard of its tests now reorders properties the same way.

Not tested against the real database: the copy to another company itself (it would have written to a company other than the test one; only the list of companies was opened), two people saving at once (an old revision was sent instead), someone who is not an admin, a PDF near 5 MB, and deleting a company that has PDF files.

### 5.13 Phase 1 follow-ups (13 October 2026)

On the branch `phase-1-followups` in `payroll_hub` and `PDF Editor`; not merged, not deployed. No migration: the history table and its read policy came with 0012.

- **History and restore (PDF form filler).** "History" on each template lists its saved revisions, newest first, with the date, the time and who saved it. A revision can be looked at, its fields drawn on its PDF, without changing anything. "Restore this version" asks first and is saved by the dashboard as a NEW revision; no earlier revision is deleted or rewritten. Only an admin is offered it. For the preview, the dashboard's `pdf-template` "load" takes an optional `revision`.
- **Database page (dashboard).** Read-only tabs for `pdf_templates` and `pdf_template_history`, like the other tabs: admins, behind the gate, the selected company only. They show the name, revision, file name, size, pages and hash, who and when. What the app wrote in a template is masked like other app-written JSON. The PDF files are never read there.
- **Offline copy (PDF form filler).** Each time a company's templates are loaded from the dashboard, the browser keeps that copy, one per company. When the dashboard cannot be reached, each kept copy is offered by company and date, and opens labelled "Offline: read-only copy from [date and time]. Changes can't be saved." Forms can be filled in and downloaded; nothing that changes a template is offered. If the browser has no room for the copy, none is kept and none is offered.

**Tested against the real database (13 October 2026), in "TEST Co Ltd" only,** the same way as Phase 1: the two branch builds served in place of the live sites in one browser window, the owner signing in by hand. 15 of 15 checks passed: the offline copy (with the window's connection to the database cut off) opened read-only with its date and time, could be filled in and downloaded, and nothing typed offline reached the database; History listed the three revisions with date, time and who; a revision was drawn with its fields; restoring revision 2 was saved as revision 4 with revisions 3, 2 and 1 kept as they were; both Database page tabs showed the rows with the fields masked and nothing that edits; and the company was left as it was found. Two checks failed on the first run because of the test script itself (one read the page too early, one mistook the column header `saved_at` for a Save button); corrected, the run was clean.

Still not built from the Phase 1 list: the mock app in demo mode for these data types, "Download what is on screen" when offline, dropping the PDF text from the browser's own copy after an import, and grouping one person's saves within 30 minutes in the history list.

### 5.14 Phase 2 as built (14 October 2026), before the migration is run

On the branch `migration-phase-2` in `payroll_hub` and `Payroll_sys`; not merged, not deployed. The live project was not contacted: everything below ran in the in-memory Postgres, the demo store and stand-in dashboards. The test against the real database comes after migration 0013 is run.

**Database: `supabase/migrations/0013_payroll_setups.sql`.** As sketched in 5.3, with these differences:
- The app chooses the shared setup's id, so a save sent twice cannot make two.
- `save_payroll_shared_setup` can save attached companies' own setups in the same step, all or nothing: a change of a Global column's key rewrites formulas in company columns too.
- The rules are three small functions the policies and the saves share: `can_read_payroll_shared_setup`, `can_change_payroll_shared_setup` (an admin of every attached company; before any is attached, its creator) and `payroll_shared_setup_access` (whether the caller may change it, and how many companies use it and how many of those the caller administers: counts only).
- Every revision of both kinds is kept, none dropped (months will point at them). The company history also records which shared setup the company was attached to.
- `delete_company` is replaced: it deletes the company's own setup and revisions, and the shared setup with its revisions when no other company uses it any more.
- It only adds. A test reads the file and fails if it drops, alters or truncates anything that existed before.

**Dashboard.** Data type `payroll-setup` (`load`, `history`, `revision`, `companies`; saves `save-shared`, `save-company`, `attach-company`), no dialog and no gate. Companies are named by BRN; a save may name another of the user's companies (`company_brn`), since the import attaches several and a key change reaches several. The wire contract is in `docs/INTEGRATION.md`. A demo store with the same rules backs the dashboard's own tests and demo mode.

**Payroll app.** Inside the dashboard the setup of the company selected there is loaded from it; a change is saved a moment after it is made, one save at a time; a bar says "Saved", "Saving..." or "NOT saved" with the reason, and offers "Save mine over it" / "Use the dashboard's version" when someone else saved meanwhile. The Global columns are read-only, with the reason, for someone who is not an admin of every company using them; a company's columns and details are read-only for someone who is not its admin. "Import to the dashboard" needs a backup file first, shows what it will do without writing anything (BRN matches, differences in name and address, conflicts, "Link this company to..."), then imports the shared setup and each company one at a time and checks each by reading it back. This browser's own copy is never written; opened on its own after an import, it is labelled "This browser only. Not the dashboard's copy." The months stay in the browser under the same keys, so an imported company keeps its months; a test shows every calculated figure is the same before and after the import. Opened on its own, or inside a dashboard that does not know `payroll-setup`, the app uses the browser exactly as before.

**Decided while building, to confirm:**
- Inside the dashboard the company's name, address and BRN are the dashboard's own: the app shows them read-only (Company details says where to change them) and its exports use them. Only the custom company details are saved with the company's setup.
- Inside the dashboard the company list shows only the company selected there, without add, rename, delete or Restore. "Back up" stays (the import needs it).
- A dashboard company with no setup yet offers, to its admin: "Import to the dashboard" when this browser has something to import, "Use the shared columns of ..." when the user's other companies already use a shared setup, otherwise "Start with new, empty Global columns". Nothing is made by itself.
- In the import, a conflict starts as "skip" until a choice is made; into an existing shared setup the choice is "replace with this browser's, as a new revision" or "keep the dashboard's". If the user's companies use more than one shared setup, the import is refused.
- Column widths and the month being viewed are kept per dashboard company in this browser (`payroll_dashboard_prefs_v1`), started from the browser company's at the import. That key and the import note (`payroll_dashboard_imported_v1`) hold no payroll value and are not in the backup file.

**Not built in this phase:** the Database page tabs for the four tables; the mock app in demo mode; a screen for the setup's history (the dashboard answers `history` and `revision`); opening this browser's copy read-only when the dashboard cannot be reached (the app says so, offers "Try again", and points to opening it on its own).

**Found on the way, not fixed:** `Payroll_sys/docs/KNOWN_ISSUES.md` item 7: until Phase 3, a key changed inside the dashboard moves the values in the browser's months but not in the browser's own copy of the setup. Still open from section 6: payroll known issue 4 (re-saving an exemption formula nests it again), which with automatic saving now also makes a new revision each time.

## 6. Risks and things to check first

- **The Supabase plan.** `FUTURE_WORK.md` already notes that the free plan pauses a project after a week without use and has no daily backups. File storage on it is limited too (1 GB when I last knew; please check the current figure). A paused project means every save answers `unavailable`. Real data belongs in the separate production project described in `FUTURE_WORK.md` section 6.
- **The password gate and long data entry.** Settled on 13 October: the gate locks after 10 minutes without activity (up to 30 in Settings), and typing in an app counts, so entering a month's data no longer means unlocking again every 10 minutes. What is left to try on a real month before Phase 3 is called done: reading a long table without touching anything for longer than the set time locks it, as intended.
- **An app that reports activity it does not have.** The `activity` message carries nothing and is accepted only from the frame that is showing, but an app that sent it on a timer would keep the session and the gate open. The three apps are yours and `bridge.js` sends it only on a real click, key, wheel or touch. It is one more reason for the separate origin in `FUTURE_WORK.md` section 5 before other people's apps are ever embedded.
- **Slow uploads.** The dashboard must answer a save within 8 seconds. A 5 MB file on a slow line can take longer. The reload-and-compare rule covers it (`exists` by hash), but it needs a test with a throttled connection.
- **Automatic saving and history.** Saving by itself produces many revisions. The setups are small (under 6 KB) and every revision is kept, because months point at them. Template history is capped. Both figures should be checked against real use after Phase 1.
- **Saving on every keystroke.** The payroll app writes the whole month on every change, with no delay. Over a network that becomes one save a moment after typing stops. The safety net matters most there.
- **The growing exemption formula** (payroll known issue 4). Re-saving such a column changes its formula text each time, which would now also create a new revision each time. Better fixed before Phase 2.
- **Who can change Global columns.** With the rule in 5.3, adding a company that only one of you administers to the shared setup stops the other from changing Global columns. The app must say so plainly when it happens.
- **Shared origin** (audit risk R9). Moving data out of browser storage reduces what the other apps on the site can read. The People list in the PDF form filler stays there under D6.
- **Two people at once.** The revision check prevents silent overwrites but not the annoyance of one person's save being refused. Live updates are in the dashboard's backlog and are not part of this plan.

## 7. Later items, not part of this migration

- **PDF form filler: an option to clear the People list after a download** (from D6). So names and amounts do not stay in browser storage longer than the job needs.
- Moving the values last typed and the People list out of browser storage altogether (memory only inside the dashboard, or the database behind the gate).
- One shared PDF template for several companies, with company details kept apart (decided in 4.2: later, if copying proves a nuisance).
- Removing the browser copy after an import (D4).
- A general "organisation" in the dashboard, if wanted for more than the shared column setup.
- Live updates when two people work at once.

## 8. What this plan did not do

- The plan itself wrote no code and no migration file. Phase 0 (section 5.10, steps 0a to 0c) is built after it and needs no migration: the first migration file is 0012, in Phase 1.
- No contact with the live Supabase project. Its current tables, policies, bucket list and plan limits are taken from the migration files and documents, not from the project itself.
- No measurement with real data, or of the real MRA form's size.
- The sign-out test ran against the dashboard's demo mode and its mock app on this machine, not the deployed site. The code path is the same.
- The SQL above is a sketch to review the shape. The real migration files will carry the function bodies, the error codes, the `delete_company` replacement and a verification query, like migrations 0009 to 0011.
