# Payroll Hub: full brief

A static, frontend-only dashboard (React + Vite + TypeScript + Tailwind) deployed on GitHub Pages. It connects my
standalone apps, monitors them, and transfers data between them. It should look and feel like a premium product:
a real "wow" dashboard.

---

## 1. Context

- **App 1: Payroll System** (frontend only): https://noor1290.github.io/payroll_sys/
  The user enters data, it calculates everything, and the user exports a JSON of results.
- **App 2: PDF Form Filler** (frontend only): https://noor1290.github.io/pdf-form-filler/
  Imports that JSON and auto-fills a PDF.
- **App 3 (coming soon): Payslip Automation.** Consumes the same payroll JSON. Not built yet.
- More apps will be added later, so everything must be registry-driven (adding an app = one config entry).
- This dashboard is a third repo under the same account, served at https://noor1290.github.io/payroll-hub/
  (repo name `payroll-hub`). Vite `base` must be `/payroll-hub/` and configurable.
- All apps are static sites on the **same origin** (https://noor1290.github.io), so `event.origin` alone cannot tell apps apart.
- Each app must keep working **standalone** (manual JSON import/export) if the dashboard is down. Apps must not depend on
  each other or on the dashboard.
- Database: **Supabase** (hosted Postgres + Auth), called directly from the browser with the PUBLIC anon key. No custom
  backend. Only the dashboard talks to Supabase. The other apps only talk to the dashboard via `postMessage`.

## 2. Tech stack

React 18 + Vite + TypeScript (strict), Tailwind CSS, `@supabase/supabase-js`, TanStack Query (data fetching/cache),
TanStack Table (grid with row/column selection), React Router with **HashRouter** (GitHub Pages has no SPA rewrites),
Zod (validation), framer-motion (animation), lucide-react (icons), Radix UI primitives or shadcn/ui for accessible
components (dialogs, dropdowns, tabs, tooltips, command palette via cmdk), sonner for toasts, Vitest for tests.

Config via Vite env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public by design). Provide `.env.example`.

## 3. Supabase schema (already created; do NOT create or alter tables from the frontend)

The exact SQL is in `supabase/migrations/0001_initial_schema.sql`. RLS is ON everywhere; the browser only ever acts as a
logged-in user (role `authenticated`). Never use or mention a service-role key anywhere in the code.

Tables:

- `companies(id uuid, name, address, brn unique, vat text, created_at)`
- `company_members(company_id, user_id, role 'admin'|'viewer')`: read-only from the app; managed in the SQL editor
- `employees(id uuid, company_id, national_id, surname, other_names, employment_type, deleted_at, created_at)`, unique(company_id, national_id)
- `payroll_runs(id uuid, company_id, period date (always first of month), status 'draft'|'approved', created_by, created_at, deleted_at)`, unique(company_id, period)
- `payroll_entries(id uuid, run_id, employee_id, basic_salary, govt_increment, new_basic_salary, allowances, emoluments, travelling, gross_pay, age_60_plus bool, csg, nsf, paye, total_deductions, net_pay, levy, prgf, total_mra_contributions, edf, edf_monthly, total, extra jsonb, created_at)`, unique(run_id, employee_id)

Rules:

- Admins can insert/update/delete; viewers read only. The UI must hide or disable write actions for viewers, but never
  rely on that for security (RLS enforces it).
- Filter soft-deleted rows (`deleted_at is null`).
- Load the user's role per company from `company_members`.
- If a schema change is needed, write it as a new SQL file under `supabase/migrations/` for me to run manually in the SQL
  editor. Never run DDL from the browser.

## 4. Payroll JSON format

The payroll app exports an array of objects, one per employee. Example with **FAKE** values (never commit real payroll
data; the repo is public):

```json
{
  "ID": "X0000000000000",
  "Surname": "DOE",
  "Other names": "JANE",
  "Basic Salary": 18000,
  "Govt Increment": 635,
  "New Basic Salary": 18635,
  "Full time / Part time": "Full Time ",
  "Allowances": 0,
  "Emoluments": 18635,
  "Travelling": 0,
  "Gross Pay": 18635,
  "Age 60+": "No",
  "CSG": 559.05,
  "NSF": 449.5,
  "PAYE": 0,
  "Total deductions": 465.88,
  "Net Pay": 18169.12,
  "Levy": 270,
  "PRGF": 838.58,
  "Total MRA contributions": 2580.1,
  "EDF": 390000,
  "EDF (monthly)": 30000,
  "Total": 0,
  "Company Name": "ABC Co Ltd",
  "Address": "Mauritius",
  "BRN": "C1234567",
  "VAT": "12%"
}
```

