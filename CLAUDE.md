# Payroll Hub: project memory

Static, frontend-only dashboard (React 18 + Vite + TypeScript strict + Tailwind) on GitHub Pages at
https://noor1290.github.io/payroll-hub/ (Vite `base: "/payroll-hub/"`, configurable). It connects standalone apps,
monitors them, and transfers data between them. Full spec: **docs/BRIEF.md** (read the section for the current phase, and section 12 for agreed decisions).

## Hard rules (never break these)

- No backend. Only the dashboard talks to Supabase, using the PUBLIC anon key. Never use, write or mention a service-role key, DB password or any secret.
- Never run DDL from the browser. Schema changes go in `supabase/migrations/*.sql` for the owner to run by hand in the Supabase SQL editor.
- Payroll values live in memory only. Never put them in localStorage, sessionStorage, IndexedDB, URLs, logs or analytics.
- postMessage: verify `event.source === iframe.contentWindow` AND exact origin; use the exact origin as targetOrigin, never "*"; validate every message with Zod (all apps share the origin https://noor1290.github.io, so origin alone proves nothing).
- The repo is PUBLIC: only fake sample data in `samples/`. Never commit `.env*` or real payroll JSON.
- RLS is the real security. Hide write actions from viewers in the UI, but never rely on that.
- Do not recalculate or "fix" payroll numbers. Store exactly what the payroll app exported. Trim all strings on import.
- Each app must keep working standalone. One app failing must never break the dashboard or the others.

## Apps (registry-driven, src/config/apps.config.ts)

- payroll: https://noor1290.github.io/payroll_sys/ (produces "payroll-result")
- pdf-editor: https://noor1290.github.io/pdf-form-filler/ (accepts "payroll-result")
- payslip: https://noor1290.github.io/payslip/ (accepts "payroll-result")

Keep trailing slashes. Adding an app = one registry entry.
Hosting origins live ONLY in src/config/origins.ts (and the `HUB_ORIGIN` line of docs/bridge.js; a test keeps them equal).
The bridge (src/lib/bridge) is the only code that calls postMessage. App iframes live in the shell (WorkspaceHost), not in a route.

## Stack

React Router (HashRouter), TanStack Query + Table, Zod, framer-motion, lucide-react, Radix/shadcn + cmdk, sonner, Vitest.
Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (in local `.env`, gitignored; see `.env.example`).
Session in sessionStorage; all storage keys namespaced `payroll-hub:*` (use src/lib/storage.ts). Console output only via src/lib/logger.ts.
Commands: `npm run dev` | `npm run dev:demo` (fake sign-in, dev only) | `npm run lint` | `npm run typecheck` | `npm test` | `npm run build`.
Always run tests with `npm test` (it goes through scripts/vitest.mjs; calling vitest directly can fail on Windows).
`npm run test:prove` (scripts/prove.mjs, needs a clean git tree) breaks one thing at a time and requires the matching test to fail. `baseline.test.tsx` holds recorded snapshots of what is stored and sent: read a difference before updating it.
Production builds carry a CSP meta tag (src/config/csp.ts): no inline scripts, no eval, no external hosts. Deploy: .github/workflows/deploy.yml.

## Database (already created; see supabase/migrations/0001_initial_schema.sql)

Imports are saved only through `import_payroll_run` (migration 0002, atomic, run by hand by the owner). Companies are created only through `create_company` (migration 0003, existing admins only) and deleted only through `delete_company` (migration 0007 replaces 0004's: admins of that company, typed name checked in the database, permanent, whatever its runs). A new table that references `companies` must be added to `delete_company` (a test checks). `deleteCompany.db.test.ts` runs the migrations in PGlite (dev dependency only; never import it from app code). Both are SECURITY DEFINER; never add an insert or delete policy or grant on `companies` or `company_members`. Field mapping lives in src/config/payrollFields.ts and nowhere else. A field marked `inExtra` there ("Employee CSG", "Employee NSF") is known and checked but kept in `extra`; when absent it stays absent, never "" or 0.

companies, company_members (read-only from app), employees, payroll_runs, payroll_entries (`extra jsonb` for new fields), company_details (migration 0005), company_links (migration 0006).
On `companies` the app may update only name, address and vat (column grant in 0005); the BRN changes only in the SQL editor.
Filter soft-deleted rows (`deleted_at is null`). New field? Put it in `extra` first; ALTER TABLE only if it must be queryable.

## Transfers

All data leaves through `deliver()` (src/features/workspace/deliver.ts): it writes the transfer log, enforces the password gate for saved-run data, and sends via the bridge. The log (src/features/transfer/transferLog.ts) holds no payroll values. Wizard logic is in src/features/transfer/mapping.ts (pure, tested).

## Password gate

Screens and actions that expose saved per-employee data sit behind `<PasswordGate>` / `useUnlock()` (src/features/unlock, state in src/lib/unlock.ts). Memory only, 10 minutes fixed (1 to 30 in Settings), independent of the login session. It is a convenience layer; RLS is the enforcement. New gated data: add its query key to `GATED_QUERY_KEYS` so locking wipes it.

## Company profile and Links

`/profile` (src/features/profile) and `/links` (src/features/links); reads and writes in src/lib/supabase/companyData.ts. Members read, admins write; RLS enforces both. Sensitive details: RLS hides those rows from viewers entirely (no placeholders in the UI either); for admins the value is fetched only with the gate open (`company-details-sensitive` is in `GATED_QUERY_KEYS`). Link URLs go through `normaliseUrl` (http/https only) before saving and `safeHref` before rendering; icons and colours are keys into fixed lists, never CSS or markup. No external requests for cards. Never add columns from the app: a new detail is a row.

## Database page

`/database` (src/features/database, reads in src/lib/supabase/database.ts): admin-only, read-only raw table viewer behind the password gate. Reads only, one page at a time, scoped to the selected company, validated with Zod. Never add a write, a SQL box, Realtime, or a read of auth.users to it.

## Working agreements

- Build ONE phase at a time (phases are in docs/BRIEF.md section 11). Stop after each phase, summarise what changed, and wait for review.
- Plan before big changes; ask when something is ambiguous instead of guessing.
- Keep this file lean. Put detail in docs/BRIEF.md, not here.
- Every async path needs loading, empty and error states. Respect prefers-reduced-motion. Keep it accessible (WCAG AA).
- Run lint, typecheck and tests before declaring a phase done.

## Status

(Update this at the end of each phase.)

- [x] Phase 1  - [x] Phase 2  - [x] Phase 3  - [x] Phase 4  - [x] Phase 5  - [x] Phase 6
