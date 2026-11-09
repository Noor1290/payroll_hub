# Import companies from Excel: approved texts

Approved by the owner on 4 Nov 2026 (branch `companies-and-autocopy`, Part A), with two changes: a TAN or VAT typed as a number is a note on a row that stays ticked, and a run that creates nothing says so instead of a success notice. `{…}` is filled in by the dashboard. This repo has no automatic text check: change a text here and in the code together.

## Where it is offered (admins of at least one company only)

- Company menu and command bar: **Import companies from Excel**

## The dialog

- Title: **Import companies from Excel**
- Under the title: Creates many companies with their details at once. You become the admin of every company created.

### First step

1. (Replaced on 5 Nov 2026: see "The template with my companies" below.)
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
  - **Twice in the file**: Skipped: same BRN as row {n}, which is used instead. (Was "which is created instead" until 5 Nov 2026.)
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
  - Same BRN as row {n}, which is used instead. (Was "which is created instead" until 5 Nov 2026.)
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
- A row whose BRN is a company you are admin of shows its changes in the preview and is updated only if you tick it. An empty cell leaves the value as it is.
- A company whose BRN is already in the dashboard but that you are not admin of is skipped, with capitals and spaces ignored. A BRN on two rows: the first row is used, the second skipped.
  (These two lines replaced "A company whose BRN is already in the dashboard, with capitals and spaces ignored, is skipped. A BRN on two rows: the first row is created, the second skipped." on 5 Nov 2026.)

Sheet **Companies**: the nine headings above, in that order, row 1 frozen; columns A to Y formatted as Text.

## The template with my companies

Approved by the owner on 5 Nov 2026 (branch `companies-template`): the texts of the Stage 0 plan and the 18 of `NEW_TEXTS.md` section A, all as written. `{…}` is filled in by the dashboard.

### First step

1. Download a template and fill in its Companies sheet, one row per company. Company name and BRN are required; the Read me sheet explains every column.
   - Button: **Download the blank template** (file: `Companies template.xlsx`). Under it: No companies in it, for adding new ones.
   - Button: **Download the template with my companies** (file: `My companies {yyyy-mm-dd}.xlsx`; while it is made: **Preparing the file**). Under it: Filled in with the {n} companies you are admin of, to change their details or add new companies below them. (One: "the 1 company".)
     - When some have no BRN: {n} of your companies have no BRN, so they are not in it: a row is matched to its company by BRN. (One: "1 of your companies has no BRN, so it is not in it: …")
     - Over 200: Only the first 200 by name are in it: an import takes at most 200 companies.
   - Under both: The filled-in template holds your companies' details. Keep it on your computer.
   - When it can't be made: **Your companies couldn't be read**, then the usual reason.
2. When the file can't be compared: This file can't be imported / Your companies' details couldn't be read, so the file can't be compared with them. {the usual reason}

### The preview

- Count line: {n} rows: {n} new, {n} to update, {n} with no changes, {n} already in the dashboard, {n} twice in the file, {n} problems.
- **Update** (unticked when the preview opens): Changes: {Label}: {before} → {after}; {Label}: {before} → {after}. An empty value shows as (empty).
- **No changes**: Already up to date.
- Either may add: Left as it is: {labels} (empty in the file). / Not changed: {label} is sensitive; change it on the Company profile. / Also on row {n}: this row is used, the other skipped.
- **Already in the dashboard**: Skipped: {name} already has this BRN; you are not its admin.
- Checkbox (screen readers): Update row {n}, {name} (new rows: Create row {n}, {name})
- Buttons: **Create {n} companies and update {n}**, **Update {n} companies** / **Update 1 company**, **Create {n} companies**
- Progress: Updating {n} of {n}. Keep this window open. (new rows: Creating {n} of {n}.)

### The report

- Summary: {n} companies created, {n} updated, {n} skipped, {n} problems. ("{n} updated" only when the file had rows to update; "You are the admin of every company created." only when one was created.)
- Nothing saved, with rows to update in the file: No company was created or updated. {reason} (otherwise: No company was created. {reason})
- Toast: {n} companies created, {n} companies updated / 1 company updated
- **Updated**: Changes: {Label}: {before} → {after}; …
- **Skipped**: Already up to date. / Not ticked.
- **Problem**: Not updated: it was changed in the dashboard after the preview. Upload the file again. / Not updated: you are no longer its admin. / Not updated: the database refused the value: {detail}. / Updated: {labels}. Not updated: {labels} ({reason}).
- Report file: two more columns, **Before** and **After**, one value per line ("Address: 1 Test Street"), an empty one as (empty).

### Read me of the filled-in file

- Title: Companies template with my companies
- Filled in on {5 November 2026} with the {n} companies you are admin of. Sensitive details are not included.
- When needed: Not in this file: the details labelled {labels}, because a column of the template already has that heading. / Not in this file: the details labelled {labels}, because a file holds at most 50 details.