File names look like `ABC Co Ltd-pdf-fill-2026-09.json` (company name, then period `YYYY-MM`).

Mapping to tables:

- Company Name / Address / BRN / VAT -> `companies`. Match an **existing** company by BRN. Do not create companies from
  the app; if there is no match, show a clear error.
- `ID` -> `employees.national_id`; `Surname` -> `surname`; `Other names` -> `other_names`; `Full time / Part time` -> `employment_type`.
- All numeric fields -> `payroll_entries` columns (snake_case as above). `Age 60+` Yes/No -> boolean.
- Any unknown extra keys -> `payroll_entries.extra` (jsonb), so new fields never break the import.
- **Trim all strings** (values contain trailing spaces, e.g. `"Full Time "`, `"PALMYRE "`).
- Do **not** recalculate or "fix" payroll numbers. Store exactly what was exported.

Keep the mapping in one typed module (single source of truth) used by import, grid labels, and the app registry.

## 5. App registry (config-driven)

File: `src/config/apps.config.ts`. Each app entry has: `id`, `name`, `description`, `url`, `icon`, `accentColor`,
`status` (`"active" | "coming-soon"`), `accepts: string[]` (data types it can receive, e.g. `"payroll-result"`),
`produces: string[]`, `protocolVersion`, and `expectedFields: [{ key, label, type: "string"|"number"|"date"|"boolean", required, sensitive }]`.

Initial entries (use these exact URLs, keep the trailing slashes):

- `payroll`: name "Payroll System", url `https://noor1290.github.io/payroll_sys/`, produces `["payroll-result"]`, status `active`
- `pdf-editor`: name "PDF Form Filler", url `https://noor1290.github.io/pdf-form-filler/`, accepts `["payroll-result"]`, status `active`
- `payslip`: name "Payslip Automation", url `""` (not built yet), accepts `["payroll-result"]`, status `coming-soon`

Derive each app's expected origin with `new URL(url).origin` (here `https://noor1290.github.io`) and use it as the exact
`targetOrigin` and for origin checks. Because the apps share this origin, ALSO verify `event.source` against the
registered iframe's `contentWindow`. The iframe sandbox must include `allow-same-origin`.

The "Send to..." menus and transfer destinations are generated from this registry (filtered by `accepts`). Adding a 4th
app must need only a new entry.

## 6. Messaging protocol (dashboard = hub; apps never talk to each other)

Envelope for every message: `{ type, from, to, version, id (uuid for correlation), payload }`.

Types:

- `ready` (app -> dashboard on load)
- `ping` / `pong` (health)
- `send-data` (dashboard -> app, or payroll app -> dashboard)
- `received` (ack: `{ ok: true }` or `{ ok: false, error }`)
- `request-data` / `response-data` (app asks the dashboard for a saved run; dashboard checks permissions and replies)

Security rules (this is payroll data):

- Verify `event.source === registeredIframe.contentWindow` AND `event.origin` equals the expected origin. Always use the
  exact origin as `targetOrigin`. **NEVER use `"*"`.**
- Validate every incoming message with Zod (envelope + payload + version). Reject and log anything unexpected (without payload values).
- Queue outgoing data until the target app sends `ready`. Timeout (about 10s) waiting for the ack -> show failure with
  **Retry** and **Download JSON instead**.
- Health: ready + periodic ping/pong gives status per app: green (ready), amber (loading), red (no response/timeout), grey (coming soon).
- Payroll data is held **in memory only**: never in localStorage/sessionStorage/IndexedDB, URLs, or console logs. Clear
  in-memory data on logout.
- If the sender is the payroll app: when it posts `send-data` with a payroll-result, show a toast/modal
  "Payroll results received (N employees)" with actions: **Save to database**, **Send to...**, **Dismiss**.

Also create `docs/INTEGRATION.md` and a tiny dependency-free `docs/bridge.js` that I can copy into each app. It must:
detect embedding (`window.parent !== window`), send `ready`, listen for `send-data` (check `e.source === window.parent` and
exact origin `https://noor1290.github.io`), validate version, call an app-provided handler (e.g. `importPayrollJson`),
reply with the ack, and expose a `sendToDashboard(type, payload)` helper for the payroll app. Include exact snippets for
`payroll_sys`, `pdf-form-filler` and the future payslip app. In embedded mode the apps show a "Send to dashboard / Receive"
UI; standalone they behave exactly as today.

