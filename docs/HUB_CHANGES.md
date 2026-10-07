# Hub changes needed by the payslip app

A to-do list for the `payroll-hub` repo, written from the payslip repo on 6 October 2026 and updated on 7 October 2026 to say what was built (Stage B, then Stage C the same day). Every SQL file is run by hand by the owner in the Supabase SQL editor. `bridge.js` is not changed by any item.

Status: items 1 and 2 are done and merged (Stage A). Items 3 to 7, 9 and 10 are done, merged and deployed (Stage B), and migrations 0008 to 0010 have been run. Item 8, with 9 and 10 for its table, is built on the branch `feature/payslip-issue` (Stage C), not merged; migration 0011 is written and still to be run.

The contract the payslip app codes against is `docs/INTEGRATION.md`, payslip section. Where this file and that one differ, that one is right.

## Before the payroll app sends the new columns

1. **Store and return "Employee CSG" and "Employee NSF".** DONE.
   - Both are in `PAYROLL_FIELDS` (`src/config/payrollFields.ts`) as numbers, sensitive, not required. They are stored in `payroll_entries.extra` as `employee_csg` and `employee_nsf` and returned by `toExportRow` as `"Employee CSG"` and `"Employee NSF"`.
   - A value that is absent stays absent: never 0 or "", so the payslip app can report the missing figure. Text in either field is refused at import, like the other money fields.
   - No migration: `extra` is already `jsonb` and `import_payroll_run` (migration 0002) already saves it.

## Payslip Phase 2 (bridge)

2. **Registry entry.** DONE. `payslip` is active at `${HOSTING.apps}/payslip/` (trailing slash kept).

## Payslip Phase 3 (templates, rates, date of employment)

3. **Date of employment.** DONE.
   - Migration `0008_employee_date_of_employment.sql` adds `employees.date_of_employment date`, optional.
   - An admin types it in the Data explorer (a column with an edit dialog per employee), behind the password gate.
   - Rows of a saved run carry `"Date of Employment"` (text, `YYYY-MM-DD`) when it is set; the key is left out when it is not.
   - An import never sets or overwrites it. When a file has a "Date of Employment" key, the import report says in one line that it is ignored and that the date is set in the Data explorer.

4. **Protocol additions (still version 1, additive only).** DONE, in `src/lib/bridge/protocol.ts`.
   - `request-data` payload: an optional `params` object (at most 2 KB), checked per data type by its handler.
   - `response-data` ok payload: `rows` may be empty for the new data types. `payroll-result` keeps its minimum of one row. `meta` may carry `brn`.
   - `received` ok payload (the hub's reply to an app's `send-data`): an optional `result` object. A refusal may carry a `code`.
   - Refusal codes added: `stale`, `no-change`, `forbidden`, `wrong-company`, `invalid`, `not-found`, `too-large` (`unavailable` existed).
   - Limits per data type (`DATA_RULES`): one row per save for rates and templates; 4 KB for a rates row; 160 KB for a template message, of which the body may be 150 KB.
   - Added beyond the original list: a save may take time. The hub sends exactly one answer, the outcome or its own `unavailable` after 8 seconds (`bridge.js` waits 10). After `unavailable` or no answer, the app must reload and compare the revision before saving again.

5. **Registry data types.** DONE; the third BUILT in Stage C. `payslip` accepts `payroll-result`, `statutory-rates`, `payslip-template`, `payslip-issue` and produces the last three. `payslip-issue` was registered only once its handler existed. Later, `payroll` accepts `statutory-rates`.

6. **`statutory-rates` (a SHARED table, not payslip-only).** DONE. Migration `0009_statutory_rates.sql`.
   - `statutory_rates`: per company, `effective_from` (first of a month), `revision`, `nsf_employee_rate`, `nsf_ceiling`, `nsf_exempt_at_60`, `csg_employee_rate_low`, `csg_employee_rate_high`, `csg_threshold`, `source_note`, `created_by`, `created_at`.
   - Insert-only, and only through the function `save_statutory_rates`: members read, admins add a revision, no insert, update or delete policy or grant. The rows are the change log. A correction is a new row with the same `effective_from` and the next `revision`.
   - Changed from the outline: the caller sends `expected_revision` (the latest revision it has seen for that month, 0 for none). A save that is behind is refused as `stale`, an identical one as `no-change`. At most 1,000 rows per company.
   - Names are generic so the payroll app can read the same rows later. Employer-side rates, when the payroll app needs them, are added by a later migration as new columns.
   - Not in this table: which payroll column is the base of the calculation. That is a mapping, kept in the payslip template.
   - The higher CSG rate applies strictly ABOVE the threshold; no flag is needed.
   - Handlers: a request returns every version for the selected company; a save adds one revision, with the values exactly as sent. No prompt and no password gate.

