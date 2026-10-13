# Future work

Written at the end of a long session so nothing gets lost. Tick items off as they are done.
Rule for everything below: use FAKE data only (the repos are public), never put a service-role key anywhere, and test in the deployed hub, not just locally.

## 0. Check where things stand (verify first, I did not confirm all of these)

- [ ] payroll_sys: `redesign` branch merged into `main`, pushed, deployed, and tested inside the hub (hard refresh, Ctrl+Shift+R)
- [ ] payroll_sys: "Send to dashboard" visible and working in the hub (button next to the export controls)
- [ ] pdf-form-filler: bridge installed (`PayrollHubBridge.init`, "Get from dashboard", waiting-data notice and import preview)
- [ ] Full flow tested with fake data: Send to dashboard -> "results received" -> Save to database -> send to PDF Form Filler
- [ ] Hub features built and checked: Database page (with password gate), Add company, Delete company, Company profile, Links
- [ ] Migrations 0002 onward all run on the dev Supabase project, in order
- [ ] Sign-ups still switched off in Supabase (Authentication -> Sign In / Providers)
- [ ] payroll_sys Column Setup: employee NSF fixed (see section 9a)
- [ ] payroll_sys Column Setup: employee NSF = 0 when Age 60+ ticked (check the COMPANY setup too)
- [ ] payroll_sys: columns renamed to "Employee CSG" and "Employee NSF"; second "PAYE" renamed "PAYE (calculated)"
- [ ] Payslip app: phases tracked in the payslip repo (CLAUDE.md status); hub changes tracked in docs/HUB_CHANGES.md

## 1. pdf-form-filler redesign (not started)

Use `redesign-prompt-pdf-form-filler.md`. Start a FRESH Claude Code session in that repo (no old context, saves usage), run `/model opusplan`, and put this line at the top of the prompt:

```
Usage note: at most 3 screenshots per step, prefer scripted checks, keep replies short, and run the keyboard, label, encoding and visible-text checks as scripts from the start.
```

Lessons from the payroll_sys redesign to ask for from the start:
- Safety-net test first (fake data, recorded field mapping and filled PDF field values, not raw bytes), proven to fail on a deliberate change.
- Encoding check on every commit (a script once corrupted "->" and "-" characters).
- Visible-text comparison against the last pre-redesign commit; every change must be on an approved list.
- Keyboard helper for dialogs and menus (focus trap, Escape, focus returns), labels on every control, contrast and reduced-motion checks.
- PDF preview stays untouched: no blur, glow, tint or overlay on or behind the rendered pages.
- Work on a `redesign` branch; do not push or merge until I say so.

## 2. Known issues to fix (each on its OWN branch from main)

These change calculations or exports, so the safety-net recordings must be updated on purpose, one issue at a time. Detail and evidence are in `docs/KNOWN_ISSUES.md` in payroll_sys.

Before real payroll:
- [ ] Growing exemption formula (issue 4): re-saving a Simple formula with an exemption wraps the exemption again each time. Value stays right, formula text and Live-Formulas export keep growing. Until fixed, avoid re-saving those columns and check the Live-Formulas export.
- [ ] One-cent rounding difference: columns are rounded for display, Total deductions sums unrounded values (fake employee F001: 502.88 vs 502.87). Confirm the correct statutory rounding rule for Mauritius payroll BEFORE choosing the fix. This now also affects the payslip app: it adds the lines shown, the payroll adds unrounded values, so totals can differ by 0.01. The payslip labels exact 0.01 differences "rounding" and lets you accept them in bulk; fixing the rule here removes the need.

When convenient:
- [ ] Slow typing: immediate up to about 50 employees, about 0.2 s per keystroke at 100, 0.7-0.8 s at 400 (production build). Only matters if companies are large.
- [ ] Import accepts a renamed non-Excel file without an error.
- [ ] Narrow width: double-click rename of a company is hard to use because the drawer closes on selection (rename works from Company Details and at wide widths).
- [ ] Export preview: company name and date are centred over the full sheet width, so they sit off-screen until you scroll right on a wide sheet.
- [ ] Possible feature: on-screen grand total on Totals, reusing the Excel export's TOTAL row calculation so both always match.