## 7. Features / screens

**A) Login.** Email + password via Supabase Auth. NO sign-up screen (sign-ups are disabled on the server; users are
invited by me). Persist session, handle expiry, logout, optional idle auto-logout (15 min, configurable). Friendly error
states, including "database is paused / unreachable" (Supabase free projects pause after inactivity).

**B) App shell.** Collapsible sidebar; top bar with company switcher (companies the user belongs to, with role badge),
global status indicators for each app, theme toggle, user menu; command palette (Ctrl/Cmd+K: jump to pages, switch
company, open an app, start a transfer).

**C) Overview.** Animated stat cards (employees, latest run period, total net pay in Rs/MUR, number of runs), recent
payroll runs, app status cards (live), recent transfers, quick actions (Import JSON, New transfer, Open app).

**D) Import.** Drag-and-drop one or more JSON files. Parse, trim, validate with Zod per row (row-level error report with
row number + field, never silent failure), show a preview table, detect company by BRN, derive period from the file name
(editable), warn if a run for that company+period already exists (offer Cancel / Replace). Save in order: upsert employees
on (company_id, national_id) -> create payroll_run (draft) -> upsert payroll_entries on (run_id, employee_id). Supabase has
no browser transactions, so on any failure clean up what this import created and report exactly what happened. Admin-only.

**E) Data explorer.** Pick company -> period/run -> grid of employees and entries. Search, filters, sorting, row
checkboxes + select all, column visibility/selection, sensitive columns (national ID, salary figures) masked by default
with click-to-reveal, currency formatting (Rs, tabular numbers), pagination or virtualization. Admin actions: edit status
(draft/approved), soft-delete run (`deleted_at`) with confirmation. Show who/when created.

**F) Transfer wizard (the centrepiece).** Animated stepper:

1. Source: a saved run from the database, or data just received from the payroll app.
2. Select rows and columns (grid).
3. Destination: from the registry, filtered by `accepts`; disabled with a reason if the app is not ready or coming soon.
4. Map columns to the destination's `expectedFields`: auto-match by normalized name, manual dropdowns, required-field
   enforcement (block with a clear message if a required field is unmapped or deselected), type checks with per-row
   errors, warning when a sensitive column is going to an app.
5. Preview exactly what the destination will receive (first rows) -> **Send**.

Save mapping templates (e.g. "Payroll -> Payslip") in localStorage (mappings only, never payroll values). During send,
show an animated "data flowing" visual from source to destination, then success/failure with the ack result.
Optionally auto-switch to the destination app tab on success.

**G) Workspace.** Tabs (and an optional split view) hosting each registered app in an iframe with
`sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"`. **Keep iframes mounted**
when switching tabs (hide with CSS, do not unmount) so app state is not lost. Per-tab status dot, reload, fullscreen,
open in new tab, and a graceful error card if an app fails to load (with timeout detection). One app crashing must never
affect the dashboard or the other apps.

**H) Transfer log.** In memory only, NO payroll values. Rows like "14:32 Payroll -> PDF editor, 12 employees, delivered /
failed: app not ready (timeout)". Filterable, with retry for failed transfers while the data is still in memory.

**I) History.** List of payroll runs per company with status, period, entry count, created by/at; open a run in the
explorer or send it from there.

**J) Settings (light).** Theme, idle timeout, mapping templates management, app registry viewer (read-only), "Clear all
in-memory data" button, About/version.

## 8. Design direction ("wow", but professional and fast)

- Dark-first theme with a polished light theme. All colours as CSS-variable tokens used by Tailwind; respect
  `prefers-color-scheme` and a manual toggle.
- Mood: premium fintech / mission control. Deep ink-navy background with subtle aurora/mesh gradient glow, glass-like
  translucent surfaces with fine 1px borders, soft inner glows. Primary accent emerald/teal, warm amber for
  pending/in-transit, rose for errors, a touch of violet for glow accents. Avoid generic purple-gradient SaaS clichés and
  default-template looks.
- Typography: a distinctive UI font (e.g. Geist, Plus Jakarta Sans or similar, bundled locally) plus a monospace/tabular
  face for numbers and IDs. Strong hierarchy, generous spacing.
