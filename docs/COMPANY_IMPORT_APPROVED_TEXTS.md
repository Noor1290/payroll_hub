# Import companies from Excel: approved texts

Approved by the owner on 4 Nov 2026 (branch `companies-and-autocopy`, Part A), with two changes: a TAN or VAT typed as a number is a note on a row that stays ticked, and a run that creates nothing says so instead of a success notice. `{…}` is filled in by the dashboard. This repo has no automatic text check: change a text here and in the code together.

## Where it is offered (admins of at least one company only)

- Company menu and command bar: **Import companies from Excel**

## The dialog

- Title: **Import companies from Excel**
- Under the title: Creates many companies with their details at once. You become the admin of every company created.

### First step

1. Download the template and fill in its Companies sheet, one row per company. Company name and BRN are required; the Read me sheet explains every column.
   Button: **Download the companies template** (file: `Companies template.xlsx`)
2. Upload the filled-in file. You see what will happen to each row before anything is saved.
   Button: **Choose the filled-in file** (while reading: **Reading the file**)

When the file can't be used, a red box **This file can't be imported** with one of:
- This is not an Excel (.xlsx) file the dashboard can read.
- The file is larger than 5 MB. Use the companies template.
- The file has no sheet named "Companies". Use the companies template.
- The Companies sheet has no "{Company name / BRN}" column. Use the companies template.
- The heading "{heading}" is there twice.
- Column {letter} has values but no heading in row 1.
- The heading "{first 40 characters}…" is longer than 80 characters.
- The Companies sheet has more than 50 detail columns.
- The Companies sheet has no companies in it.
- The file has {n} companies. At most 200 can be imported at once.
- The file couldn't be read. Save it again in Excel as .xlsx and try again.

### Preview

- Line above: `{file name}` {n} rows: {n} new, {n} already in the dashboard, {n} twice in the file, {n} problems.
- **Column setup of the new companies**: list of `{setup name} (used by {n} of your companies)`; one you may not use is greyed: `…: you're not an admin of every company using it`; last option **None yet**.
  - Under it, with a setup: Shared: the new companies use its identity fields and Global columns, with no columns of their own yet.
  - Under it, with None yet: The payroll app asks for a column setup the first time each company is opened.
- **Use the ready-made MRA templates** (ticked)
  - With templates: {MRA CSG (PACO) and MRA PRGF}, shared with the new companies as "Use them for all my companies" does in MRA Returns.
  - With none (greyed out): None of your companies uses them yet. Add them once in MRA Returns (Add the ready-made MRA templates), then import.
- While reading them: Reading your column setups and MRA templates
- If they can't be read: **Your column setups and MRA templates couldn't be read** + the usual reason, button **Try again**
- Table headings: Row · Company · BRN · What happens (and, for screen readers, "Create" and "Create row {n}, {name}" on each tick box)
- Under a new row: its details, e.g. `{address} · VAT {vat} · {label} {value} · ERN {ern} · Tel. {telephone} · Mobile {mobile} · Declarant {name}`
- Badges and notes:
  - **New**; when a later row has the same BRN: Also on row {n}: this row is created, the other skipped. (several: "Also on rows {n, n}: …")
  - **New** with: This BRN doesn't look like one (one letter then 6 to 10 digits). Tick it if it is right.
  - **New**, still ticked, with: {VAT / TAN} was typed as a number, so leading zeros may be lost; check it.
  - **Already in the dashboard**: Skipped: {company name} already has this BRN.
  - **Twice in the file**: Skipped: same BRN as row {n}, which is created instead.
  - **Problem**: Not created: {reasons}
- Empty cells shown as (no name) and (no BRN)
- Below the table, when a BRN only looks unusual: A BRN that doesn't look like one is not ticked. Tick it if it is right.
- Buttons: **Choose another file** · **Cancel** · **Create {n} companies** (1: **Create 1 company**)

Problem reasons (one row can have several):
- The company name is missing. / The company name is longer than 200 characters.
- The BRN is missing. / The BRN has characters other than letters and digits. / The BRN is longer than 50 characters.
- The value in "{heading}" can't be read ({#N/A …}).
- The address is longer than 500 characters. / The VAT is longer than 50 characters.
- The ERN is stored as a number, so a leading zero may have been lost. Format the ERN column as Text, type the ERN again and upload the file again.
- The ERN must be letters and digits only, at most 20.
- The telephone must be digits, spaces and + - ( ) only, at most 30. / The mobile must be …
- The name of the declarant must be at most 120 characters.
- "{label}" is longer than 2000 characters.

