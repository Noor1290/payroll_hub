# Payroll Hub

A static dashboard that connects standalone payroll apps, shows whether they are up, and moves data between them. It runs entirely in the browser (React, Vite, TypeScript) and stores payroll runs in Supabase. There is no backend of its own.

- Live site: https://noor1290.github.io/payroll_hub/
- Full specification and the decisions made along the way: [docs/BRIEF.md](docs/BRIEF.md)
- Connecting an app: [docs/INTEGRATION.md](docs/INTEGRATION.md)

## Read this first: the same-origin risk

The dashboard and every app it embeds are served from one origin, `https://noor1290.github.io`. Browsers isolate by origin, so here there is **no isolation**:

- An embedded app can reach the dashboard's page, the payroll data it holds in memory and the signed-in session. The iframe sandbox does not prevent this when the origin is shared.
- Any other site published under the same GitHub account shares the same browser storage.
- The checks in the message bridge (which window, which origin, which app) prevent mix-ups and accidents. They are not a defence against a hostile or compromised app on that origin.

So: **only embed apps you control, and treat every site under that account as part of the same trust boundary.** The way out is to host the dashboard on an origin of its own; see [Moving the dashboard to its own origin](#moving-the-dashboard-to-its-own-origin).

## Run it locally

```bash
npm install
cp .env.example .env    # then fill in the two Supabase values
npm run dev             # http://localhost:5173/payroll-hub/
```

| Command             | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `npm run dev`       | Dev server with your Supabase project and real sign-in                      |
| `npm run dev:demo`  | Dev server with fake data, a fake sign-in and mock apps. Development only.  |
| `npm run lint`      | ESLint                                                                      |
| `npm run typecheck` | TypeScript, strict                                                          |
| `npm test`          | Vitest                                                                      |
| `npm run build`     | Type-check and build to `dist/`                                             |
| `npm run preview`   | Serve the built `dist/` locally                                             |

Demo mode (`npm run dev:demo`): click **Enter demo workspace** on the sign-in page; the password gate accepts the word `demo`. It exists only in the dev server. A production build contains none of it, and the deploy workflow fails if any is found.

### Environment variables

| Variable                    | Required | Meaning                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | yes      | Your Supabase project URL                                                 |
| `VITE_SUPABASE_ANON_KEY`    | yes      | The project's **public anon key**. No other key belongs in this project.  |
| `VITE_IDLE_TIMEOUT_MINUTES` | no       | Default minutes without activity before sign-out (15). 0 switches it off. |
| `VITE_BASE_PATH`            | no       | Path the site is served from. Default `/payroll-hub/`                     |
| `VITE_DISABLE_CSP`          | no       | `true` leaves out the Content Security Policy tag. Troubleshooting only.  |

`.env` is gitignored. **This repository is public**: only fake data belongs in `samples/`, and no real payroll export should ever be committed.

## Set up the database

The schema lives in `supabase/migrations/`. Run each file once, in order, by pasting it into the Supabase SQL editor. The dashboard never creates or alters tables.

1. `0001_initial_schema.sql`: tables, row-level security, grants.
2. `0002_import_payroll_run.sql`: the function that saves an import as one all-or-nothing step.

Then:

1. In Supabase, under **Authentication**, switch off sign-ups and create your user (tick "Auto Confirm User"). The dashboard has no sign-up screen.
2. Create your first company and make yourself its admin: un-comment the "FIRST-TIME SETUP" block at the end of `0001_initial_schema.sql`, change the email, and run it.
3. Add other people the same way, as `admin` or `viewer`, in `company_members`.

Supabase pauses free projects after a period of inactivity. The dashboard then says it can't reach the database; resume the project from the Supabase dashboard.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy.yml` checks every push and pull request (lint, typecheck, tests, build) and publishes `main` to GitHub Pages.

One-time setup:

1. Create a repository under the account that owns the apps, and push this code to its `main` branch. This one is `payroll_hub`.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open **Settings → Secrets and variables → Actions → Variables** and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Both are public by design, so Variables is the right place (Secrets with the same names also work).
4. In Supabase, under **Authentication → URL Configuration**, set the Site URL to `https://noor1290.github.io/payroll_hub/`.
5. Push to `main`, or run the workflow by hand from the **Actions** tab. The site appears at `https://noor1290.github.io/payroll_hub/`.

The published site's path follows the repository's name automatically. Locally the dev server uses `/payroll-hub/` unless `VITE_BASE_PATH` says otherwise; the two don't need to match.

## What is in the dashboard

| Screen         | What it is for                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Overview       | Headline figures, recent runs, app status and recent transfers                                   |
| Import         | Drop payroll JSON exports, see every problem by row and field, and save a file as a run (admins) |
| Data explorer  | A run's employees and figures in a grid. Behind the password gate.                               |
| Transfer       | Pick rows and columns, map them to what an app expects, preview, and send                        |
| Workspace      | The connected apps in tabs, kept loaded while you move around                                    |
| Transfer log   | What was sent where in this session. No payroll values, memory only.                             |
| History        | Every run of the selected company                                                                |
| Database       | A read-only look at the raw tables (admins). Behind the password gate.                           |
| Settings       | Theme, lock and sign-out times, saved mappings, the app list, clear in-memory data               |

Press Ctrl+K (Cmd+K on a Mac) anywhere for the command palette.

## Security model

**The database's security rules are the real enforcement.** Every table has row-level security: a signed-in user can read only the companies they are a member of, and only admins can write. Everything the dashboard does in the browser (hiding buttons from viewers, masking columns, the password gate) is there to help the person using it. None of it is a security boundary, and none of it should be relied on as one.

What the dashboard does on top of that:

- It only ever uses the public anon key and acts as the signed-in user.
- Payroll figures are held in memory only: never in `localStorage`, `sessionStorage`, IndexedDB, URLs or logs. They are wiped on sign-out, and Settings has a button to wipe them at any time.
- The sign-in session is kept in `sessionStorage`, so it ends when the browser closes. You are also signed out after 15 minutes without activity (changeable in Settings).
- National IDs and salary columns are masked until revealed.
- Payroll numbers are stored exactly as the payroll app exported them. Nothing is recalculated or corrected.
- Everything that crosses a boundary (files, messages from apps, database responses) is validated first. A mismatch is shown as an error, never as data.
- The published site carries a Content Security Policy: it runs only its own scripts, talks only to itself and the Supabase project, and embeds only the registered apps' origin. No third-party scripts, fonts or trackers are loaded.

### The password gate

The data explorer, the Database page, and sending a saved run to an app ask you to **confirm your password** first. After that they stay open for 10 minutes (1 to 30, set in Settings), then lock again.

- The window is fixed: it is counted from the moment you unlock and is not extended by activity.
- It also locks when you sign out, when you are signed out for inactivity, when the session expires, and when the tab has been in the background for more than two minutes.
- Locking removes the employee rows from memory; unlocking fetches them again. You stay signed in the whole time.
- If an app asks for a saved run while the gate is locked, the dashboard asks you to unlock. If you don't, the app is told the dashboard is locked.
- The password is checked by signing in on a separate, throwaway connection that keeps nothing and is signed out immediately. Your main session is not touched. The password is never stored or logged.

**This gate is a convenience layer** for a shared or unattended screen. It does not protect the data from someone who has your session: the database's security rules remain the real enforcement, and they apply whether the gate is open or closed.

To put another screen behind the same gate, wrap it in `<PasswordGate what="…">`; for a single action, use the `useUnlock()` hook (`src/features/unlock/`). If the new screen caches data, add its query key to `GATED_QUERY_KEYS` in `src/lib/queryClient.ts` so locking wipes it.

### The Database page

An admin-only, read-only view of the raw tables for the selected company: `companies`, `employees`, `payroll_runs`, `payroll_entries` and `company_members`. It is there to check what is actually stored, without opening the Supabase dashboard.

What it does:

- Sits behind the password gate above, with the same unlock window and the same locking rules. When it locks, the rows leave memory.
- Shows one table per tab, with its row count, search, sorting and paging. It asks the database for one page at a time, so it works on tables of any size.
- Masks national IDs and every salary or deduction figure until you reveal a cell, or everything, yourself. They are masked again whenever the page locks or you switch company.
- Opens any row as JSON in a side panel, with a copy button. The JSON is masked the same way, and Copy copies exactly what is shown.
- Shows soft-deleted rows, with a badge, only when you tick "Show deleted". An entry counts as deleted when its run is.
- Re-reads what it is showing every 15 seconds (5 to 120, set in Settings), keeping your page, sort, search and scroll position. It pauses while the tab is in the background or the page is locked. There is also a Refresh button.

What it deliberately cannot do:

- **Change anything.** There is no edit, insert or delete, and no place to type SQL. The code behind it only issues reads.
- **Look outside the selected company.** Every query is scoped to it; entries are reached through their run.
- **Read user accounts.** It never touches `auth.users`. A user appears only as the first eight characters of their id.
- **Remember what it showed.** Rows are kept in memory only: nothing goes to `localStorage`, `sessionStorage`, IndexedDB or the console.
- **Use Supabase Realtime.** Refreshing is plain polling.
- **Replace the database's own rules.** Hiding the page from viewers is a courtesy. A viewer could still read the same tables through the API, because the security rules allow members to read their company's data. If viewers must not see something, that has to be changed in the database rules, not here.

## Test the security yourself

Do this after any change to the migrations, and once after the first deployment. It needs three accounts: an admin of a company, a viewer of the same company, and a user who is a member of nothing.

1. **The non-member must see nothing.** Sign in as that user. The company switcher should say "No company", the Overview should say you are not a member of any company, and Import should say it needs an admin role.
2. **Check it at the API, not just on screen.** While signed in as the non-member, open the browser's developer tools, go to the Network tab, and reload. Every response from `…supabase.co/rest/v1/…` should be an empty list `[]`. This is the check that matters: it shows the database, not the page, is refusing.
3. **The viewer can read but not write.** Sign in as the viewer. Runs and employees should be visible. There should be no Approve, Delete run or Save buttons, the Database item should be missing from the sidebar, and Import should refuse.
4. **The viewer cannot write at the API either.** As the viewer, in the SQL editor's "Run as user" (role impersonation) or with any API client using the viewer's session, try `update payroll_runs set status = 'approved'`. It should change 0 rows. Calling `import_payroll_run` should fail with `PH_NOT_ADMIN`.
5. **Signed-out access is refused.** In a private window, request `https://<project>.supabase.co/rest/v1/companies?apikey=<anon key>`. It should return a permission error or an empty list, never data.

If any of these shows data it shouldn't, the fault is in the database rules. Fix it in a new migration; changing the dashboard would only hide it.

## Add a new app

Everything is driven by the registry in `src/config/apps.config.ts`. Add one entry:

```ts
{
  id: "timesheets",                         // short, lowercase; the app uses it in init({ appId })
  name: "Timesheets",
  description: "What it does, in one line.",
  url: `${HOSTING.apps}/timesheets/`,       // keep the trailing slash
  icon: Clock,                              // any lucide-react icon
  accentColor: "var(--accent)",
  status: "active",                         // or "coming-soon" while it has no URL
  accepts: [PAYROLL_RESULT],                // data types it can receive
  produces: [],                             // data types it can send to the dashboard
  protocolVersion: PROTOCOL_VERSION,
  expectedFields: payrollExportFields,      // the row shape it wants; see the file for the format
},
```

That is all the dashboard needs: the Workspace tab, the status dot, the "Send to…" menu, the transfer wizard's destinations and mapping, and the command palette are generated from it.

In the app itself, add the bridge as described in [docs/INTEGRATION.md](docs/INTEGRATION.md). If the app is served from an origin that isn't already listed, the Content Security Policy picks it up from `HOSTING.apps`; for a second apps origin, pass it to `buildCsp` in `vite.config.ts`.

## Add a field

When the payroll app starts exporting a new field:

1. **Do nothing first.** A field the dashboard doesn't know is kept as it is in `payroll_entries.extra`. Imports keep working, and the field shows in the grids as an extra, masked column.
2. **To give it a label, a type or an unmasked column**, add it to `PAYROLL_FIELDS` in `src/config/payrollFields.ts`. That one list drives the import, the grids and what apps are told to expect. Only fields with a database column belong there.
3. **Only if it must be searchable or sortable in the database**, add a column: write a new file in `supabase/migrations/` (`alter table public.payroll_entries add column …`), update `import_payroll_run` in the same migration so it writes the column, add the column name to `NUMERIC_COLUMNS` (or handle it like `age_60_plus`), and run the migration by hand. Never run schema changes from the app.

Prefer step 1 or 2. A new column is a schema change that every environment has to apply.

## Moving the dashboard to its own origin

This is what removes the same-origin risk: with the dashboard on a different origin from the apps, the browser stops the apps from reaching into it, and the message bridge becomes the only channel between them.

1. Host the dashboard somewhere with its own origin: a custom domain on GitHub Pages, or a different GitHub account. A different repository under the same account is **not** a different origin.
2. In `src/config/origins.ts`, set `HOSTING.dashboard` to the new origin. Leave `HOSTING.apps` as it is.
3. In `docs/bridge.js`, change the `HUB_ORIGIN` line to the same value. A test fails if the two differ.
4. Set `VITE_BASE_PATH` for the new address (often `/`), and update the Site URL in Supabase.
5. Redeploy the dashboard, then copy the new `bridge.js` into every app and redeploy them. Until an app has the new file it will show as "Bridge not installed".

Nothing else changes: both sides already address each other by exact origin, and the checks on every message stay the same. Afterwards, the iframe sandbox and the bridge's source and origin checks become real boundaries rather than tidiness.

## Project layout

```
src/
  config/      apps.config.ts (registry), payrollFields.ts (field mapping), origins.ts, csp.ts, env.ts
  lib/         supabase/ (client, queries, validation), bridge/ (hub and protocol), unlock.ts, storage.ts
  features/    auth, company, overview, import, explorer, history, transfer, workspace,
               database, settings, unlock, theme
  components/  shared UI (PayrollTable, ui/…)
  app/         shell, sidebar, top bar, command palette
docs/          BRIEF.md, INTEGRATION.md, bridge.js (copied into each app)
supabase/      migrations/ (run by hand in the SQL editor)
samples/       fake payroll exports for trying things out
dev/           mock apps for demo mode (not part of the build)
```

## When something looks wrong

| You see                                             | What it means                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Can't reach the database"                          | You are offline, or the Supabase project is paused. Resume it in the Supabase dashboard.              |
| "The import function isn't installed"               | Run `supabase/migrations/0002_import_payroll_run.sql` in the SQL editor.                              |
| "You're not a member of any company yet"            | Your user has no row in `company_members`.                                                            |
| An app shows "Bridge not installed" (violet ring)   | The app loaded but has no `bridge.js`, or an old one. See docs/INTEGRATION.md.                        |
| An app shows "Not connected (local run)"            | Expected on `localhost`: the live apps only answer the deployed dashboard. Use `npm run dev:demo`.    |
| "The database returned something unexpected"        | The schema no longer matches what the dashboard expects. Nothing is shown rather than risk bad data.  |
| Something is blocked on the published site only     | Check the browser console for a Content Security Policy message; `VITE_DISABLE_CSP=true` rules it in or out. |
| `npm test` fails every file with "reading 'config'" | Vitest and a lowercase drive letter on Windows. `npm test` already works around it; don't call `vitest` directly. |
