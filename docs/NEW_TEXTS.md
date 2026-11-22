# On-screen texts waiting for the owner's approval

Company lists (`COMPANY_LISTS_AND_STATUS_PLAN.md`), Stage 1, 22 November 2026. This is the section 6 wording, trimmed as asked: short labels, icons, and no helper sentences. Explanations appear only as a tooltip or one short line. **P** texts are built in Stage 1 (the dashboard). **M** and **S** texts are for the later stages, so you can approve them all at once.

## P: the company picker (built, dashboard)

| # | Where | Text |
|---|---|---|
| P1 | Small line above the title, with the app's icon | **Payslip** / **MRA Returns** / **Payroll System** |
| P2 | Title | **Choose companies** |
| P3 | ⓘ next to the title (tooltip) | **Everyone on a company sees the same list.** |
| P4 | Search box (placeholder) | **Search by name or BRN** |
| P5 | Filter chips | **All** · **Selected** · **Not selected** |
| P6 | Counter (bottom bar) | **8 of 13 companies selected**. MRA Returns: **CSG 8 · PRGF 5 of 13** |
| P7 | Bottom bar buttons | **Select all** · **Clear** · **Cancel** · **Done** |
| P8 | ✕ at the top right (screen readers only) | **Close** |
| P9 | The two switches on each MRA Returns card | **CSG** · **PRGF** |
| P10 | 🔒 card of a company where you're not an admin (tooltip) | **Only an admin can change this** |
| P11 | Nothing to show | **No company matches "xyz".** / **None selected.** / **All selected.** |
| P12 | Leaving with unsaved changes | Title **Leave without saving?**, line **Your changes won't be kept.**, buttons **Keep choosing** · **Leave** |
| P13 | Toast after Done | **Payslip list saved: 8 companies.** / **MRA Returns lists saved: CSG 8, PRGF 5.** |
| P14 | Toast when the save is refused | **The list wasn't saved: you're not an admin of every company you changed.** Any other failure: **The list wasn't saved.** followed by the usual reason (for example **The database can't be reached.**) |
| P15 | Delete company, in the list of what goes (only when there is any) | **the record of its MRA files and approvals** |

## M: each app's main page (Stages 2 and 3)

| # | Where | Text |
|---|---|---|
| M1 | Page title | **Your companies** with **November 2026** beside it (the month chooser) |
| M2 | Button, with a grid icon | **Choose companies** |
| M3 | Empty list | **No companies yet** and the button **Choose companies**. When you're not an admin of any company, one line instead of the button: **An admin can choose them.** |
| M4 | The selected company isn't on this app's list (a small label on its screen) | **Not on the list**, and for admins a small button **Add** |
| M5 | Back from a company to the cards | **Your companies** (with ←) |

## S: the status board and labels (Stages 4 and 5)

| # | Where | Text |
|---|---|---|
| S1 | Page title (dashboard menu: **Status**) | **Status** with **November 2026** beside it (the month chooser) |
| S2 | Column headings | **Company** · **Payroll** · **Payslips** · **CSG** · **PRGF** |
| S3 | Cells | **Not started** · **Saved** · **Approved 28 Nov** · **Approved** · **Issued 9/12** · **Issued 12/12 · 28 Nov** · **Made 29 Nov** · **Changed since** · **Warnings** · **Not used** |
| S4 | Tooltip on **Changed since** | **Saved again after this was done.** |
| S5 | Tooltip on **Approved** without a date | **Approved before dates were recorded.** |
| S6 | Tooltip on **Warnings** | **The file was made with warnings.** |

The labels on the app cards (Payslip and MRA Returns, and Payroll System) are the same cell texts (S3).