7. **`payslip-template`.** DONE. Migration `0010_payslip_templates.sql`.
   - `payslip_templates` (name, draft body, draft revision) and `payslip_template_versions` (immutable published versions, who and when).
   - Two functions: `save_payslip_template_draft` (creates a template, or saves over its draft only if the caller's revision is still the current one) and `publish_payslip_template`. No direct writes.
   - Handlers: `list` (no bodies), `load` (the draft, or a published version), `save-draft`, `publish`. A stale save or publish is refused as `stale`; publishing an unchanged draft as `no-change`.
   - Limits: a body of at most 150 KB at the hub (256 KB in the database), 50 templates per company, names unique whatever the capitals, no images in a body. Viewers may read drafts.
   - Left out on purpose: deleting or archiving a template (docs/FUTURE_WORK.md, section 9c).
   - No prompt and no password gate, as for rates.

## Payslip Phase 4 (issued payslips)

8. **`payslip-issue`.** BUILT. Migration `0011_issued_payslips.sql`.
   - `issued_payslips`: company, employee, period, revision, template id and version, rates snapshot (empty = not cross-checked), the exact lines shown, accepted differences, `issued_by`, `issued_at`. One immutable row per employee, month and revision.
   - Rows are added only through `issue_payslips`: a whole month's selection in one call, all of it or none, with the revision last seen per employee (`stale` otherwise). Only an admin of the company can read; a viewer not even a count. `issued_payslips_for_month` (SECURITY INVOKER, so the read policy decides) returns a month as the latest revision of each employee.
   - The employee is identified by national ID and must be a current employee in the hub. The template is `template_id` plus `template_version` (the app never sees a version row's id); foreign keys make sure both belong to the same company. No saved run is required for the month.
   - Wire: `{ action: "load", brn, period }` and one row `{ action: "issue", brn, period, payslips: [...] }`. `brn` is required on both and must be the selected company's.
   - Gate and prompt: a load asks the user in the same dialog as a saved run and reads only once they agree with the gate open. An issue has no dialog (8 seconds): it needs the gate open already and is refused at once as `locked` otherwise, with nothing stored. The query key `issued-payslips` is in `GATED_QUERY_KEYS`.
   - Added beyond the outline: a refused month tells the app WHICH payslip was at fault, as `index` (its position in `payslips`, from 0). The database puts "payslip N" (from 1) in its message; nothing ever names the employee. `issued_by` never leaves the hub: answers carry `issued_by_you`. Who accepted a difference is not sent by the app: it is the issuer.
   - Limits: 1,000 payslips and 4 MB per save, 16 KB per payslip at the hub, 50 revisions per employee per month, 5,000 rows per answer. An identical re-issue is a new revision (no `no-change`).
   - Also in Stage C: every answer to a request for rates, templates and issued payslips carries `meta.role` (`admin` or `member`).
   - Left out on purpose: revision history in a load, display names, a default template per company, a Database page tab (docs/FUTURE_WORK.md, section 9c).

## For every migration above that adds a table

9. **`delete_company`.** DONE for 0009 and 0010, BUILT for 0011: each replaces the function with its tables added, deleted by name and counted (`rates`, `templates`, `template_versions`, `issued_payslips`). The newest definition is in 0011, and it is the file the dashboard names when the function is missing (an older file, run after it, would put back a function that does not know the newer tables). The dashboard's preview before a delete counts the four tables too.

10. **Transfer log and tests.** DONE, and extended in Stage C for `payslip-issue` (the log row of an issued month counts its payslips; `npm run test:prove` covers the Stage C rules). Requests and saves go through `answerRequest()` and `recordSave()` in `src/features/workspace/deliver.ts`: one Transfer log row each, with no values. "Get from dashboard" for `payroll-result` is logged the same way. Protocol, handler and PGlite migration tests are in place, and `npm run test:prove` covers the Stage B rules. The test that keeps `HUB_ORIGIN` equal to the dashboard origin is unchanged.

## For the owner to do by hand

11. Migrations 0008, 0009 and 0010: run. Still to do: run `0011_issued_payslips.sql` in the Supabase SQL editor before the Stage C code is deployed. It ends with one verification row in which every column should be true. Until it is run, issuing or loading payslips is refused as `unavailable`, naming the file; nothing else is affected.
