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
3. `0003_create_company.sql`: the function behind "Add company".
4. `0004_delete_company.sql`: the function behind "Delete company".
5. `0005_company_details.sql`: the table behind the Company profile page. It also limits what the dashboard may change on a company to its name, address and VAT (not the BRN).
6. `0006_company_links.sql`: the table behind the Links page.

Then:

1. In Supabase, under **Authentication**, switch off sign-ups and create your user (tick "Auto Confirm User"). The dashboard has no sign-up screen.
2. Create your first company and make yourself its admin: un-comment the "FIRST-TIME SETUP" block at the end of `0001_initial_schema.sql`, change the email, and run it.
3. Add other people the same way, as `admin` or `viewer`, in `company_members`.
4. Further companies can be added from the dashboard; see [Who can add a company](#who-can-add-a-company).

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
| Links          | The company's useful websites as cards. Admins manage them; everyone can open them.              |
| Company profile | Name, BRN, address, VAT and any other details worth keeping. Admins manage them.                |
| History        | Every run of the selected company                                                                |
| Database       | A read-only look at the raw tables (admins). Behind the password gate.                           |
| Settings       | Theme, lock and sign-out times, saved mappings, the app list, clear in-memory data               |

Press Ctrl+K (Cmd+K on a Mac) anywhere for the command palette. It also lists the selected company's links ("Open Tax portal").

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

### Who can add a company

"Add company" is in the company switcher and the command palette. The rule is: **only someone who is already an admin of at least one company can add another one**, and they become the new company's admin.

- A viewer cannot add companies, and neither can a signed-in user who belongs to no company. The action is hidden from them, and the database refuses them even if they call it directly.
- The very first company, and its first admin, are therefore still created by hand in the Supabase SQL editor (the "FIRST-TIME SETUP" block in `0001_initial_schema.sql`). So is giving anyone else access to a company: there is no way to add members from the dashboard.
- A company needs a name and a BRN. The BRN has to be exactly the one in that company's payroll JSON exports, because imports are matched to a company by BRN. Each BRN can belong to one company only.
- It works through one database function, `create_company` (migration `0003`), which checks the rule, creates the company and adds the admin membership in a single step. The `companies` table itself still accepts no inserts from the dashboard; the function is the only way in.
- If someone tries to add a BRN that already exists, they are told it exists, even when it belongs to a company they cannot see. That follows from BRNs being unique; nothing else about that company is shown.

### Deleting a company

Settings has a "Danger zone" for the selected company, shown only to its admins. Deleting is **permanent**: the company goes, together with every employee, payroll run and payroll entry stored for it (soft-deleted ones included) and everyone's access to it. It cannot be undone from the dashboard; the only way back is a database backup.

- **Who:** an admin of that company. Being an admin of a different company is not enough.
- **Password first:** the dialog sits behind the password gate. Until you confirm your password it shows nothing about the company and offers no Delete button.
- **You see what goes:** the dialog lists how many employees, runs and entries will be removed, how many company details and links go with them, and how many other people lose access.
- **Type the name:** Delete stays disabled until you type the company's name exactly, capitals included.
- **Approved runs protect it:** a company with any approved run cannot be deleted, whether or not that run was soft-deleted. Set each one back to draft in the Data explorer first. A deleted approved run doesn't appear there: import that month again (which brings it back as a draft), or change it in the SQL editor.
- **Afterwards:** the dashboard switches to another of your companies, or shows the "no company" state. Everything it held about the deleted company is dropped from memory and the password gate locks again.
- **How it works:** one database function, `delete_company` (migration `0004`), checks the caller's role, the name and the approved-run rule, then deletes entries, runs, employees, memberships and the company in a single transaction: all of it or none of it. The company's details and links (migrations `0005` and `0006`) are removed in the same transaction, because those tables are tied to the company with `on delete cascade`. The tables themselves still accept no deletes from the dashboard for companies or memberships; the function is the only way in.

### The password gate

The data explorer, the Database page, deleting a company, revealing or editing a sensitive company detail, and sending a saved run to an app ask you to **confirm your password** first. After that they stay open for 10 minutes (1 to 30, set in Settings), then lock again.

- The window is fixed: it is counted from the moment you unlock and is not extended by activity.
- It also locks when you sign out, when you are signed out for inactivity, when the session expires, and when the tab has been in the background for more than two minutes.
- Locking removes the employee rows from memory; unlocking fetches them again. You stay signed in the whole time.
- If an app asks for a saved run while the gate is locked, the dashboard asks you to unlock. If you don't, the app is told the dashboard is locked.
- The password is checked by signing in on a separate, throwaway connection that keeps nothing and is signed out immediately. Your main session is not touched. The password is never stored or logged.

**This gate is a convenience layer** for a shared or unattended screen. It does not protect the data from someone who has your session: the database's security rules remain the real enforcement, and they apply whether the gate is open or closed.

To put another screen behind the same gate, wrap it in `<PasswordGate what="…">`; for a single action, use the `useUnlock()` hook (`src/features/unlock/`). If the new screen caches data, add its query key to `GATED_QUERY_KEYS` in `src/lib/queryClient.ts` so locking wipes it.

### Company profile

The Company profile page shows the selected company's name, BRN, address and VAT, followed by a list of custom details: a label, a value and a kind (text, web address, email, phone, date or number). Viewers can read it. Admins can add, edit, delete and reorder details (drag, or the Move up / Move down buttons).

- **The BRN cannot be changed from the dashboard.** Admins can edit the name, address and VAT. The BRN has to match the BRN in the payroll JSON exports, because imports are matched to a company by it, so it can only be changed in the Supabase SQL editor. This is enforced in the database: migration `0005` allows the dashboard to update only the `name`, `address` and `vat` columns of `companies`.
- **Sensitive details are hidden from viewers by the database.** A detail marked "Sensitive" is not sent to a viewer at all: the row-level security rule on `company_details` leaves those rows out for anyone who is not an admin of the company. Viewers see no label, no value and no placeholder for them.
- **For admins, sensitive values are masked until revealed.** The page reads the label of a sensitive detail but not its value. Revealing or editing one needs the password gate; only then is the value fetched. Values are masked again, and dropped from memory, when the gate locks, when you switch company and when you sign out.
- **Don't store passwords here.** The page says so, and it means it: this is a place for reference numbers and contacts, not credentials. Anything an admin can reveal, any admin of that company can read.
- No columns are ever created from the dashboard. Every custom detail is a row in `company_details`. Values are kept in memory only.

### Links

The Links page shows the selected company's useful websites as cards, grouped by category, with pinned links first and a search box. Clicking a card opens the site in a new tab (`target="_blank"` with `rel="noopener noreferrer"`). Viewers can only open links. Admins can add, edit, delete, pin and reorder them (drag within a group, or Move up / Move down in a card's menu; reordering is off while a search is active).