- Motion (framer-motion): staggered card entrances, animated number counters, smooth page and step transitions, pulsing
  status dots, the animated data-flow line in transfers, subtle hover lifts. Respect `prefers-reduced-motion`.
- Components: skeleton loaders (no full-page spinners), thoughtful empty states with small SVG illustrations, toasts,
  tooltips, keyboard shortcuts, focus rings, full keyboard accessibility, WCAG AA contrast.
- Fully responsive (desktop first, usable on tablet/phone). The grid scrolls inside its own container, never the page body.
- Use the frontend-design skill / best practices if available for distinctive, non-templated visuals.

## 9. Security and privacy checklist

- Only the public anon key in the frontend; no service-role key, DB password or secrets anywhere, including docs and examples.
- No payroll values in persistent browser storage, logs, URLs or analytics. No third-party trackers. No external
  fonts/CDNs unless self-hosted or bundled by Vite.
- The repo is public: `.gitignore` rules for `.env*` and any `*.json` payroll exports (except `samples/`); only fake
  sample data in `samples/`.
- Mask national IDs and salaries by default; click-to-reveal.
- Validate everything crossing a boundary (JSON files, postMessage, Supabase responses) with Zod.
- Hide write actions from viewers, but remember RLS is the real enforcement.
- Optional: a restrictive CSP meta tag that still allows `frame-src` for the registered app origins and `connect-src` for Supabase.

## 10. Quality, tests, delivery

- TypeScript strict, ESLint + Prettier, clean folder structure:
  `config/`, `lib/supabase`, `lib/bridge`, `features/{auth,import,explorer,transfer,workspace,history,settings}`,
  `components/ui`, `docs/`, `supabase/migrations/`, `samples/`.
- Error boundaries per feature; every async path has loading, empty and error states.
- Dev-only demo mode (only when `import.meta.env.DEV` and `VITE_DEMO_MODE=true`): fake data and a mock bridge so I can
  explore the UI without Supabase. It must be impossible to enable in a production build and must never bypass real auth in production.
- Vitest tests for: JSON transform/trim/validation, period-from-filename, BRN company matching, column auto-mapping and
  required-field enforcement, message validation (reject wrong source/origin/version), ready-queue + ack timeout behaviour.
- GitHub Actions workflow to build and deploy to GitHub Pages (repo `payroll-hub`), injecting `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` from repository variables/secrets.
- README: setup, env vars, how to add a new app to the registry, how to add a field (use `payroll_entries.extra` first;
  ALTER TABLE only when it must be queryable), how to test the security (a user who is not a company member must see
  nothing), deployment steps.

## 11. Phases (stop after each for my review)

1. **Phase 1:** scaffold, design system/tokens, login, app shell, theme, command palette skeleton.
2. **Phase 2:** Supabase client, company switcher with roles, Overview with real data.
3. **Phase 3:** JSON import (validate, preview, save, cleanup on failure) + Data explorer + History.
4. **Phase 4:** App registry, Workspace with iframes, bridge protocol, health status, `docs/INTEGRATION.md` + `bridge.js`.
5. **Phase 5:** Transfer wizard (row/column selection, mapping, preview, animated send), transfer log.
6. **Phase 6:** polish (animations, empty states, accessibility), tests, GitHub Actions, README.

At the end of each phase: run lint, typecheck and tests; update the Status checklist in `CLAUDE.md`; summarise what
changed, what to test manually, and anything I need to do (env vars, Supabase settings, edits to the other apps).

---

## 12. Decisions (agreed with the owner on 2026-10-03; these override anything above that conflicts)

**Setup and auth**
- npm, Tailwind v4, shadcn-style components in `src/components/ui`, Geist + Geist Mono bundled locally.
- The auth session is stored in **sessionStorage** through a custom storage adapter (re-login per browser session).
  Every storage key is namespaced `payroll-hub:*`.
- Demo mode: `npm run dev:demo`. Guarded by `import.meta.env.DEV`, so it is stripped from production builds.
- The owner fills in `.env` and tests the real login themselves. Never ask for keys to be pasted.

**Import (Phase 3)**
- The save is one atomic Postgres function in `supabase/migrations/0002_*.sql`: `SECURITY INVOKER` (RLS applies),
  admin check via `is_company_admin`, `set search_path = ''`, execute granted to `authenticated` only (revoked from
  `public` and `anon`). Called with `supabase.rpc`. The owner reviews and runs the SQL by hand. If the function is
  missing, show a clear message.
