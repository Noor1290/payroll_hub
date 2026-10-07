# Hub changes needed by the payslip app

A to-do list for the `payroll-hub` repo. Nothing here is done from the payslip repo: each item is a separate task in the hub repo, and every SQL file is run by hand by the owner in the Supabase SQL editor. `bridge.js` is not changed by any item.

File and line references are to the hub repo as read on 6 October 2026.

## Before the payroll app sends the new columns

1. **Store and return "Employee CSG" and "Employee NSF".**
   - Today: a key that is not listed in `src/config/payrollFields.ts` is kept as it is in `payroll_entries.extra` under its original name (`src/features/import/parsePayroll.ts`, lines 184 to 188) and returned under that same name (`toExportRow`, `payrollFields.ts` lines 223 to 226). So the two keys would already pass through, but unchecked and stored as `"Employee CSG"` / `"Employee NSF"`.
   - Change: add both to `PAYROLL_FIELDS` as numbers, sensitive, NOT required (older files and runs do not have them). Store them in `payroll_entries.extra` as `employee_csg` and `employee_nsf`. Return them from `toExportRow` as `"Employee CSG"` and `"Employee NSF"`.
   - A value that is absent stays absent: never return 0 or "" for it, so the payslip app can report the missing figure. Text in either field is refused at import, like the other money fields.
   - No migration: `extra` is already `jsonb` and `import_payroll_run` (migration 0002) already saves it.
   - Add both keys to a fake sample in `samples/` and to the import and export tests.

## Payslip Phase 2 (bridge)

2. **Registry entry.** In `src/config/apps.config.ts`, give `payslip` its URL (`${HOSTING.apps}/payslip/`, trailing slash kept), set `status: "active"` and update the description. `accepts: ["payroll-result"]` is already there. Nothing else is needed for "Get from dashboard".

## Payslip Phase 3 (templates, rates, date of employment)

3. **Date of employment.** Migration `0008_employee_date_of_employment.sql`: `alter table public.employees add column date_of_employment date;`. Make it editable in the hub. Add it to payroll-result rows as `"Date of Employment"` (text, `YYYY-MM-DD`) when it is set; leave the key out when it is not.

4. **Protocol additions (still version 1, additive only)** in `src/lib/bridge/protocol.ts`, with `docs/INTEGRATION.md` updated to match:
   - `request-data` payload: an optional `params` object, validated per dataType.
   - `response-data` ok payload: `rows` may be empty for the new dataTypes. `payroll-result` keeps its minimum of one row.
   - `received` ok payload (the hub's reply to an app's `send-data`): an optional `result` object, for example the new revision number. The app's `bridge.js` already hands the reply payload through unchanged.
   - A size limit per dataType (template body, number of rows).

5. **Registry data types.** `payslip` accepts `payroll-result`, `statutory-rates`, `payslip-template`, `payslip-issue`, and produces `statutory-rates`, `payslip-template`, `payslip-issue`. Later, `payroll` accepts `statutory-rates`.

6. **`statutory-rates` (a SHARED table, not payslip-only).** Migration `0009_statutory_rates.sql`. Outline:

   ```sql
   create table public.statutory_rates (
     id                      uuid primary key default gen_random_uuid(),
     company_id              uuid not null references public.companies(id) on delete cascade,
     effective_from          date not null check (effective_from = date_trunc('month', effective_from)::date),
     revision                int  not null default 1 check (revision >= 1),
     nsf_employee_rate       numeric(7,4)  not null check (nsf_employee_rate between 0 and 100),
     nsf_ceiling             numeric(12,2) not null check (nsf_ceiling >= 0),
     nsf_exempt_at_60        boolean       not null default true,
     csg_employee_rate_low   numeric(7,4)  not null check (csg_employee_rate_low between 0 and 100),
     csg_employee_rate_high  numeric(7,4)  not null check (csg_employee_rate_high between 0 and 100),
     csg_threshold           numeric(12,2) not null check (csg_threshold >= 0),
     created_by              uuid references auth.users(id) default auth.uid(),
     created_at              timestamptz not null default now(),
     unique (company_id, effective_from, revision)
   );
   ```

   - Insert-only: members read, admins insert, no update or delete policy or grant. The rows are the change log (who, when; "old" is the previous version). A correction is a new row with the same `effective_from` and the next `revision`.
   - Names are generic so the payroll app can read the same rows later. Employer-side rates, when the payroll app needs them, are added by a later migration as new columns.
   - Not in this table: which payroll column is the base of the calculation. That is a mapping, kept in the payslip template.
   - Resolved: the higher CSG rate applies strictly ABOVE the threshold; no flag is needed.
   - Handlers: a request returns every version for the selected company; a save inserts one version after the same validation as the table checks.

7. **`payslip-template`.** Migration `0010_payslip_templates.sql`: `payslip_templates` (draft body and a draft revision number) and `payslip_template_versions` (immutable published versions, who and when). Two functions: save the draft only if the caller's revision number is still the current one, and publish. Handlers: list, load, save draft, publish. A stale save is refused with a clear message.

## Payslip Phase 4 (issued payslips)

8. **`payslip-issue`.** Migration `0011_issued_payslips.sql`: `issued_payslips` (company, employee, period, revision, template version, rates snapshot, the exact lines shown, accepted differences, who, when). Insert-only through one atomic function; admin-only read.
   - The save carries the BRN and the period. The hub refuses it if the BRN is not the selected company's.
   - Reads and saves sit behind the password gate; add the query key to `GATED_QUERY_KEYS` (`src/lib/queryClient.ts`, line 25).
   - A request with a period returns that month's issued payslips (used for the month comparison).

## For every migration above that adds a table

9. **`delete_company`.** The hub's rule: a new table that references `companies` must be added to `delete_company` (current version: migration 0007), and a test checks it. Migrations 0009, 0010 and 0011 each replace the function with the new table added.

10. **Transfer log and tests.** New data types go through `deliver()` and the transfer log with no values. Add protocol, handler and PGlite migration tests. The test that keeps `HUB_ORIGIN` equal to the dashboard origin is unchanged.

## For the owner to do by hand

11. Run migrations 0008 to 0011 in the Supabase SQL editor, in order, when their phase is reviewed. The full SQL (policies, grants, functions) is written and reviewed in Phase 3 and Phase 4; the outlines above are not complete files.