- **Only `http://` and `https://` addresses are accepted.** The form refuses anything else (`javascript:`, `data:` and so on), the database refuses it too, and a stored address that somehow isn't a web address is treated as bad data and never becomes a link.
- **Addresses are tidied before saving**: trimmed, host in lower case, trailing slash removed. Each address can be added once per company, so `https://Example.org/tax/` and `https://example.org/tax` count as the same link. Trying to add a duplicate says so in plain words.
- **Copy links from another company** (admins) copies the links of another company you belong to into the selected one. Addresses the selected company already has are skipped, and the result says how many were copied and how many were skipped.
- **Nothing is fetched for the cards.** Icons come from a fixed set bundled with the dashboard and colours from a fixed palette. No favicons, previews or any other request goes to the linked sites until you click.
- The list is read again after every change and whenever the browser tab regains focus.

### The Database page

An admin-only, read-only view of the raw tables for the selected company: `companies`, `employees`, `payroll_runs`, `payroll_entries`, `company_members`, `company_details` and `company_links`. Every company detail value is masked there until revealed. A table whose migration has not been run yet shows a dash instead of a count and says which file to run. It is there to check what is actually stored, without opening the Supabase dashboard.

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
- **Replace the database's own rules.** Hiding the page from viewers is a courtesy. A viewer could still read the same tables through the API, because the security rules allow members to read their company's data (the one exception is sensitive company details, which the database hides from viewers). If viewers must not see something, that has to be changed in the database rules, not here.