Prompt for the first two (paste after the redesign is merged):

```
Usage note: at most 3 screenshots per step, prefer scripted checks, keep replies short.

The redesign is merged into main. Now fix two items from docs/KNOWN_ISSUES.md, each on its OWN branch created from main (fix/rounding and fix/exemption-formula). Do not push or merge anything; I will. Do the exemption-formula fix first.

These two changes deliberately alter calculations or exports, so the safety-net recordings will change. Update a recording only for the specific outputs that are meant to change, show me the diff of each recording before committing, and confirm nothing else in the recordings moved. Do not touch bridge code, the PDF-fill field names or the key order of the exported JSON.

1. fix/exemption-formula (known issue 4)
- Re-saving a Simple formula that has an exemption wraps the exemption around the formula again each time. Make saving idempotent: saving a column without changing it must leave its stored formula text byte-for-byte identical.
- Add a test with fake columns: save the same column 10 times and assert that the stored settings, the formula text shown in the list, the calculated values and the Live-Formulas export text are identical every time.
- Columns already saved with the wrapped formula: do not rewrite stored data automatically. Show me how many fake columns in the test data are affected and propose a cleanup (for example a one-time "Tidy formula" action) for my approval.
- Calculated values for every existing recording must be unchanged. Only the formula text of re-saved columns may differ.

2. fix/rounding (known issue 1)
- First do NOT change any code. Show me, with fake employee F001 and two more fake employees, the current behaviour: each column's displayed (rounded) value, the unrounded value, and how Total deductions is computed. List the options (A: sum the displayed, rounded column values; B: round the sum of unrounded values; C: another approach) with the one-cent consequences of each for those employees, the exports and the Send to dashboard payload. Wait for my choice, because the correct rule depends on the statutory rounding for payroll in Mauritius, which I will confirm.
- After I choose: implement it in one place, add tests that hand-calculated examples add up on screen, in the Excel export, in the PDF-fill JSON and in the Send to dashboard message, and update only the affected recordings.

For each branch, finish with: tests passing, the encoding check, the text check, and a short summary. Stop after each branch.
```

After each fix: compare two or three fake employees against a hand calculation (screen, Excel export, PDF-fill JSON), merge one branch at a time, test in the hub.

## 3. Moving PDF templates and payroll data from the browser into Supabase

Replaced on 12 Oct 2026. The earlier version of this section (PDF layouts first without the files, explicit "Save to cloud" / "Load from cloud" buttons, draft and publish for column setups) no longer applies. The full plan, with the measurements, table sketches, import steps and tests, is `docs/MIGRATION_PLAN.md`.

Why: the payroll app and the PDF form filler keep everything in one browser's storage, with no backup and nothing shared between two people. Measured with fake data, payroll data is small (400 employees for 12 months is about a fifth of the storage); PDF files are what fill it (one 3.8 MB form uses all of it).

Still true: the apps stay frontend-only and never talk to Supabase; saving and loading goes through the dashboard and the bridge. Opened standalone, the apps behave exactly as today, from browser storage, and the manual exports stay as the fallback.

