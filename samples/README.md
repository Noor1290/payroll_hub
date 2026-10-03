# Sample payroll exports

Every name, ID and figure in this folder is invented. Never put a real export here: the repo is public.

- `ABC Co Ltd-pdf-fill-2026-09.json`: a valid file (6 employees, trailing spaces to trim, one unknown field "Bonus").
- `ABC Co Ltd-pdf-fill-2026-10.json`: the following month: one employee renamed, one left, one new.
- `INVALID rows-pdf-fill-2026-09.json`: row-level problems, for checking the error report.
- `INVALID mixed companies-pdf-fill-2026-09.json`: two BRNs in one file, which is refused outright.

The valid files match the company in the first-time setup block of `supabase/migrations/0001_initial_schema.sql` (BRN C1234567).