## Employees sheet, Stage 1: the two templates (approved 9 November 2026)

Approved by the owner: T1–T7, R1–R8 and C1–C9 (EMPLOYEES_IMPORT_PLAN.md). Hub commit ab4d956.

### In the dialog ("Import companies from Excel")

| # | Where | Text | New or changed |
|---|---|---|---|
| T1 | Under the title | One file with your companies and, if you like, their employees. You become the admin of every company created. | Changed (was "Creates many companies with their details at once. …") |
| T2 | Step 1 | Download a template and fill in its Companies sheet, one row per company, and, if you like, its Employees sheet, one row per employee. Company name and BRN are required; the Read me sheet explains every column. | Changed |
| T3 | Under the two buttons | The filled-in template holds your companies' details and your employees' names. Keep it on your computer. | Changed |
| T4 | Locked dashboard, after "Download the template with my companies" (shot 02) | Confirm your password first: the template with your companies also holds their employees. | New |
| T5 | After the download (shot 03) | Employees: 3 from 1 company, each from its newest saved month. ID and figures are left out because they are sensitive. | New (approved in §5) |
| T6 | After the download, when no company has a saved month | Employees: none, because none of these companies has a saved month. | New |
| T7 | Problem title if the setup can't be read for the blank template | Your column setup couldn't be read | New |
| — | Blank template button while it works | Preparing the file | Existing text, now also on this button |

### In the Excel files

**Read me, first line (both templates), changed:**
Fill in the Companies sheet, one row per company, and, if you like, the Employees sheet, one row per employee. Then upload this file in the dashboard with "Import companies from Excel". Nothing is saved before you confirm the preview.

**Read me, new section "Employees sheet"** (shots 06 and 07):

| # | Text |
|---|---|
| R1 | Employees sheet |
| R2 | Optional. One row per employee, linked to their company by its BRN: a company on the Companies sheet or one already in the dashboard. Leave it empty to import companies only. |
| R3 | Blank template: Its columns are those of your column setup "TEST Main setup" in Payroll System: the identity fields, then the Input columns. For a company with other columns, add their headings. |
| R3b | Blank template, when you have no column setup: Its columns are the identity fields ID, Surname and Other names. For a company with a column setup in Payroll System, add the headings of its identity fields and Input columns. |
| R4 | Template with my companies: Filled in with the employees of each company's newest saved month. ID and the columns after the identity fields are left empty because they are sensitive: an empty cell changes nothing. |
| R5 | Employees are added to their company's newest saved month in Payroll System. A company with no saved month starts in the month you choose in the preview. |
| R6 | A row is matched to an employee of that month by its Reference or, without one, by its ID. A new employee is added. For an employee already there, the preview shows the changes, and they are made only if you tick them. |
| R7 | An empty cell changes nothing; nobody is ever deleted. Employees of the month who are not in the file stay as they are. |
| R8 | Formula columns are not in this sheet: Payroll System works them out. A column of a company's setup can be added by its heading; capitals and spaces don't matter. |

**Read me, column table of the Employees sheet** (Column / Required / What it is / Format / Example):

| # | Column | Required | What it is | Format | Example |
|---|---|---|---|---|---|
| C1 | Company BRN * | Yes | The BRN of the employee's company, as on the Companies sheet or in the dashboard. | Text. Capitals and spaces don't matter. | C07012345 |
| C2 | Company name | No | Only to help you read the file: it is not read. The BRN links the employee to their company. | Text. | Example Trading Ltd |
| C3 | ID | For a new employee | The employee's ID (their NIC). An employee is recognised by it. | Text. Leading zeros are kept. | A0101801234567 |
| C4 | Surname | For a new employee | An identity field of the column setup in Payroll System. | Text. | Example |
| C5 | other identity fields | No | An identity field of the column setup in Payroll System. | Text. / A date: DD/MM/YYYY, for example 05/03/2024. | Jane / 05/03/2024 |
| C6 | a number column | No | An Input column of the column setup (General): a figure for the month. | A number, for example 18115.00 or 18,115.00. | 18115.00 |
| C7 | a Text, Date or Yes/No column | No | An Input column of the column setup (General): a value for the month. | Text. / A date: … / Yes or No. Y, X and 1 also tick it. | — / 05/03/2024 / Yes |
| C8 | (added when only some companies have the column) | | … Only for: TEST Alpha Ltd. | | |
| C9 | Reference (leave as is) | No | Which employee of the dashboard the row is. Leave it as it is. For a new employee, leave it empty. | Filled in by the dashboard. | |

**Sheet headings:** "Employees" (sheet name), "Company BRN *", "Company name", "Reference (leave as is)"; the other headings are the names in your column setup.
