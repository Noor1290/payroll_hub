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

## 3. Cloud storage for PDF layouts and payroll column setups

Idea: store PDF field layouts (and later payroll column setups) in Supabase so boxes never have to be redrawn for the same form. The apps stay frontend-only and never talk to Supabase; saving and loading goes through the dashboard and the bridge. Opened standalone, the apps behave exactly as today (existing Export/Import Column Setup stays as the fallback and manual backup).

Decisions made:
- Start with PDF templates, layout only (no PDF files in Storage yet). Then payroll column setups.
- Explicit "Save to cloud" / "Load from cloud" buttons first. No automatic sync yet.
- PDF layouts: same person saving again overwrites their current version; a different person's save creates a new version and the earlier one is kept. Group consecutive saves by the same person within 30 minutes in the history display. Keep a "restore previous version" action.
- Payroll column setups (calculation rules): draft and publish. Draft edited freely. Publishing creates an immutable version with who and when. Only published versions can be used for a payroll run, and each payroll run records which version it used. Never overwrite a published version.
- Both: store every save behind the scenes, show the history tidily, and refuse a save if someone else changed the item since you opened it (version check, no silent overwrite).
- Store a fingerprint of the blank PDF (hash and page count) so a revised government form is detected instead of silently misplacing boxes.
- Open questions: per-company or shared templates (suggestion: per company plus "copy from another company"), how global columns fit the per-company model, how companies are linked between the apps and the hub (by BRN).

Planning prompt for Claude Code in the `payroll-hub` repo (planning only):

```
Usage note: at most 3 screenshots per step, prefer scripted checks, keep replies short.

Planning only, no code and no migrations yet. Read CLAUDE.md, docs/BRIEF.md, docs/INTEGRATION.md and the existing migrations, then reply with a plan and ALL your questions at once (lettered options).

Goal: store PDF field layouts (phase A) and payroll column setups (phase B) in Supabase, saved and loaded through the dashboard and the bridge. The apps stay frontend-only, never talk to Supabase themselves, and keep working standalone with their existing manual export/import of setups as the fallback.

Phase A: PDF templates (layout only)
- Table(s) for templates: per company, a JSON column for the field definitions (positions, sizes, names, types, mapping to payroll fields), plus a fingerprint of the blank PDF (hash and page count) so opening a PDF finds its saved layout and a revised form is detected instead of silently misplacing boxes. Do not store the PDF file itself for now.
- Versioning rule: the same person saving again overwrites their current version; a different person's save creates a new version and the earlier one is kept. Every save is also recorded behind the scenes. The history list groups consecutive saves by the same person within 30 minutes into one entry. A "restore previous version" action exists.
- Conflict check: every write carries the version the user last saw; if someone else changed it since, refuse with a clear message instead of overwriting.

Phase B: payroll column setups (do NOT build yet; design so phase A doesn't block it)
- Draft and publish: a draft is edited freely; "Publish" creates an immutable version with who and when. Only published versions can be used for a payroll run; a published version is never changed or deleted.
- Each saved payroll run records the version (or hash) of the column setup it used.
- Global columns have no equivalent in the per-company model: propose options and ask me.
- Companies in the payroll app are linked to hub companies by BRN.

Security and rules
- RLS like the other tables: members read, only admins write; grants to authenticated only; no direct DDL from the browser; migrations written for me to review and run by hand, numbered after the existing ones.
- New bridge message types (for example save-template, load-template, list-templates), validated with Zod on both sides, same source and exact-origin checks, no "*", size limits (a layout JSON must have a maximum size), an unknown-version reply, and requests answered or refused within the bridge timeout. Update bridge.js and INTEGRATION.md (protocol version bump only if needed; explain).
- Writes through the bridge need a signed-in dashboard user who is admin of the selected company; reads need membership. Decide whether saving should require the password gate and tell me why.
- Nothing from layouts or setups is stored in browser storage by the dashboard beyond what the existing rules allow.

Questions I expect you to ask me: per-company or shared templates, how the dashboard UI looks (a Templates page, plus Save to cloud / Load from cloud buttons inside the apps), what happens when a layout's fingerprint doesn't match, delete behaviour, size limits.

Also propose: the order of work, how to test it (including a test that a stale write is refused and that saving twice as the same user doesn't create a version), and what changes are needed in pdf-form-filler (a separate task in that repo, to be done after the dashboard side works with a mock app).
```

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
- [ ] Payslip app: built in its own repo (see its CLAUDE.md). Hub side is docs/HUB_CHANGES.md, done in stages (items 1 and 2, then 3 to 7 with 9 and 10, then 8). The registry entry gets its URL and status "active" in item 2.
- [ ] Sync the theme (light/dark) between the hub and the apps. Needs a new bridge message in all three projects.
- [ ] Optional: store PDF files themselves in Supabase Storage (needs its own security rules; the free plan has limited space).

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
- [x] Date of Employment: new column on hub employees (migration 0008), edited in the hub's Data explorer. Built on `feature/payslip-bridge-b`; the owner still has to run 0008.
- [ ] Payslip templates cannot be deleted or archived yet (hub Stage B left it out on purpose). Follow-up, as its own migration and branch: an `archived_at` on `payslip_templates` set through a new admin-only function (never a delete: issued payslips will point at published versions, which must stay), an "archive" / "unarchive" action on `payslip-template` saves, archived templates left out of "list" unless asked for, and a decision on whether an archived template still counts towards the 50 per company and still holds its name.
- [ ] A logo on a payslip: template bodies cannot contain images (the hub refuses a `data:` URI). Decide where a logo lives (a company detail, or its own small table with a size limit) before adding one.
- [ ] Hub Database page: show `statutory_rates`, `payslip_templates` and `payslip_template_versions` as read-only tabs.
- [ ] Payslip lookup (VLOOKUP/INDEX-MATCH) template: "coming soon".
- [ ] Month-to-month comparison and bulk-approve (payslip Phase 5).
- [ ] Check the GUST Font License once before real use.