- **Replace** = update the existing run in place and remove entries that are not in the new file, inside that function.
- Replace is not allowed on an `approved` run; an admin must set it back to draft first.
- A soft-deleted run for the same period: warn, revive it (clear `deleted_at`) and overwrite it. No constraint change.
- Re-import updates surname, other names and employment type from the file and restores a soft-deleted employee.
  The preview shows how many employees are new, changed, unchanged and restored.
- Company name / address / VAT differing from the database: warn only, never update. Mixed BRNs in one file: hard error.
- Decimals: if `|value - round(value, 2)| < 0.0001`, round silently (floating-point noise). Anything more precise is a
  row-level error.
- "Created by" shows "You" / "Another user". No profiles table yet.

**Bridge (Phase 4)**
- The owner adds `bridge.js` to `payroll_sys` and `pdf-form-filler` themselves (with Claude Code in those repos), so
  `docs/INTEGRATION.md` needs precise per-app instructions.
- An app that loads but never sends `ready` shows a distinct "loaded, bridge not installed" state, not red.
- `bridge.js` ignores duplicate request ids, so a retry after a late ack never imports twice.
- No localhost origin in `bridge.js`. Local development uses the mock bridge.
- Reset ready state on every iframe `load`; infer load failure from a missing `ready`; pause health checks while the
  tab is hidden; correlation ids make the hub ignore late acks; clear queued payloads on logout.
- Reads are paginated past 1,000 rows. Paused-database detection is a heuristic.

**Same-origin risk (accepted for now)**
- The dashboard and the apps share one origin, so the iframe sandbox gives no isolation: an embedded app can reach the
  dashboard's DOM, memory and session. Never claim otherwise. Document this prominently in the README.
- Keep the dashboard origin and the app origins in ONE config constant (including what `bridge.js` trusts), so moving
  the dashboard to its own origin later is a config change. The README gets a section "Moving the dashboard to its
  own origin".

**Phase 3 notes**
- `@tanstack/react-table` is pinned to v8 (v9 has a different API).
- Unknown fields (`payroll_entries.extra`) appear in the grid as extra columns and are treated as sensitive (masked).
- Numbers written as text in a file (e.g. `"559.05"`) are a row-level error, not converted. A missing numeric field is an error, never assumed to be 0.
- After a successful save the file's rows are dropped from memory; only the summary is kept.

**Phase 4 notes**
- All active apps are loaded (hidden) as soon as the shell mounts, so health is live on every screen and data can be sent from anywhere. The iframes live in the shell and survive navigation.
- Readiness is withdrawn on every iframe `load`; the page then has to answer a ping before queued data is released.
- "Save to database" on received data hands it to the Import screen (same validation and preview as a file).
- A `request-data` from an app always asks the user first, and reads with the user's own permissions.
- Local development: `npm run dev:demo` uses dev/mock-app.html, which runs the real docs/bridge.js. Against the live apps, a local dashboard shows "Not connected (local run)" by design.
- Page transitions use a frozen outlet (see AppShell) so a page is not mounted twice per navigation.

