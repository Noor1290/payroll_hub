# Pending prompts (saved 6 Oct 2026)

Do these AFTER the payslip app is built, in this order. Each block is a prompt to paste into Claude Code in the named repo. Send each report back to Claude (chat) for review before starting the next.

Context: the payslip app COPIES the employee's CSG and NSF from the payroll data (decision D1 = option A). It only calculates the three totals, and its Statutory rates page is a warning-only cross-check.

---

## 1. payroll_sys: export Employee CSG and Employee NSF

Needed before testing the payslip end to end with the hub. Wait for the payslip Claude Code's read-only report on the payroll code first (it tells where these values are calculated).

```
New branch: feature/employee-csg-nsf-export (from main, not from a redesign branch). Goal: export the EMPLOYEE's CSG and NSF as two new output columns, "Employee CSG" and "Employee NSF".

Rules:
- First, show me (file and line) where the employee CSG and NSF used in Total deductions are calculated today, and how they differ from the existing "CSG" and "NSF" columns (which I believe are the employer's share). If Total deductions does NOT use employee amounts, stop and tell me; do not fix it on this branch.
- The new columns must reuse the exact values already used in Total deductions: no second formula, no new rounding. Add a test with fake data proving Employee CSG + Employee NSF + PAYE (+ any other deductions) = Total deductions for every row, and prove the test can fail.
- Include both columns in the JSON export and in the payroll-result payload sent to the hub. Existing columns and their order must not change; record the export before and after so I can see only the two additions.
- If CSG/NSF rates are hard-coded, list where, and put the finding in docs/KNOWN_ISSUES.md (do not move them into settings on this branch).
- Fake data only. Encoding check, lint, typecheck, tests and build before committing. Do not push or merge.
Stop after with a short report.
```

---

## 2. payroll-hub: connect the payslip app

Use the numbered "hub changes" list the payslip Claude Code wrote (keep it next to this file), together with this prompt.

```
New branch: feature/payslip-app. Connect the new Payslip app (https://noor1290.github.io/payslip/). Read docs/BRIEF.md, docs/FUTURE_WORK.md and the attached hub-changes list from the payslip repo first, then give me a plan and your questions before writing code.

Scope:
1. Registry: make the payslip app active with its URL (trailing slash) and its accepted/produced dataTypes: payroll-result, payslip-template, statutory-rates, payslip-issue.
2. Payroll data: make sure "Employee CSG" and "Employee NSF" from payroll-result rows are stored in payroll_entries.extra as employee_csg and employee_nsf, and returned to apps that request payroll-result. Prove it with a fake-data test. No ALTER TABLE unless you show why it is needed.
3. protocol.ts: the additive changes from the list (optional params on requests, empty row lists for the new types, optional result on received). Existing apps must keep working unchanged; prove it with the existing bridge tests.
4. Handlers: check BRN and period against the selected company before any save; admin only for all writes.
5. Password gate: payslip-issue (saving and loading issued payslips) requires the hub password gate, like the Database page.
6. Migrations for me to run by hand, in order, each with RLS policies, grants to authenticated only, SECURITY DEFINER functions with set search_path = '', and a verification query:
   - 0008 employees.date_of_employment
   - 0009 statutory_rates: SHARED table (the payroll app will read it later), insert-only, effective-dated versions, per company
   - 0010 payslip_templates + payslip_template_versions (draft and published versions)
   - 0011 issued_payslips (insert-only through one atomic function, admin-only select, revisions never edited)
   - update delete_company (migration 0007) so it also removes the new tables' rows for that company
7. Database page: show the new tables read-only.

Rules: never run DDL from the browser; fake data only; no service-role key; postMessage exact origin and source checks, never "*"; payroll values in memory only. Lint, typecheck, tests and build before committing. Do not push or merge. Stop after the plan.
```

Order when deploying: run 0008 to 0011 in the Supabase SQL editor (and the delete_company update) BEFORE pushing the hub code. Run 0007 first if it has not been run yet.

---

## 3. LATER (after 1 and 2 work): payroll_sys reads its rates from the database

Separate project. See FUTURE_WORK.md section 4 (effective-dated rates table).

```
New branch: feature/rates-from-db. Plan only first. Goal: the payroll app gets CSG, NSF and other statutory rates from the shared statutory_rates table through the hub (request-data, dataType "statutory-rates"), instead of hard-coded values.
- The rate used is the version effective for the pay period being calculated.
- Standalone (outside the hub): use bundled defaults, clearly labelled "Unsaved defaults", and warn.
- Results must not change for the same rates: record current outputs for a fake data set first and prove they stay identical.
- List every hard-coded rate you replace. Fake data only. Do not push or merge. Give me the plan and questions before coding.
```

---

## Still to check before real data
- Sign-ups switched off in Supabase (Authentication settings).
- NSF cap: 297.00 or 297.10 (the payroll app uses min(salary, 29,710) x 1%).
- CSG threshold Rs 50,000 and strict "above": verify against MRA.
- "Travelling" is the transport allowance?
- Age 60+ NSF exemption: confirm it is correct.
- Known issues in payroll_sys and pdf-form-filler (rounding, exemption formula, data-loss items).
- Production Supabase project on Pro with backups before real payroll.