### Creating

- Creating {n} of {total}. Keep this window open. (first: Starting. Keep this window open.)
- The window cannot be closed by Escape or a click outside while this runs.

### Report

- {n} companies created, {n} skipped, {n} problems. You are the admin of every company created.
- When none was created: No company was created. {Every row was skipped. / Every row had a problem. / Every row was skipped or had a problem.}
- Table: Row · Company · BRN · Result, with **Created**, **Skipped** or **Problem** and why:
  - Already in the dashboard as {name}.
  - Same BRN as row {n}, which is created instead.
  - Not ticked.
  - {the problem reasons above}
  - When the database refuses a company, followed by "Nothing of this company was created.":
    - Creating companies from a file isn't set up in the database yet: the owner needs to run supabase/migrations/0023_create_company_with_details.sql.
    - A company with this BRN already exists (one you are not a member of, or one added since the preview).
    - Not allowed: you must be an admin of a company, and of every company using the chosen column setup and MRA templates.
    - The chosen column setup or MRA templates can no longer be found.
    - The database refused a value: {what}.
    - The MRA templates could not be added to it.
- Buttons: **Download the report** (file: `Companies import report YYYY-MM-DD HHMM.xlsx`, sheet "Report": Row, Company name, BRN, Result, Why) · **Close**
- Notice in the corner: **{n} companies created** — The report says what happened to every row.
- When none was created, a red notice: **No company was created** — {the same reason as above}

## The template file (`Companies template.xlsx`)

Sheet **Read me**:
- Companies template
- Fill in the Companies sheet, one row per company, then upload this file in the dashboard with "Import companies from Excel". Nothing is saved before you confirm the preview.
- Column · Required · What it is · Format · Example, one line per column:

| Column | Required | What it is | Format | Example |
| - | - | - | - | - |
| Company name * | Yes | The company's name, as it should appear in the dashboard and on payslips. | Text, at most 200 characters. | Example Trading Ltd |
| BRN * | Yes | The Business Registration Number. Payroll files are matched to a company by it, so it must be exactly the BRN in the company's payroll files. | Text: one letter then 6 to 10 digits, e.g. C07012345. Saved in capitals with spaces removed. Two companies can never have the same BRN. | C07012345 |
| Address | No | The company's address. | Text, at most 500 characters. | 1 Example Street, Port Louis |
| VAT | No | The VAT registration number. | Text, at most 50 characters. Leading zeros are kept. | VAT20123456 |
| TAN | No | The Tax Account Number. Kept as a detail on the Company profile, labelled TAN. | Text, at most 2000 characters. Leading zeros are kept. | 00123456 |
| ERN | No | The Employer Registration Number, for the MRA returns (MRA details on the Company profile). | Text: letters and digits only, at most 20. Leading zeros are kept. A number typed in a cell not formatted as Text is refused, because Excel has already dropped its leading zeros. | 013341 |
| Telephone | No | The company's telephone number, for the MRA returns. | Text: digits, spaces and + - ( ) only, at most 30. | 212 3456 |
| Mobile | No | The company's mobile number, for the MRA returns. | Text: digits, spaces and + - ( ) only, at most 30. | 5 712 3456 |
| Name of declarant | No | The person who signs the MRA returns. | Text, at most 120 characters. | Jane Example |

- More details
- Any other heading you add on the Companies sheet becomes a detail of the Company profile, with that heading as its label (not sensitive; you can mark it sensitive later on the Company profile). Leave a cell empty to add nothing.
- Every column of the Companies sheet is formatted as Text, so Excel keeps leading zeros. Keep it that way; do not rename or remove the sheet. Rows left empty are ignored.
- A company whose BRN is already in the dashboard, with capitals and spaces ignored, is skipped. A BRN on two rows: the first row is created, the second skipped.

Sheet **Companies**: the nine headings above, in that order, row 1 frozen; columns A to Y formatted as Text.