**Password gate (from docs/BACKLOG.md, agreed 2026-10-03)**
- Gated: the Data explorer, and sending saved runs to apps (an app's `request-data` now; the Phase 5 wizard when its source is a saved run). Not gated: History, Overview totals, Import, data just received from the payroll app.
- Unlock window: 10 minutes by default, 1 to 30 in Settings, FIXED from the moment of unlocking (activity does not extend it).
- Locks on: the deadline, manual sign-out, idle sign-out, session expiry, the tab hidden for more than 2 minutes, and "Lock now". Locking is independent of the login session: the user stays signed in; the 15-minute idle sign-out is unchanged.
- Locking drops the gated rows from memory (query keys in `GATED_QUERY_KEYS`); unlocking fetches them again. Unlock carries across pages within the window.
- Password check: a separate throwaway Supabase client (`persistSession: false`, `autoRefreshToken: false`, in-memory storage, its own storage key), `signInWithPassword` with the current user's email, then `signOut({ scope: "local" })` on that client only. Never the default scope: it would end every session. The main client is never touched. The password is never stored, logged or kept.
- No extra lockout beyond Supabase's own rate limiting. Demo mode accepts the word "demo" (dev only).
- An app request while locked shows the unlock prompt inside the request dialog. Every request has a 100-second deadline (the app waits 120): still locked -> reply `{ ok: false, code: "locked" }`; unlocked but unanswered -> `code: "timeout"`.
- Reusable: `<PasswordGate what="…">`, `<UnlockForm>`, `<UnlockStatus>`, `useUnlock()`. A separate read-only "Database" page (raw table viewer) is planned and must use the same gate. Not built yet.
- Sensitive-column masking with click-to-reveal still applies after unlocking.

**Phase 5 notes**
- Both sources are shown to the wizard in the payroll app's export shape (its keys, company fields on every row), so the mapping to an app that consumes payroll results is one-to-one by default.
- Only MAPPED destination fields are sent, under the destination's field names. A selected column that nothing is mapped to is not sent (the mapping step says which).
- The wizard blocks on: a required field with no source (unmapped or its column unticked), and any row value that does not fit the destination field's type. Values are never altered.
- A saved run as the source sits behind the password gate; if the gate locks mid-wizard the rows are dropped and the prompt returns, but the selections are kept.
- "Send to…" in the received-data dialog still sends directly; its new "Choose rows and columns…" item hands the data to the wizard instead.
- Transfer log: memory only, no payroll values, emptied on sign-out. Failure reasons are fixed phrases; an app's own error text is shown once on screen but never stored in the log. The five most recent failed payloads are kept for Retry; ones that came from a saved run are dropped when the gate locks.
- Mapping templates: localStorage key `payroll-hub:mapping-templates`, column names only. Saved, applied and deleted in the wizard's mapping step.
- "Open the app when it is delivered" is remembered as a browser preference (`payroll-hub:transfer-open-after`).

**Database page (added 2026-10-03, on request)**
- Admin-only, read-only raw viewer for `companies`, `employees`, `payroll_runs`, `payroll_entries`, `company_members`, behind the password gate. Nav item (lock icon) between History and Settings, hidden for viewers; the route also shows an "admins only" message. "Open Database" in the command palette for admins.
- Server-side paging (25/50/100 per page, never more than 100 per request), sorting (with the row key as a tiebreaker) and search. Search looks at the table's text columns; for `payroll_runs` a month like `2026-09` matches the period; for `payroll_entries` it searches the employee's name and national ID through the join.
- Scoping: `companies` by id; `employees`, `payroll_runs`, `company_members` by `company_id`; `payroll_entries` through an inner join on `payroll_runs`.
- Soft-deleted rows are hidden unless "Show deleted" is ticked (one toggle for the whole page). An entry is treated as deleted when its run is, and is badged "run deleted". Tab counts follow the toggle and ignore the search.
- Masking: `employees.national_id`, every numeric column of `payroll_entries`, and `extra`. Per-cell click to reveal, plus Reveal all / Hide all. Re-masked on lock, on company change and on switching tab (per-cell reveals only). The JSON panel masks the same columns and copies exactly what it shows.
- User ids (`company_members.user_id`, `payroll_runs.created_by`) are shortened to 8 characters as they are read, in the table and in the JSON. `auth.users` is never read. Other ids are shortened in the table and shown in full in the JSON.
- Refresh: polling every 15 seconds by default (5 to 120 in Settings, key `payroll-hub:database-refresh-seconds`), paused while the tab is hidden or the page is locked; manual Refresh; "Updated HH:MM:SS". The previous rows stay on screen while a refresh is in flight. No Realtime.
- Rows live in the query cache under the `["db"]` key, which is in `GATED_QUERY_KEYS`, so locking and signing out wipe them.
- Demo mode has a fourth company, "Big Sample Ltd" (1,250 employees), to exercise paging past 1,000 rows, and a soft-deleted run and employee in "ABC Co Ltd".

**Phase 6 notes**
- Deploy: `.github/workflows/deploy.yml` lints, typechecks, tests and builds on every push and pull request, and publishes `main` to GitHub Pages. It reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from repository Variables (or Secrets), refuses to publish without them, and fails if demo-only code is found in the build.
- Settings is complete: theme, unlock minutes, idle sign-out minutes (1 to 120; the build's `VITE_IDLE_TIMEOUT_MINUTES` is the default and 0 there switches it off for everyone), Database refresh seconds, saved mappings (delete), read-only app registry, "Clear all in-memory data" (runs the same cleanup list as signing out, without signing out), About.
- Each screen other than sign-in and the Overview is loaded the first time it is opened.
- Content Security Policy: a `<meta>` tag added to production builds only (`src/config/csp.ts`). `VITE_DISABLE_CSP=true` leaves it out. Zod runs in `jitless` mode (`src/zodConfig.ts`, imported first by `src/config/env.ts`) so nothing attempts `eval`.
- Accessibility: every screen was checked with axe-core (WCAG 2.1 A and AA plus best practices) in both themes, with no violations left. Scrollable regions without focusable content were made keyboard-reachable.
- The placeholder screen and the per-screen "phase" markers are gone: every navigation item now has a real screen.
- `.env.example` was recreated (it had gone missing from the working folder).

**Add company (added 2026-10-03, on request; replaces "Do not create companies from the app" in section 4)**
- Rule: only a user who is already an admin of at least one company may create a company, and becomes its admin. Viewers and users with no company cannot. The first company and all other memberships are still managed in the SQL editor.
- Database: `public.create_company(p_name, p_address, p_brn, p_vat)` in migration `0003`, returning the new `companies` row. SECURITY DEFINER, `search_path = ''`, execute granted to `authenticated` only. It rejects a null `auth.uid()`, requires an existing admin membership, trims inputs, requires name and BRN, limits lengths (name 200, address 500, BRN 50, VAT 50), refuses a duplicate BRN (compared ignoring case and surrounding spaces, like the import's BRN match), and inserts the company and the caller's admin membership in the same function. No insert policy or grant was added to `companies` or `company_members`.
- Error tokens: `PH_NOT_SIGNED_IN`, `PH_NOT_ADMIN`, `PH_DUPLICATE_BRN`, `PH_INVALID_INPUT`.
- Dashboard: "Add company" in the company switcher and the command palette, shown only when the user is an admin somewhere (`canAddCompany`). Dialog validated with Zod (same limits). On success the list is refreshed, the new company is selected and a toast confirms. The import's "no company with this BRN" message now points to it.
- The command palette lists Actions before pages, so typing an action's name lands on the action.

**Delete company (added 2026-10-03, on request)**
- Permanent delete, by any admin of that company. Confirmed by the password gate AND by typing the company's exact name. (Until 2026-10-05 it was also refused while the company had any approved run; see "Delete company: approved runs no longer block it" below.)
- Database: `public.delete_company(p_company_id uuid, p_confirm_name text)` in migration `0004`, returning counts only (`company_id`, `entries`, `runs`, `employees`, `members`). SECURITY DEFINER, `search_path = ''`, execute granted to `authenticated` only. It rejects a null `auth.uid()`, requires an admin membership of that specific company (a company that does not exist gives the same `PH_NOT_ADMIN`), locks the company row, checks the name, refuses approved runs, then deletes entries, runs, employees, memberships and the company in that order, in one transaction. Soft-deleted rows are deleted and counted too. No delete policy or grant was added to `companies` or `company_members`.
- The name parameter was added beyond the request: the database refuses a delete whose name does not match, so it cannot be triggered by an id alone.
- Error tokens: `PH_NOT_SIGNED_IN`, `PH_NOT_ADMIN`, `PH_NAME_MISMATCH`, and until migration `0007` `PH_HAS_APPROVED_RUNS`.
- Dashboard: a "Danger zone" at the end of Settings, shown only to an admin of the selected company. The dialog requires the gate to be open before it reads or shows anything, lists what will be removed (employees, runs, entries including soft-deleted ones, and other members), and keeps Delete disabled until the exact name is typed.
- Afterwards: `forgetCompany()` removes every cached query that mentions the company, locks the gate (reason "cleared", shown without a message), drops the company from the cached list and clears the remembered selection; the dashboard selects another company if there is one. Nothing about the company is logged or persisted.

**Company profile and Links (added 2026-10-04, on request)**
- Two per-company features managed by admins and readable by members: custom company details and a list of links. Each has its own sidebar page, between Transfer log and History. No columns are ever created from the app: every detail or link is a row.
- Database: `public.company_details` (migration `0005`) and `public.company_links` (migration `0006`), both with `company_id … on delete cascade`, RLS, grants to `authenticated` only, nothing to `anon`, and `truncate`, `references`, `trigger` revoked. Both have an `updated_at` trigger (`public.set_updated_at`). Both migrations can be run again safely.
- `company_details`: label (trimmed, 1 to 80, unique per company), value (up to 2000), `field_type` in text / link / email / phone / date / number, `is_sensitive`, `sort_order`. The select policy is `is_company_admin(company_id) or (not is_sensitive and is_company_member(company_id))`, so a viewer never receives a sensitive row: no label, no value, no count. Writes are admin-only.
- `company_links`: title (1 to 80), url (must match `^https?://`, trimmed, up to 2000), description (200), category (40), icon and accent (keys, not CSS), `is_pinned`, `sort_order`, `unique (company_id, url)`. Members read, admins write.
- Core fields: admins may edit a company's name, address and VAT, not its BRN. Migration `0005` enforces this by replacing the table-wide UPDATE grant on `companies` with a column grant on `(name, address, vat)`. The BRN is changed only in the SQL editor, because imports are matched by it. `import_payroll_run` and `create_company` are unaffected (checked).
- Sensitive details in the dashboard: the page reads sensitive rows without their `value` column. Values are fetched only for an admin, with the password gate open, after asking to reveal or edit one (query key `company-details-sensitive`, in `GATED_QUERY_KEYS`). They re-mask and leave memory on lock, company change and sign-out. The page shows "Don't store passwords here."
- Links in the dashboard: cards grouped by category, pinned first, search, drag-to-reorder within a group (`@dnd-kit`) plus Move up / Move down, an icon picker over a fixed set of bundled lucide icons, a fixed six-colour palette. URLs are normalised before saving (trim, lower-case host, drop trailing slash) so the unique constraint catches near-duplicates. "Copy links from another company" skips addresses the target already has and reports how many were skipped. Cards open with `target="_blank" rel="noopener noreferrer"`; nothing is fetched for them. Each link is in the command palette as "Open <title>". The list refetches after every change and on window focus.
- Database page: both tables are read-only tabs; every `company_details.value` is masked until revealed and is never searched. Counts tolerate a missing table (shown as a dash).
- Delete company: unchanged function. The cascade removes details and links in the same transaction (tested locally against Postgres). The preview counts them, and treats a missing table as zero so deleting still works before `0005`/`0006` are run.
- A missing table (PGRST205 or 42P01) is reported as "not set up yet", naming the migration file to run.

**Delete company: approved runs no longer block it (changed 2026-10-05, on request)**
- Rule: a company can be deleted whatever its runs look like (approved or draft, soft-deleted or not). The admin must type the company's exact name for EVERY company, with or without runs. The password gate still comes first.
- Database: migration `0007_delete_company_any_runs.sql` replaces `public.delete_company(p_company_id uuid, p_confirm_name text)` with `create or replace` (same signature, so grants stay; the file repeats the revoke and grant and is enough on its own). The approved-run check is gone. Everything else is as in `0004`: SECURITY DEFINER, `search_path = ''`, null `auth.uid()` rejected, admin of that specific company required, company row locked, name compared after `btrim` on both sides and case-sensitive (`PH_NAME_MISMATCH`), one transaction.
- It now deletes from every table by name, in this order: `payroll_entries`, `payroll_runs`, `employees`, `company_details`, `company_links`, `company_members`, `companies`. It returns counts only, now including `details` and `links`. `PH_HAS_APPROVED_RUNS` is no longer raised. It needs `0005` and `0006` to have been run.
- A table added later that references `companies` must be added to the function in a new migration. `src/features/company/deleteCompanyMigration.test.ts` reads the migration files and fails until it is.
- Dashboard: the "can't be deleted while it has N approved runs" panel is gone. The dialog shows the company name, the counts (runs say how many are approved), an extra line "N approved runs will be deleted permanently." when there are any, and "This cannot be undone from the dashboard." The box is labelled "Type the company name to confirm"; "Delete company" is disabled until the name matches (trimmed, case-sensitive); a hint shows under the box while it does not. Cancel has focus by default, Escape closes, focus returns to the "Delete ..." button, Enter submits only on a match.
- If the dashboard meets a database that still has the `0004` function, `PH_HAS_APPROVED_RUNS` is shown as "The database needs an update", naming the file to run.
- Checked in a real Postgres with fake data, as part of `npm test` (`src/features/company/deleteCompany.db.test.ts`, 35 tests, migrations `0001` to `0007`, using PGlite as a dev dependency; the roles, `auth.users` and `auth.uid()` are stand-ins and the migrations run as a non-superuser): viewer, non-member, admin of another company, missing user and `anon` are refused; nine wrong names are refused when calling the function directly; a company with a draft run, an approved run, a soft-deleted approved run and a soft-deleted draft run is deleted; no row is left in any table with a foreign key to `companies` (found from the catalogue) and no entry is orphaned; the other company is untouched; a failure at the last step rolls everything back.