Decisions made (12 and 13 Oct 2026; nothing is left to confirm):
- Order: PDF templates first, then the payroll column setup and companies, then payroll monthly data.
- PDF files go in a private Supabase Storage bucket (5 MB per file), named by their content hash, not in a table. The hash and page count are the fingerprint that detects a revised government form.
- Saving is automatic inside the dashboard. No Save or Load buttons for the database. The app always shows "Saved", "Saving" or "NOT saved".
- Existing browser data is imported once, started by the user: backup file first, a preview that writes nothing, one item at a time, a check that what was stored equals the browser copy, and the browser copy kept as the fallback.
- Global columns keep working as now: one shared setup, and a change reaches every company. The shared setup (identity fields and Global columns) is a record of its own that companies are attached to. Read: any member of an attached company. Change: only an admin of every attached company.
- No draft and publish for column setups. Every save is a kept, numbered revision, and each month records the revisions it was saved with.
- Payroll monthly data: admins only, behind the password gate, no prompt on each load. If the gate is locked, the save is refused, nothing is stored, and it is saved once the dashboard is unlocked. When the gate locks, the payroll app covers the month's table; what was typed stays in memory.
- The password gate locks after 10 minutes of inactivity (1 to 30 in Settings), not 10 minutes after unlocking. It uses the same activity signal as the sign-out, including the `activity` message from the apps, so it never locks while someone is typing in any app.
- After the import the browser copy is kept, untouched, as the fallback, labelled "This browser only. Not the dashboard's copy." Removing it is a later, separate action, only after a backup file exists.
- Companies are linked by BRN, only where the user is an admin of the dashboard company. The import never creates a dashboard company and never overwrites its details: differences are shown. A manual "Link this company to..." covers a missing or mismatched BRN.
- A PDF template belongs to the company selected in the dashboard, with "Copy to another company". Shared templates stay a later item.
- Buttons the apps already have ("Save template", "Save" in company details) save to the database inside the dashboard. No new Save or Load buttons.
- PDF templates: the values last typed and the People list are NOT moved in this migration; they stay in the browser.
- Every write carries the revision the user last saw; a save over someone else's newer one is refused, never merged silently.