## Test the security yourself

Do this after any change to the migrations, and once after the first deployment. It needs three accounts: an admin of a company, a viewer of the same company, and a user who is a member of nothing.

1. **The non-member must see nothing.** Sign in as that user. The company switcher should say "No company", the Overview should say you are not a member of any company, and Import should say it needs an admin role.
2. **Check it at the API, not just on screen.** While signed in as the non-member, open the browser's developer tools, go to the Network tab, and reload. Every response from `…supabase.co/rest/v1/…` should be an empty list `[]`. This is the check that matters: it shows the database, not the page, is refusing.
3. **The viewer can read but not write.** Sign in as the viewer. Runs and employees should be visible. There should be no Approve, Delete run or Save buttons, the Database item should be missing from the sidebar, and Import should refuse. Links and Company profile should show no Add, Edit or Delete buttons.
4. **The viewer cannot write at the API either.** As the viewer, in the SQL editor's "Run as user" (role impersonation) or with any API client using the viewer's session, try `update payroll_runs set status = 'approved'`. It should change 0 rows. Calling `import_payroll_run`, `create_company` or `delete_company` should fail with `PH_NOT_ADMIN`. The non-member should get the same refusal from `create_company` and `delete_company`.
5. **A viewer cannot see sensitive details, even at the API.** As an admin, add a company detail and tick Sensitive. As the viewer, open Company profile: the detail must not appear at all. Then, with the viewer's session, request `…/rest/v1/company_details?select=*`: the sensitive row must be missing from the response. Trying to insert, update or delete a row in `company_details` or `company_links` as the viewer must change nothing, and `update companies set brn = …` must be refused for everyone, admins included.
6. **Signed-out access is refused.** In a private window, request `https://<project>.supabase.co/rest/v1/companies?apikey=<anon key>`. It should return a permission error or an empty list, never data.

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
               links, profile, database, settings, unlock, theme
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
| "Adding companies isn't set up in the database yet" | Run `supabase/migrations/0003_create_company.sql` in the SQL editor.                                  |
| "Deleting companies isn't set up in the database yet" | Run `supabase/migrations/0004_delete_company.sql` in the SQL editor.                                |
| "Company details aren't set up in the database yet" | Run `supabase/migrations/0005_company_details.sql` in the SQL editor.                               |
| "Links aren't set up in the database yet"           | Run `supabase/migrations/0006_company_links.sql` in the SQL editor.                                   |
| "You're not a member of any company yet"            | Your user has no row in `company_members`.                                                            |
| An app shows "Bridge not installed" (violet ring)   | The app loaded but has no `bridge.js`, or an old one. See docs/INTEGRATION.md.                        |
| An app shows "Not connected (local run)"            | Expected on `localhost`: the live apps only answer the deployed dashboard. Use `npm run dev:demo`.    |
| "The database returned something unexpected"        | The schema no longer matches what the dashboard expects. Nothing is shown rather than risk bad data.  |
| Something is blocked on the published site only     | Check the browser console for a Content Security Policy message; `VITE_DISABLE_CSP=true` rules it in or out. |
| `npm test` fails every file with "reading 'config'" | Vitest and a lowercase drive letter on Windows. `npm test` already works around it; don't call `vitest` directly. |