Found on 12 Oct 2026, to fix before the monthly-data phase at the latest: typing inside an app's frame does not count as activity for the dashboard's sign-out (src/lib/idle.ts listens on the dashboard's own window only). Tested in demo mode with the idle time at 1 minute: a click and a key every 3 seconds inside the frame, signed out after about 75 seconds. Planned fix: a new bridge message, `activity`, sent by bridge.js at most once every 30 seconds while the user works in the app, treated by the dashboard like its own activity. Addition to protocol version 1; the new bridge.js is then copied into the three apps.

Order of work (each step stops for review; each migration is run by hand before the code that needs it is deployed):
- [x] 0a. Full backup file (export and import) in pdf-form-filler and payroll_sys. Done 13 Oct 2026: "Back up" and "Restore" in each app.
- [x] 0b. A storage interface in both apps, with no change in behaviour. Done 13 Oct 2026.
- [x] 0c. The `activity` bridge message, and the password gate locking after inactivity on the same signal. Done 13 Oct 2026 (src/lib/activity.ts); the new bridge.js is in the three apps. Deploy the dashboard before the apps.
- [ ] 1. Migration 0012 (pdf_templates, pdf_template_history, bucket `pdf-forms`), data types `pdf-template` and `pdf-file`, then pdf-form-filler. Built 13 Oct 2026 on `migration-phase-1` in both repos (see MIGRATION_PLAN.md 5.12). Still to do: run 0012 by hand, test against the real database, merge, deploy; and the items listed there as not built.
- [ ] 2. Migration 0013 (payroll_shared_setups, payroll_company_setups, their history), data type `payroll-setup`, then payroll_sys.
- [ ] 3. Migration 0014 (payroll_months), data type `payroll-month` behind the gate, then payroll_sys.

Later, not part of this migration:
- [ ] pdf-form-filler: an option to clear the People list after a download.
- [ ] Move the values last typed and the People list out of browser storage altogether.
- [ ] One shared PDF template for several companies, with company details kept apart.
- [ ] Remove the browser copy after an import.

This also settles the open question in section 7 (Automator) about where the blank PDF lives: in the bucket.

## 4. Statutory rates with effective dates (CSG, NSF, ceilings, thresholds)

Idea: stop hard-coding yearly rates inside column builders. Decision: do NOT scrape the MRA website. Reasons: the MRA disclaimer says the content remains its property and that information is for general use and relied on at your own risk; a layout change could make a scraper read a wrong number silently (every payslip wrong); a web page is not the legal source (the legislation is); rates change about once a year; and browsers cannot read another site's pages from GitHub Pages (CORS) anyway. For a specific question about automated access, ask the MRA (the disclaimer lists 207-6000).

Plan (updated 6 Oct 2026): a SHARED `statutory_rates` table now exists as a design (docs/HUB_CHANGES.md item 6): per company, insert-only, effective-dated, generic column names. The payslip app uses it first, as a warning-only cross-check. Later the payroll app reads its rates from it through the hub (dataType "statutory-rates").
- A rates table with effective dates, a source note (for example the Act or Finance Act reference) and who entered it. The payroll app uses the rate valid for the month being processed, so old months still recalculate correctly after a rate change.
- Admin enters new rates by hand, with a review screen showing old and new values side by side. A correction is a new revision row, never an edit.
- Optional: a weekly GitHub Action that checks one MRA page and only NOTIFIES that it changed. It never changes a rate itself.
- Switching payroll_sys to the table changes calculations, so it needs its own branch, a planning step first, a deliberate update of the safety-net recordings, and proof that outputs are identical for the same rates. Do it after the redesign is merged and the two known issues are fixed.

## 5. Hub backlog

- [ ] Realtime updates (Supabase Realtime) if several people ever work at once. Reload-to-refresh is fine for now. Enable it per table, add subscriptions, and test that RLS also applies to live updates.
- [ ] Multi-factor authentication for admins (Authentication -> Multi-Factor). Much stronger than the password gate. Check the free-plan limits first.
- [ ] Same-origin risk: the dashboard and the apps share https://noor1290.github.io, so an embedded app can reach the dashboard's page and in-memory data. Acceptable while it is a personal tool on fake data. Before real employee data or other users: move the dashboard to its own origin (custom domain or a second GitHub account/org). The origin is one constant in the dashboard and one line in bridge.js; follow the README section "Moving the dashboard to its own origin".
- [ ] Payslip app: built in its own repo (see its CLAUDE.md). Hub side is docs/HUB_CHANGES.md, done in stages (items 1 and 2, then 3 to 7 with 9 and 10, then 8: all built; the last is on `feature/payslip-issue` with migration 0011 to run). The registry entry gets its URL and status "active" in item 2.
- [ ] Sync the theme (light/dark) between the hub and the apps. Needs a new bridge message in all three projects.
- [ ] Store PDF files themselves in Supabase Storage: now part of section 3 (decided 12 Oct 2026). The free plan has limited space; check it before real forms go in.

## 6. Before real payroll data goes in

- [ ] Create a SEPARATE production Supabase project, on Pro (the free plan auto-pauses after a week of inactivity and has no daily backups). Run all migrations in order. Create the real companies there, with the BRN matching what the payroll app exports.
- [ ] Choose the region (Mumbai was available) and confirm data-location expectations for the company or clients.
- [ ] Set up a regular manual export as an extra backup.
- [ ] Settle the rounding rule and the growing-formula bug (section 2).
- [ ] Never commit real national IDs, names or salaries; never paste them into chats or Claude Code. Use fake copies for all testing.
- [ ] Review the RLS policies and test as a user who is not a member of the company (they must see nothing).
- [ ] Consider the same-origin risk (section 5) before other people use it.

## 7. Automator (one-click run: database -> PDF editor -> exported PDFs)

Idea (replaces the earlier "scheduler" idea): I press a button in the hub, and the system takes the employee values from the database, sends them to the PDF editor, the editor fills the fields, and the PDFs are exported. The same mechanism should work for the future payslip app.

What already exists: the data in Supabase, row selection in the hub, the bridge that sends payroll rows to an app, and the PDF editor's import path.

What is missing:
- A new bridge command for the PDF editor (and later the payslip app), for example "run-job": fill the template with these rows and RETURN the generated PDFs. It must be a separate message from the normal import, so the existing import preview (Add to / Replace and its confirmation) is never bypassed or weakened.
- The PDF editor needs the right TEMPLATE for the job: the blank PDF plus its saved layout. Today the layout is only on the computer. So full automation depends on section 3 (layouts in the cloud, with the PDF fingerprint) AND on a decision about the blank PDF itself (store it in Supabase Storage, or the user keeps it open in the editor first).
- A hub page for it (name to decide: "Automator", "Auto-run"): choose company, run and employees, choose the target app and template, press run, watch progress, download the result.

Output options (decide later): one PDF per employee, downloaded as one ZIP created in the dashboard (the app hands the files back to the hub; the browser asks permission for many separate downloads, so a single ZIP is nicer), or one combined PDF. Optional password-protected PDFs if files will be emailed.

Safeguards (payroll data goes onto official forms and payslips, so no silent mistakes):
- Preview the FIRST employee's filled form and require a confirm before the full run.
- Check required fields and types before starting; show a per-employee report of what failed and why; never skip a failure silently.
- The run needs the password gate (it reads payroll data), and the generated PDFs live in memory only, cleared on logout and after download.
- A log of runs WITHOUT values (who, when, company, period, how many, template version).
- Recipes (company + template + app + naming) may be saved; payroll values never are.
- Test with fake data and recorded outputs, the same safety-net approach as the redesign.

Suggested order:
1. Make the manual pipeline reliable first (bridge tested end to end, the pdf-form-filler redesign done, sections 0-2 done).
2. Cloud templates (section 3).
3. Semi-automatic version: the button sends the selected employees, the editor fills them and shows the first PDF for review, then I click Export all.
4. Fully automatic version with the ZIP output, then the same for the payslip app.

Open questions: one PDF per employee or combined, where the blank PDF lives, whether templates are per company or shared, naming of the files, whether payslips use the same job format.

### Time-based tasks (optional, my earlier suggestions)

Only if wanted later. A scheduled job needs somewhere that is always on, because the apps are static pages. Options: a scheduled GitHub Actions workflow (minimum interval 5 minutes, can be delayed, and in a public repo it is disabled automatically after 60 days with no repository activity) or Supabase Cron (pg_cron; guides say it is on all plans, but a paused free project silently stops every schedule). Repos are public: jobs must never print payroll data in logs, never save data as public artifacts, and keep keys in repository secrets.
- [ ] Keep the free Supabase project from pausing (must run outside Supabase; check their terms; Pro removes the need)
- [ ] Weekly check of one MRA page that only NOTIFIES me (see section 4)
- [ ] Scheduled backup export (needs a private place to store it; consider relying on Pro backups instead)
- [ ] Payroll and filing reminders (a recurring calendar reminder is simpler)

## 8. Working tips

- `/model opusplan` plans with Opus and builds with Sonnet. Use `/model opus` only for the security-critical parts (the bridge). Claude and Claude Code share one usage pool.
- Screenshots are expensive: at most 3 per step, prefer scripted checks. Look at screens yourself in the browser.
- One phase or one fix per session; commit after each; keep CLAUDE.md short; start a fresh session for each big task.
- Keep the full briefs in the repo (`docs/BRIEF.md`) and point Claude Code at the relevant part instead of re-pasting.

## 9. Payslip app: decisions and follow-ups

### 9a. Payroll column setup problems found on 6 Oct 2026 (global setup)
- Employee NSF ("NSF - 1%", key nsf1) is 0 when the base is 29,710 or more (the tier is "below 29,710", so at or above the ceiling the rate is 0). Correct: 1% of min(base, 29,710), maximum 297.10. Fix the tier to "above 0, rate 1%, cap 29,710" and confirm the base (Gross Pay now; employer NSF uses Basic Salary). Check past payrolls for under-deducted employees.
- Age 60+ NSF exemption: owner rule is NSF = 0. Not present in the global setup; check the company setup, add it if missing.
- Rename "CSG - 1.5 %/ 3%" to "Employee CSG" and "NSF - 1%" to "Employee NSF" (keys unchanged). Rates should not be in column names.
- Two columns are named "PAYE" (keys paye and paye_other). Same-name columns overwrite each other in exports. Rename the second to "PAYE (calculated)".
- After renaming, remap anything in pdf-form-filler (saved mappings, layouts) that used the old names.
- Tick Employee CSG, Employee NSF and Company Details in the export.

### 9b. Decisions made for the payslip app
- Employee side only. Employee CSG and NSF are COPIED from the payroll columns, never calculated by the payslip. The payslip calculates only Total Earnings, Total Deductions and Net Pay by addition and checks them against Gross Pay, Total deductions and Net Pay (a mismatch blocks export; exactly 0.01 can be accepted in bulk as "rounding").
- Statutory rates settings in the payslip app are a warning-only cross-check: versioned, per company, shared table.
- CSG: 1.5% of the whole base up to and including 50,000; 3% of the whole base above (not marginal). NSF: 1% of min(base, 29,710), max 297.10; 0 for Age 60+.
- Display: 0 decimals for whole amounts, 2 for fractional, zero as "-". A4. Font TeX Gyre Pagella (check the GUST licence before real use). Output: zip of PDFs plus one Excel workbook, files named "SURNAME Other names - YYYY-MM.pdf", never the NIC.
- Issued payslips: stored per employee per month, admin only, behind the password gate, numbered revisions, never overwritten.

### 9c. Open items
- [ ] Confirm "Travelling" is the transport allowance; where Presence Bonus, Productivity Bonus, Advance, Absences and Lateness come from (new payroll columns?).
- [ ] Confirm the employee CSG threshold and strict "above" against MRA; confirm half-up vs the payroll's rounding.
- [ ] Is Advance an earning or a recovery?
- [x] Date of Employment: new column on hub employees (migration 0008), edited in the hub's Data explorer. Merged and deployed with hub Stage B; 0008 has been run.
- [ ] Payslip templates cannot be deleted or archived yet (hub Stage B left it out on purpose). Follow-up, as its own migration and branch: an `archived_at` on `payslip_templates` set through a new admin-only function (never a delete: issued payslips will point at published versions, which must stay), an "archive" / "unarchive" action on `payslip-template` saves, archived templates left out of "list" unless asked for, and a decision on whether an archived template still counts towards the 50 per company and still holds its name.
- [ ] A logo on a payslip: template bodies cannot contain images (the hub refuses a `data:` URI). Decide where a logo lives (a company detail, or its own small table with a size limit) before adding one.
- [ ] Hub Database page: show `statutory_rates`, `payslip_templates` and `payslip_template_versions` as read-only tabs.
- [ ] Hub Database page: a read-only tab for `issued_payslips` (not now). Admin only and behind the gate like the rest of that page; mask the national ID, `lines`, `rates_snapshot` and `accepted_differences`, and shorten `issued_by`.
- [ ] Display names in answers (not now). Answers say only "was it you" (`created_by_you`, `updated_by_you`, `published_by_you`, `issued_by_you`), never who. Showing a name needs a profiles table the hub does not have, and a decision on what a member may see about other members.
- [ ] Default template per company (not now): which published template the payslip app opens with. A row per company set by an admin through a function, returned with the template list.
- [ ] Revision history in a `payslip-issue` load (later). A load returns only the latest revision of each employee; earlier ones stay in the database. Add an optional way to ask for every revision of one employee and month, with its own size limit.
- [ ] Payslip lookup (VLOOKUP/INDEX-MATCH) template: "coming soon".
- [ ] Month-to-month comparison and bulk-approve (payslip Phase 5).
- [ ] Check the GUST Font License once before real use.