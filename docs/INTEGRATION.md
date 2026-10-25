# Connecting an app to Payroll Hub

This is for whoever adds the bridge to an app (`payroll_sys`, `pdf-form-filler`, the payslip app), including Claude Code working in that app's repository. It explains what to copy, what to wire up, and how to check it works.

## The idea in one minute

- The dashboard loads each app in an iframe and talks to it with `window.postMessage`.
- Apps never talk to each other. Data always goes app → dashboard → app.
- The app side is one file, [`bridge.js`](./bridge.js). It does nothing unless the app is inside the dashboard, so **the app keeps working on its own exactly as it does today**. Keep the manual JSON export and import: they are the fallback when the dashboard is unavailable.
- The dashboard only trusts messages from the iframe it created for that app. The app only trusts messages from its parent window at the dashboard's exact origin.

## What you can and cannot rely on

All of these sites are served from one origin, `https://noor1290.github.io`. Because of that, the iframe sandbox does **not** isolate the apps from the dashboard or from each other: any page on that origin can reach the others' storage and, when embedded, the dashboard's page. The checks in the bridge prevent mix-ups and accidents; they are not a defence against a hostile app on the same origin. Only put apps you control on that origin.

## Steps for any app

Both existing apps are React + Vite, so the steps assume that.

1. **Copy the file.** Copy `docs/bridge.js` from the `payroll_hub` repo to `src/payrollHubBridge.js` in the app. Do not edit it. If the app lints its sources, add the file to the linter's ignore list.
2. **Load it once**, at the top of the app's entry file (`src/main.jsx` or `src/main.tsx`):

   ```js
   import "./payrollHubBridge.js"; // defines window.PayrollHubBridge
   ```

   For TypeScript, add a declaration file `src/payrollHubBridge.d.ts`:

   ```ts
   interface PayrollHubPayload {
     dataType: string;
     rows: Record<string, unknown>[];
     meta?: { period?: string; label?: string; brn?: string; role?: "admin" | "member" };
   }
   type PayrollHubReply =
     | ({ ok: true; result?: Record<string, unknown> } & Partial<PayrollHubPayload>)
     | { ok: false; error: string; code?: string; index?: number };
   interface Window {
     PayrollHubBridge: {
       isEmbedded(): boolean;
       isConnected(): boolean;
       init(options: {
         appId: string;
         onData?: (payload: PayrollHubPayload) => unknown;
       }): boolean;
       sendToDashboard(type: "send-data" | "request-data", payload: unknown): Promise<PayrollHubReply>;
       requestData(dataType: string, period?: string): Promise<PayrollHubReply>;
       setUnsaved(unsaved: boolean): void;
       onStatus(listener: (connected: boolean) => void): () => void;
     };
   }
   ```

3. **Start it once**, with the app's id from the dashboard registry (see the per-app sections).
4. **Say when there are unsaved changes**: call `window.PayrollHubBridge.setUnsaved(true)` when the app starts holding changes it has not saved yet, and `setUnsaved(false)` once they are saved or thrown away. When the company changes in the dashboard, every app frame reloads so it shows the new company; before that, the dashboard asks its user if an app said `true` ("Payroll System has unsaved changes." / "Switch anyway?"). Standalone it does nothing.
5. **Show the dashboard buttons only when embedded**: `window.PayrollHubBridge.isEmbedded()`. Standalone, the app must look and behave as it does now.
6. **Never** change `HUB_ORIGIN`, never add a localhost origin, never use `"*"` as a target origin, and never write received payroll data to `localStorage` or the URL.

## `payroll_sys` (app id: `payroll`)

This app **sends** payroll results to the dashboard.

What to build:

- In the root component, start the bridge once:

  ```js
  useEffect(() => {
    window.PayrollHubBridge.init({ appId: "payroll" });
  }, []);
  ```

- Find the code that builds the JSON export for the PDF filler. Search the source for `pdf-fill` (the download is named `<company>-pdf-fill-<year>-<month>.json`). It produces an array with one object per employee and the company fields on every row. That same array is what the dashboard wants; do not build a second format.
- Next to the existing export button, add a **Send to dashboard** button that is rendered only when `window.PayrollHubBridge.isEmbedded()` is true:

  ```js
  async function sendToDashboard(rows, year, month) {
    const reply = await window.PayrollHubBridge.sendToDashboard("send-data", {
      dataType: "payroll-result",
      rows, // exactly the array the JSON export writes
      meta: { period: `${year}-${String(month).padStart(2, "0")}` }, // "2026-09"
    });
    if (reply.ok) showMessage("Sent to the dashboard.");
    else showMessage(`Not sent: ${reply.error}`);
  }
  ```

- `sendToDashboard` never throws. It resolves with `{ ok: true }` or `{ ok: false, error }` (for example when the dashboard does not answer within 10 seconds). Show the error and leave the normal JSON download available.

Ready-to-paste task for Claude Code in the `payroll_sys` repo:

> Read `docs/INTEGRATION.md` and `docs/bridge.js` from the payroll_hub repo (I will paste or copy them in). Copy bridge.js unchanged to `src/payrollHubBridge.js`, import it once in the entry file, and call `PayrollHubBridge.init({ appId: "payroll" })` once in the root component. Find where the "pdf-fill" JSON export array is built and add a "Send to dashboard" button beside the existing export button, shown only when `PayrollHubBridge.isEmbedded()`. It must send the exact same array with `dataType: "payroll-result"` and `meta.period` as `YYYY-MM`, and show the reply's success or error. Do not change the existing export, do not edit bridge.js, and make sure the app behaves exactly as before when opened on its own.

### Payroll app: column setup (`payroll-setup`)

Added in migration plan Phase 2 (`docs/MIGRATION_PLAN.md`), database side in `supabase/migrations/0013_payroll_setups.sql`. Inside the dashboard the app keeps its column setup in the database; opened on its own it keeps using the browser, as before. The months of employee data are the next data type, `payroll-month` (Phase 3). Still protocol version 1 and the same `bridge.js`. A dashboard that does not know this data type answers "not registered": the app then stays with the browser.

There are two kinds of setup, each a JSON `body` the app defines (the dashboard stores and returns it exactly and never looks inside), 250 KB at most:

- **The shared setup**: the identity fields, which one is the ID field, and the Global columns. Several companies are attached to it and a change reaches all of them. Any member of an attached company may read it; only someone who is an **admin of every attached company** may change it (before any is attached: only its creator).
- **A company's own setup**: its own columns and its custom company details. Members read, admins save. Its name, address and BRN are the dashboard company's own and are not in it.

No dialog and no password gate (nothing per employee). Every exchange is a row in the transfer log (never with content) and every save shows a toast. Companies are named by BRN. Each message carries `brn`, the company selected in the dashboard, which must match (`wrong-company` otherwise). A save may also name another of the user's companies (`company_brn`, or each entry of `companies`); the database decides whether the user may change it.

| Kind | What the app sends | What comes back |
| --- | --- | --- |
| request | `params: { action: "load", brn? }` | nothing when the selected company has no setup yet; otherwise first `{ kind: "shared", shared_setup_id, name, body, revision, updated_at, updated_by_you, can_change, companies, admin_of }`, then one row per attached company the user is a member of: `{ kind: "company", brn, name, address, role, selected, shared_setup_id, body, revision, updated_at, updated_by_you }` |
| request | `params: { action: "history", target: "shared" \| "company", company_brn?, brn? }` | a row per kept revision, newest first (200 at most): `{ revision, saved_at, saved_by_you }` |
| request | `params: { action: "revision", target, revision, company_brn?, brn? }` | one kept revision: `{ revision, body, saved_at, saved_by_you }`, and for a company also `shared_setup_id` |
| request | `params: { action: "companies", brn? }` | the companies the user is an ADMIN of: `{ brn, name, address, has_setup, shared_setup_id, selected }` (for the import) |
| save | `{ action: "save-shared", brn, shared_setup_id, name, body, expected_revision, companies?: [{ company_brn, body, expected_revision }] }` | `result: { action, shared_setup_id, name, revision, updated_at, companies: [{ brn, revision }] }` |
| save | `{ action: "save-company", brn, company_brn?, body, expected_revision }` | `result: { action, brn, company, shared_setup_id, revision, updated_at }` |
| save | `{ action: "attach-company", brn, company_brn?, shared_setup_id, body }` | the same as `save-company` |

- **The app chooses the shared setup's id** (a UUID) and creates it with `expected_revision: 0`, with no companies; then attaches each company. A save sent twice is refused as `stale`; so is attaching a company that already has a setup.
- **`companies` on `save-shared`** saves those companies' own setups in the same step, all or nothing: a change of a Global column's key rewrites formulas in company columns too. Each must be attached to that shared setup.
- **`expected_revision`** is the revision the app last saw. If someone else saved since, the save is refused as `stale` and nothing is overwritten. After `unavailable` or no answer: `load` and compare before saving again.
- **`can_change`, `companies`, `admin_of`** on the shared row say whether the user may change it, how many companies use it and how many of those the user is an admin of: show the Global columns read-only from the start when `can_change` is false.
- **Every revision is kept, none dropped**: a month records the revisions it was saved with (`payroll-month`, below).
- **A change of a column's key** that moves values in saved months is not a `payroll-setup` save: it is `key-change` under `payroll-month`, so the setup and the months change together.
- `forbidden`: the user may not make this change (not an admin of that company, or not of every company using the shared setup).

### Payroll app: months (`payroll-month`)

Added in migration plan Phase 3 (`docs/MIGRATION_PLAN.md`), database side in `supabase/migrations/0014_payroll_months.sql`. Inside the dashboard the app keeps its months there: each company's employees and the values typed for them, one month at a time, the whole month as one JSON list `[{ "id": "...", "values": { "<column key>": ... } }]`, stored and returned exactly as sent, 1 MB and 5,000 employees at most. Opened on its own the app keeps using the browser. A dashboard that does not know this data type answers "not registered": the app then keeps its months in the browser as in Phase 2.

National IDs and salaries, so (decision D5):

- **Admins only.** Anyone else is refused as `forbidden` without a question, and the database lets them read nothing, not even a count.
- **The password gate must be open**, to read and to save, with **no dialog** on each read or save. While it is locked everything except `gate` and `unlock` is refused at once as `locked`, and nothing is read or stored.
- **The dashboard tells the app when the gate opens or locks**: it sends the app one row, `send-data` with `{ dataType: "payroll-month", rows: [{ action: "gate", unlocked: true | false }] }`, only when that changes. Nothing else is in it. An app that does not listen answers that it cannot receive data; nothing depends on it.
- Every exchange is a row in the transfer log, with counts and the month, never a value. A saved month has **no toast** (the app saves by itself a moment after typing stops and shows "Saved"); a refused save and a change of key do.

Each message carries `brn`, the company selected in the dashboard (`wrong-company` otherwise). `company_brn` names another of the user's companies (the import of months); the user must be its admin too.

| Kind | What the app sends | What comes back |
| --- | --- | --- |
| request | `params: { action: "gate", brn? }` | one row `{ unlocked }`. Answered to any member, gate open or not |
| request | `params: { action: "unlock", brn }` | the dashboard shows its password prompt (nothing else: no "Send"); one row `{ unlocked: true }` once it is open, `denied` on "Not now", `locked` if nobody answers in 100 seconds. At once when already open |
| request | `params: { action: "list", brn, company_brn? }` | a row per saved month, oldest first, without employees: `{ period, revision, shared_revision, company_revision, employee_count, value_keys, updated_at, updated_by_you }`. `value_keys` are the column keys the month holds values under: names only |
| request | `params: { action: "load", brn, company_brn?, periods: ["YYYY-MM", ...] }` | 1 to 12 months; a row per month that exists: `{ period, revision, shared_revision, company_revision, employee_count, employees, updated_at, updated_by_you }`. A month that does not exist is left out |
| request | `params: { action: "history", brn, company_brn?, period }` | a row per save of that month, newest first (200 at most): `{ revision, shared_revision, company_revision, employee_count, kept, saved_at, saved_by_you }` |
| request | `params: { action: "revision", brn, company_brn?, period, revision }` | one revision with its employees, exactly as saved: `{ period, revision, shared_revision, company_revision, employee_count, employees, saved_at, saved_by_you }`. Answered for a revision whose content was `kept`, and for the revision in use now; otherwise `not-found`. Reading it changes nothing |
| save | `{ action: "save", brn, company_brn?, period, employees, expected_revision, shared_revision, company_revision, keep_previous?, restored_from? }` | `result: { action, brn, company, period, revision, employee_count, updated_at, restored_from? }` |
| save | `{ action: "key-change", brn, moves: [{ old_key, new_key, company_brn }], shared?: { shared_setup_id, name, body, expected_revision, companies? }, company?: { company_brn?, body, expected_revision } }` | `result: { action, setup: { shared_setup_id, revision, brn?, companies: [{ brn, revision }] }, months: [{ brn, period, revision }] }` |

- **`expected_revision`** is the month's revision the app last saw, `0` for a month the dashboard does not have yet. If someone else saved since, the save is refused as `stale` and nothing is overwritten. After `unavailable` or no answer: `load` the month and compare before saving again. Only a month that was read can be saved.
- **`shared_revision` and `company_revision`** are the column setup revisions the month was worked out with (`payroll-setup`). They must be kept revisions of that company's setups (`invalid` otherwise); they are recorded with the month.
- **History.** Every save is recorded (who, when, the setup revisions, the number of employees). The month's content is kept with a record when it would otherwise be lost: the last revision of each day (UTC), a revision someone else saved when another person saves over it, and the one replaced by a save with `keep_previous: true` ("Save mine over it", an import that replaces a month). `kept` says which.
- **Restoring a revision** ("Restore this version" in the app's History) is a `save` of that revision's employees with `keep_previous: true` and `restored_from`: a NEW revision, so nothing earlier is rewritten or deleted, and what it replaces is kept. Unlike a month saved as the user types, it shows a toast. The column setup's own history is `payroll-setup` `history` and `revision`; restoring one is an ordinary `save-shared` or `save-company` of that body.
- **`key-change`**: a column's or an identity field's key changed. One step, all or nothing: the setup that carries the new key is saved exactly as `save-shared` (with `shared`) or `save-company` (with `company`) would save it, with every check they have, and the values move from `old_key` to `new_key` in every saved month the key reaches: every company attached to the shared setup when `company_brn` is `null` (a Global column, an identity field), only that company otherwise. Each month moved gets a new revision, listed in `months`. Exactly one of `shared` and `company`; with `company`, every move must name that company. At most 20 moves, applied in order.
- `forbidden`: not an admin of that company (or, for a Global key, of every company using the shared setup). `not-found`: the company has no column setup in the dashboard yet, or a key is to move in a company not attached to the shared setup.

### Payroll app: several companies in one Excel file (`payroll-batch`)

Added for "Several companies…" in the payroll app (25 Oct 2026, branch `multi-company-excel`, Stage 1: the export; Stage 1b: a range of months). No migration: it reads what `payroll-setup` and `payroll-month` already keep. Request only: nothing is ever saved through this data type. It works as `payslip-batch` does (the same code, `src/features/workspace/batchAccess.ts`): each company is one the user is an ADMIN of, read from the database at each request; `brn` must be the selected company's (`wrong-company` otherwise) and is required on `ask` and `load`.

| `params`                                                | Asked of the user | Answer rows |
| ------------------------------------------------------- | ----------------- | ----------- |
| `{ action: "companies", brn? }`                         | nothing           | One per company the user is an admin of and that has a BRN, the selected company first, then by name: `{ brn, name, selected, has_setup }`. No value per employee. |
| `{ action: "ask", brn, from, to, companies: [brn, ...] }` | ONE prompt, in the same dialog as a saved run, with the password gate open | The companies allowed: `{ brn, name }`. `meta.period` is the month when `from` and `to` are the same. |
| `{ action: "load", brn, from, to, company_brn }`          | nothing more      | ONE row for that company (below). |

- **`from` and `to`** are months, `"YYYY-MM"`: the same month for one month, or a later `to`, 24 months at most in all (`invalid` otherwise).
- **`ask`** names 1 to 200 companies, always by BRN (there is no `all`): the prompt names the months and EVERY company, never "and N more" ("It wants the October 2026 payroll of 3 companies: ABC Co Ltd, Big Sample Ltd and New Venture Ltd.", or "It wants the July 2026 to June 2027 payroll of 4 companies: …"). A company the user is not an admin of is refused at once as `forbidden` ("Only companies where you are an admin can be chosen."), without asking. `denied`, `timeout` and `locked` as for `payroll-result`.
- **Agreeing allows `load`** for those companies and exactly that `from` and `to` only (not a part of the range, nor a larger one), for this app, this user and the company selected now, for 15 minutes, in the dashboard's memory only; forgotten when the gate locks, on sign-out, or when the app asks again. It is separate from what `payslip-batch` allowed. A `load` outside it is refused as `denied`, with nothing read.
- **`load`** needs the gate open (`locked` otherwise; the months are read under the gated query key, as `payroll-month` reads them) and the user to be an admin of that company still (`forbidden`, "Only an admin of that company can export its employees' figures."). Its one row: `{ brn, name, address, from, to, setup, months }`:
  - `setup`: `{ shared_setup_id, shared_name, shared_body, shared_revision, company_body, company_revision }`, the bodies exactly as `payroll-setup` stores them; `null` when the company has no column setup.
  - `months`: one per month of the range that is saved, oldest first (none when no month is saved): `{ period, revision, shared_revision, company_revision, employee_count, employees, updated_at }`, the employees exactly as `payroll-month` stores them. `shared_revision` and `company_revision` are the setup revisions each month was saved with.
- The app works out the figures itself, with the company's column setup as it is now, as its Employee Table and Totals show every month. The dashboard never looks inside a body or a month.
- Every request is a row in the Transfer log (a `load` counts one row: the company), never with a value.

## `pdf-form-filler` (app id: `pdf-editor`)

This app **receives** payroll results.

What to build:

- Find the code that handles a JSON file after it has been read and parsed. Search the source for the message `doesn't look like a valid JSON file`: the function around it turns the file's text into rows, and its caller puts those rows into the app's state. The bridge must feed the **same** code path with rows that are already parsed, so validation and everything after it stay identical to a manual import.
- Start the bridge once in the root component, with a handler that always uses the latest state setters:

  ```js
  const importRows = useRef(null);
  importRows.current = (rows) => {
    // Call the same function the file import uses once it has the parsed array.
    // Throw an Error with a clear message if the rows cannot be used.
    loadPayrollRows(rows);
  };

  useEffect(() => {
    window.PayrollHubBridge.init({
      appId: "pdf-editor",
      onData: (payload) => {
        if (payload.dataType !== "payroll-result") throw new Error("Unsupported data type.");
        importRows.current(payload.rows);
      },
    });
  }, []);
  ```

- What `onData` does decides what the dashboard tells its user:
  - returns normally (or a promise that resolves) → "Delivered";
  - throws, returns `false`, or a promise that rejects → "Not delivered", with your error message.
- The bridge never calls `onData` twice for the same message. If the dashboard retries, the bridge repeats its earlier answer by itself.
- Optional: a **Get from dashboard** button, shown only when embedded, that asks for a saved run. The dashboard's user has to approve it, so allow up to two minutes:

  ```js
  const reply = await window.PayrollHubBridge.requestData("payroll-result", "2026-09"); // omit the month for the latest run
  if (reply.ok) importRows.current(reply.rows);
  else showMessage(`Nothing received: ${reply.error}`); // e.g. the dashboard is locked, or the user said no
  ```

- The rows have exactly the keys of the payroll export (`ID`, `Surname`, `Basic Salary`, …, `Company Name`, `BRN`), with strings trimmed.
- `Employee CSG` and `Employee NSF` are optional numbers. A row has the key only when the saved run has that figure for that employee (runs imported from an older export do not). A missing figure is a missing key, never `""` and never `0`; a real `0` is sent as `0`. Treat a missing key as "not known" and say so, instead of assuming zero.

Ready-to-paste task for Claude Code in the `pdf-form-filler` repo:

> Read `docs/INTEGRATION.md` and `docs/bridge.js` from the payroll_hub repo (I will paste or copy them in). Copy bridge.js unchanged to `src/payrollHubBridge.js`, import it once in the entry file, and call `PayrollHubBridge.init({ appId: "pdf-editor", onData })` once in the root component. `onData` must pass `payload.rows` into the same code path the JSON file import uses after parsing (find it via the message "doesn't look like a valid JSON file"), and throw an Error with a clear message when the rows cannot be used. Add a "Get from dashboard" button shown only when `PayrollHubBridge.isEmbedded()`, using `requestData("payroll-result")`. Do not write the received data to localStorage, do not edit bridge.js, and make sure the app behaves exactly as before when opened on its own.

### PDF form filler: templates in the dashboard (`pdf-template`, `pdf-file`)

Added in migration plan Phase 1 (`docs/MIGRATION_PLAN.md`), database side in `supabase/migrations/0012_pdf_templates.sql`. Inside the dashboard the app keeps its templates in the database and its blank PDF forms in a private Storage bucket; opened on its own it keeps using the browser, as before. Still protocol version 1 and the same `bridge.js`.

Both data types are answered and saved with **no dialog and no password gate**: a template is the fields drawn on a form and the company's own details, nothing per employee. Every exchange is a row in the transfer log (never with content) and every save shows a toast. Members of the company read; admins write. Everything is about the company selected in the dashboard: each answer carries `meta: { label, brn, role }`, each save must carry that company's `brn`, and a save for another company is refused as `wrong-company`.

What is NOT sent to the dashboard: the values last typed into a form and the People list. They stay in the browser.

**`pdf-file`: the blank PDF forms.** A file is named by the SHA-256 of its bytes (64 lowercase hex characters) and crosses the bridge as base64 text, one file per message, 5 MB at most.

| Kind | What the app sends | What comes back |
| --- | --- | --- |
| request | `params: { action: "exists", sha256, brn? }` | one row `{ sha256, exists }` |
| request | `params: { action: "download", sha256, brn? }` | one row `{ sha256, bytes, data }` (`data` is the file in base64), or `not-found` |
| save | one row `{ action: "upload", brn, sha256, data }` | `result: { sha256, bytes, already_there }` |

- Before storing, the dashboard checks that `data` is base64, that the file is 5 MB or less, that it starts as a PDF, and that its SHA-256 is the `sha256` stated. Otherwise `invalid` or `too-large`, and nothing is stored.
- Uploading the same file twice is harmless: the second answer has `already_there: true`.
- A slow upload may be answered `unavailable` after 8 seconds while it is still going. Ask `exists` before sending it again.

**`pdf-template`: the templates.** `body` is a JSON object the app defines (the dashboard stores and returns it exactly, and never looks inside), 250 KB at most, and must not contain a `data:` file: the PDF goes through `pdf-file`.

| Kind | What the app sends | What comes back |
| --- | --- | --- |
| request | `params: { action: "list", brn? }` | a row per template, no bodies: `{ template_id, name, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages, updated_at, updated_by_you }`. May be none |
| request | `params: { action: "load", template_id, brn? }` | one row: the same, plus `body` |
| request | `params: { action: "load", template_id, revision, brn? }` | one kept revision as it was saved: `{ template_id, revision, name, body, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages, saved_at, saved_by_you }`, or `not-found`. Reading it changes nothing |
| request | `params: { action: "history", template_id, brn? }` | a row per kept revision, newest first: `{ revision, name, saved_at, saved_by_you }` |
| request | `params: { action: "companies", brn? }` | the user's OTHER companies they are an admin of: `{ brn, name }` |
| save | `{ action: "save", brn, template_id, name, body, expected_revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages }` | `result: { action, template_id, name, revision, updated_at }` |
| save | `{ action: "restore", brn, template_id, revision, expected_revision }` | `result: { action, template_id, name, revision, restored_from, updated_at }` |
| save | `{ action: "copy-to-company", brn, template_id, to_brn, new_template_id, name }` | `result: { action, template_id, name, revision, to_company }` |
| save | `{ action: "delete", brn, template_id, expected_revision }` | `result: { action, template_id, name }` |

- **The app chooses a template's id** (a UUID), for a new template too, with `expected_revision: 0`. So a save that is sent twice cannot make two templates: the second is refused as `stale`.
- **`expected_revision`** is the revision the app last saw. If someone else saved since, the save is refused as `stale` and nothing is overwritten.
- **The file first.** A save, a restore or a copy whose PDF is not in the bucket for that company is refused as `not-found` ("Send the file first"). For a copy the dashboard copies the file to the other company itself.
- **Every revision is kept** (the last 200 per template). `restore` makes an earlier one the newest.
- **Copy** needs the user to be a member of the selected company and an admin of the one named by `to_brn`.
- **Delete** removes the template and its history, and its file when no other template of that company uses it.
- Limits: a name is 1 to 80 characters, unique in its company whatever the capitals (`invalid`, "already has one with that name"); 50 templates per company (`too-large`).
- After `unavailable` or no answer to a save: `load` (or `list`) and compare the revision before saving again, as for payslip templates.

## Payslip app (app id: `payslip`)

The dashboard's registry entry is active and loads the app from `https://noor1290.github.io/payslip/` (keep the trailing slash). It is registered for five data types:

| Data type          | The app may ask for it | The app may save it | Asked of the dashboard's user        |
| ------------------ | ---------------------- | ------------------- | ------------------------------------ |
| `payroll-result`   | yes                    | no                  | a prompt, and the password gate open |
| `statutory-rates`  | yes                    | yes                 | nothing                              |
| `payslip-template` | yes                    | yes                 | nothing                              |
| `payslip-issue`    | yes, admins only       | yes, admins only    | to ask: a prompt, and the password gate open; to save: no prompt, but the gate must already be open |
| `payslip-batch`    | yes, admins only       | no                  | the list of companies: nothing; a month of several companies: ONE prompt, and the password gate open |

**Every answer to a request for the last three says who the user is: `meta.role`**, `"admin"` or `"member"`, the signed-in user's role in the company the answer is about. Use it to show read-only from the start instead of finding out from a `forbidden`. It is a hint: the database still decides, and a save can still be refused. It is not on the acknowledgement of a save, and not on `payroll-result`.

### Payroll results

Same as `pdf-form-filler`: copy the file, `init({ appId: "payslip", onData })`, and import `payload.rows`. A **Get from dashboard** button works the same way too: `requestData("payroll-result", "2026-09")`.

The payslip needs each employee's `Employee CSG` and `Employee NSF`. They are optional in the rows (see the note in the `pdf-form-filler` section): when a key is missing, show that employee's figure as missing; do not use `0`.

A row from a saved run also has `Date of Employment` (text, `YYYY-MM-DD`) when the dashboard has that employee's date. The key is left out when it does not; it is never `""`. The date is typed in the dashboard's Data explorer. Since 17 Oct 2026 (rehearsal fix F6) a saved payroll file (or "Send to dashboard") also sets it, from a valid `YYYY-MM-DD` value only. Since 20 Oct 2026 (the Date type in the payroll app, where the date is now kept; migration 0017) a different date already set is replaced only by one sent for the same or a newer month than the month it came from, so a date changed in a later month reaches the payslip and sending an older month again never overwrites it. A date typed in the Data explorer is replaced only by a month newer than the company's newest saved month when it was typed; a date stored before migration 0017 counts as typed. A date someone changed between the read and the save is kept. Until migration 0017 is run, a date already set is kept. The date is per employee, not per month: rows of any run read afterwards carry the newest date.

### Rates and templates: what is the same for both

- **No prompt and no password gate.** The dashboard answers by itself, straight away. This departs from the rule "a `request-data` always asks the user first" (docs/BRIEF.md, section 12), on purpose: rates and templates are settings and layout, with nothing about any employee in them, and the payslip app reads and saves them many times in a sitting. A prompt each time would only teach the user to click through it. In its place, every exchange is a row in the dashboard's Transfer log (who, when, how many rows, the outcome; never the values, a template's name or its body), and every save shows a toast in the dashboard. `payroll-result` keeps its prompt and its gate.
- **The database decides who may do what.** Any member of the company may read, drafts included. Only an admin may save or publish. The dashboard checks the role first only to answer sooner.
- **A request** is `sendToDashboard("request-data", { dataType, params })`. `bridge.js` waits up to 120 seconds for the answer; the dashboard normally answers in well under one. The answer is `{ ok: true, dataType, rows, meta: { label, brn, role } }`: `rows` may be empty, `label` is the company's name, `brn` is the BRN of the company the answer is about (left out only if that company has none), and `role` is `"admin"` or `"member"`. Check `meta.brn` against the company the app is showing before using the rows.
- **A save** is `sendToDashboard("send-data", { dataType, rows: [row] })` with exactly ONE row: one command per message. The row must carry `brn`, the BRN of the company the app is showing; the dashboard refuses the save when it is not the company selected there. The answer is `{ ok: true, result: { … } }`.
- **`params.brn` on a request is optional** and checked the same way when present. Send it whenever the app knows it.
- **Nothing is rounded or filled in.** A field the dashboard does not know, a missing field, or a value of the wrong type or precision refuses the whole message.
- **A refusal** is `{ ok: false, error, code }`. `error` is a sentence for the user; `code` is for the app:

  | `code`          | Meaning                                                                                              | What the app should do                                                |
  | --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | `stale`         | Someone saved since the app loaded: `expected_revision` is no longer the current one.                | Reload, show the newer version, let the user redo the change.         |
  | `no-change`     | The save is identical to what is stored (rates), or to the latest published version (publish).       | Tell the user nothing needed saving. Not an error.                    |
  | `forbidden`     | The user is not an admin of this company.                                                            | Show read-only.                                                       |
  | `wrong-company` | The BRN sent is not the selected company's (or that company has no BRN).                             | Ask the user to select the same company in the dashboard.             |
  | `invalid`       | A field is missing, unknown, of the wrong type, out of range or too precise; a template name is taken; a body contains an image. | Fix the data. `error` names the field, never its value. |
  | `not-found`     | No such template or version in this company.                                                         | Reload the list.                                                      |
  | `too-large`     | Over a size limit, or the company has reached its limit of templates or rates versions.              | Make it smaller; a retry cannot help.                                 |
  | `unavailable`   | The dashboard could not do it: nobody signed in, no company selected, the database is not reachable or not set up, or a save was not confirmed in time. | See the rule below before saving again. |

- **After "no answer" or `unavailable` on a save: reload, then compare the revision, before saving again.** The dashboard answers a save within 8 seconds: the real outcome if it has one, otherwise `unavailable` ("could not confirm the save"). `bridge.js` gives up by itself after 10 seconds (`{ ok: false, error }` with no `code`). In both cases the save MAY have been stored. So the app must not send it again as it is. It must ask for the data again and look at the revision: if it has moved on to the one the save would have produced, the save went through; if it has not, the app may save again with the same `expected_revision`. An app that skips this is not harmed (the second save is refused as `stale` or `no-change`), but its user is told a save failed when it did not.

### `statutory-rates`

A company's employee-side NSF and CSG settings from a given month onwards. Rows are never changed: a correction is a new revision for the same month. Rates are percentages (`1.5` means 1.5 %); the ceiling and the threshold are rupees a month.

Request: `params` is optional, `{ brn? }`. The answer has every version of the selected company, newest month first, then newest revision first (at most 1,000):

```js
{
  effective_from: "2026-07",      // the first month these values apply to
  revision: 2,                    // 1, 2, 3… per month; the highest is the one in force
  nsf_employee_rate: 1,
  nsf_ceiling: 29710,
  nsf_exempt_at_60: true,
  csg_employee_rate_low: 1.5,
  csg_employee_rate_high: 3,      // applies strictly above the threshold
  csg_threshold: 50000,
  source_note: "Finance Act 2026", // or null
  created_at: "2026-07-02T09:00:00+04:00",
  created_by_you: true            // never a user id
}
```

Save: one row with `brn`, `effective_from` (`"YYYY-MM"`), `expected_revision` (the highest revision the app has seen for that month; `0` when the month has none), the six values above, and optionally `source_note` (at most 300 characters). Rates are 0 to 100 with at most 4 decimals; amounts are 0 or more with at most 2. No other key is accepted. The answer's `result` is `{ effective_from: "2026-07", revision: 3 }`.

### `payslip-template`

A template has a name, a draft and any number of published versions. The draft has a revision number that goes up by one on every save. Publishing copies the draft as it is into the next version; a published version is never changed. A body is a JSON object the payslip app defines (labels, lines, which payroll column fills which line): the dashboard stores and returns it exactly as sent and never looks inside, except to refuse an image.

Requests, by `params.action`:

| `params`                                         | Answer rows                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `{ action: "list", brn? }`                       | One per template, by name, without bodies: `template_id`, `name`, `draft_revision`, `updated_at`, `updated_by_you`, `published_version` and `published_at` (both `null` when never published), and `in_use_version`: the version of this template used for the company's payslips, or `null` (see "The template used for the payslips" below). |
| `{ action: "load", template_id, brn? }`          | One row, the draft: `template_id`, `name`, `draft_revision`, `body`, `updated_at`, `updated_by_you`.                            |
| `{ action: "load", template_id, version, brn? }` | One row, that published version: `template_id`, `name` (as it was when published), `version`, `body`, `published_at`, `published_by_you`. |

Saves, by the row's `action`:

| Row                                                                                   | `result`                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `{ action: "save-draft", brn, name, body, expected_revision: 0 }` (a new template; `template_id` absent or `null`) | `{ template_id, name, draft_revision: 1, updated_at }` |
| `{ action: "save-draft", brn, template_id, name, body, expected_revision }`           | `{ template_id, name, draft_revision, updated_at }`         |
| `{ action: "publish", brn, template_id, expected_revision }`                          | `{ template_id, version, draft_revision, published_at }`    |
| `{ action: "use", brn, template_id, version }` (both `null` to clear the choice)      | `{ action: "use", template_id, version }`                   |
| `{ action: "publish-copy", brn, company_brn, name, body, expected_revision }`         | `{ action: "publish-copy", brn, company, template_id, name, version, draft_revision, created, published, published_at }` |
| `{ action: "publish-summary", brn, name, published, skipped, failed, unconfirmed }`  | `{ action: "publish-summary" }`                              |

`expected_revision` is the `draft_revision` the app last saw. A save-draft always sends the whole draft (name and body); renaming is a save-draft with the new name. Publishing publishes exactly the draft revision named, or is refused as `stale`.

Limits:

- A body is at most 150 KB as JSON at the dashboard (`too-large`). The database's own limit is 256 KB; the dashboard's is lower so that a template always fits in one message with room to spare.
- A company has at most 50 templates (`too-large`).
- A name is 1 to 80 characters after trimming, and unique in its company whatever the capitals (`invalid`).
- No images or other embedded files: a body in which any text or key contains a `data:` URI is refused (`invalid`). A logo is not part of a template in this stage.
- There is no action to delete or archive a template, and a published version can never be removed. Anything other than the actions above is `invalid`. (Follow-up: docs/FUTURE_WORK.md, section 9c.)

#### The template used for the payslips, and publishing to several companies

Added with migration `supabase/migrations/0018_payslip_template_in_use.sql`. Until it is run, `list` gives `in_use_version: null` everywhere and the three messages below are refused as `unavailable`, naming that file.

**The template used for the payslips.** A company may have one published version chosen for its payslips; nothing is chosen for any company at first. `list` says which (`in_use_version` on that template's row). `use` sets it, for the selected company, admins only; `template_id` and `version` must name one of its published versions (`not-found` otherwise), or both be `null` to clear it. Anyone may read it; when nothing is chosen the app keeps its own rule (one published template, or it asks).

**The check before publishing to several companies.** A request:

| `params`                                  | Answer rows |
| ----------------------------------------- | ----------- |
| `{ action: "check", brn, name, page? }`   | One per company the user is an ADMIN of and that has a BRN, the selected company first (`selected: true`), then by name: `{ brn, company, selected, templates, template, payroll }`. 50 companies per answer: `page` 0 (or absent) is the first 50, `page` 1 the next 50, and so on, up to 999; a page with fewer than 50 rows is the last. There is no limit on the number of companies. |

- `brn` is required and must be the selected company's, and the user must be an admin of it (`forbidden`). The companies are read from the database at that moment; a company the user is only a member of, or not a member of, is never in the answer.
- `templates`: how many templates the company has (at most 50).
- `template`: its template with that `name`, capitals ignored, or `null`: `{ template_id, name, draft_revision, published_version, unpublished_changes, latest_is_same }`. `unpublished_changes` is `true` when the draft is not exactly its latest published version (or it was never published): publishing to it would replace that draft. `latest_is_same` is `true` when its latest published version already is exactly the selected company's saved draft with that name (the one being published): publishing to it then adds no version and only makes that version the one used for its payslips.
- `payroll`: its newest saved run, or `null` when it has none: `{ period: "YYYY-MM", employees, columns }`. `columns` are the keys "Get from dashboard" gives that run's rows (the standard fields, "Employee CSG" and "Employee NSF" when some row has them, and the company's own columns), names only. "Date of Employment" is not listed: it belongs to the employee. The database function behind it (`payroll_run_columns`) returns key names only, never a value, and only to an admin of that company.
- No prompt and no password gate, as for the other template messages: nothing in it is per employee.

**Publishing to one company.** A save, one company per message, so that each company gets all of it or none and one failure does not stop the others:

- `company_brn` names the company: the selected one, or another the user is an ADMIN of (`forbidden` otherwise, checked against the database, and again by the database function).
- `name` and `body` are what is published, with the same limits as `save-draft`.
- `expected_revision` is that company's `template.draft_revision` from the check, or `0` when it had no template with that name. If that is no longer so (someone saved there since, or made a template with that name), the save is refused as `stale` and nothing is stored there.
- In one step: its template with that name gets the body as its draft and a new published version (unless its latest version already is exactly that: `published: false`), or a new template is made, published as version 1 (`created: true`); and that version becomes the one used for its payslips. Issued payslips are never touched.
- The answer names the company (`brn`, `company`). Each company is a row in the Transfer log, but has NO toast of its own, published or refused: the batch has one toast (below).

**The end of a batch.** After the last company, the app sends `publish-summary` with the counts of companies published to (`published`, including those that already had that version and now use it), not ticked (`skipped`), refused (`failed`) and not confirmed (`unconfirmed`), each 0 to 100,000, at least one of them above 0. The dashboard stores nothing and adds no Transfer log row; it shows ONE toast, a success when nothing failed and a warning otherwise, for example `Payslip template "Monthly payslip" published to 4 companies; 2 skipped, 1 not published.` A count of 0 is left out of it. Publishing to the selected company only (`publish`) keeps its own toast, as before.
- After `unavailable` or no answer: run the check again and compare that company's template before sending it again (its `draft_revision` and `published_version` will have moved if it went through).

Ready-to-paste example:

```js
const hub = window.PayrollHubBridge;
const ask = (params) => hub.sendToDashboard("request-data", { dataType: "payslip-template", params });
const save = (row) => hub.sendToDashboard("send-data", { dataType: "payslip-template", rows: [row] });

const list = await ask({ action: "list", brn });
if (!list.ok) return showMessage(list.error);
if (list.meta.brn !== brn) return showMessage("The dashboard has another company selected.");

const loaded = await ask({ action: "load", brn, template_id: list.rows[0].template_id });
let { draft_revision } = loaded.rows[0];

const reply = await save({
  action: "save-draft", brn, template_id: loaded.rows[0].template_id,
  name: "Monthly payslip", body, expected_revision: draft_revision,
});
if (reply.ok) draft_revision = reply.result.draft_revision;
else if (reply.code === "stale") reloadAndShowNewerDraft();
else if (!reply.code || reply.code === "unavailable") reloadAndCompareRevision(); // the rule above
else showMessage(reply.error);
```

### `payslip-issue`

The payslips as they were issued: one snapshot per employee, per month, per revision. A snapshot is never changed and never removed; issuing again for the same employee and month is the next revision. This is per-employee data (national IDs and pay), so it does NOT follow the "no prompt, no gate" rule above:

- **Admins only.** A member who is not an admin is refused with `forbidden`, for a load and for an issue. `meta.role` on any earlier answer already says which the user is.
- **`brn` is required**, on a load as on an issue, and must be the company selected in the dashboard.
- **A load asks the dashboard's user first**, in the same dialog as `payroll-result`, and needs the password gate open (the dialog offers the password form). It can take up to 100 seconds and can end in `locked`, `denied` or `timeout`. Whatever can be refused without asking (`invalid`, `wrong-company`, `forbidden`, `unavailable`) is refused straight away.
- **An issue has no dialog**: a save must be answered within 8 seconds. The password gate has to be open already. While it is locked the save is refused at once with `locked` and NOTHING is stored, so after the user has unlocked the dashboard the app may send the very same message again.
- **An issue is all or nothing.** Every payslip in the message is stored at its next revision, or none is.
- Every exchange is a row in the dashboard's Transfer log and an issue shows a toast: the number of payslips and the month. Never a national ID, a name or a figure.

**Load a month**: `sendToDashboard("request-data", { dataType: "payslip-issue", params })`.

| `params`                                         | Answer rows                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `{ action: "load", brn, period: "YYYY-MM" }`     | One per employee who has a payslip for that month, the LATEST revision only, ordered by national ID. May be empty. |

Each row:

```js
{
  national_id: "X0000000000001",   // the "ID" of the payroll rows
  revision: 2,                     // 1, 2, 3… per employee and month; send it back as expected_revision
  template_id: "…uuid…",
  template_version: 3,
  rates: { effective_from: "2026-07", revision: 2, nsf_employee_rate: 1, /* … */ }, // or null: not cross-checked
  lines: [ /* exactly as the app sent them */ ],
  accepted_differences: [ { what: "Total Deductions", payroll: 502.87, payslip: 502.88, reason: "rounding" } ],
  issued_at: "2026-10-02T09:00:00+04:00",
  issued_by_you: true              // never a user id
}
```

`meta` is `{ label, brn, period, role }`. Earlier revisions are not returned (follow-up: docs/FUTURE_WORK.md, section 9c). For the month comparison, load each of the two months.

**Issue a month**: `sendToDashboard("send-data", { dataType: "payslip-issue", rows: [row] })` with exactly ONE row, which holds the whole selection:

| Row                                                                  | `result`                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `{ action: "issue", brn, period: "YYYY-MM", payslips: [ … ] }` (1 to 1,000 payslips) | `{ period, issued, issued_at, payslips: [{ national_id, revision }] }` |

Each payslip, with every key present and no other key accepted:

| Key                    | What it is                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `national_id`          | The employee, by the `ID` of the payroll rows (outer spaces ignored). Must be a current employee of the company in the dashboard: the month's payroll has to be saved there first. Once per message. |
| `expected_revision`    | The revision the app last saw for this employee and month in a load; `0` when there is none.                                |
| `template_id`, `template_version` | A PUBLISHED version of one of the company's templates. Never a draft.                                            |
| `rates`                | `null` when the figures were not cross-checked. Otherwise the rates row used, copied: `effective_from` (`"YYYY-MM"`), `revision`, `nsf_employee_rate`, `nsf_ceiling`, `nsf_exempt_at_60`, `csg_employee_rate_low`, `csg_employee_rate_high`, `csg_threshold`. Exactly those eight keys. |
| `lines`                | 1 to 200 JSON objects, the lines shown on the payslip, in a shape the payslip app defines. Stored and returned exactly as sent: nothing is rounded, renamed or reordered. |
| `accepted_differences` | A list, possibly empty, of at most 50 `{ what, payroll, payslip, reason }`: `what` names the figure (1 to 80 characters), `payroll` and `payslip` are the two numbers, `reason` says why the difference was accepted (1 to 300 characters). No other key. WHO accepted is not sent: it is the dashboard's signed-in user at the moment of issuing, recorded by the database. |

The revision, the issuer and the time are set by the database. A payslip that tries to set them (`revision`, `issued_by`, `issued_at`) is refused as `invalid`.

**Which payslip was at fault: `index`.** When a month is refused because of ONE payslip, the refusal carries `index`: the position of the first payslip at fault in the `payslips` list the app sent, **counted from 0** (so `payslips[reply.index]` is it). The dashboard never names the employee, in the reply, in its log or in a toast: the app names them from the position. `index` is absent when the refusal is about the message as a whole. Some `error` sentences count for the reader instead and say "payslip 3": that is the same payslip as `index: 2`.

| `code`          | When, for `payslip-issue`                                                                                   | `index` | What the app should do                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| `locked`        | The password gate is closed. An issue: refused at once, nothing stored. A load: still locked after 100 seconds. | no  | Ask the user to unlock the dashboard, then send the same message again. |
| `denied`, `timeout` | A load only: the user said no, or nobody answered in time.                                              | no      | Tell the user; ask again when they are ready.                       |
| `forbidden`     | The user is not an admin of the company.                                                                    | no      | Show read-only.                                                     |
| `wrong-company` | `brn` is not the selected company's.                                                                        | no      | Ask the user to select the same company in the dashboard.           |
| `stale`         | For that employee, `expected_revision` is not the latest: someone issued since the month was loaded.        | yes     | Load the month again, show what was issued, let the user decide.    |
| `not-found`     | That payslip is for someone who is not a current employee in the dashboard, or names a template version the company does not have. `error` says which of the two. | yes | Save the payroll run in the dashboard first, or reload the templates. |
| `invalid`       | A key is missing, unknown or of the wrong type; an employee appears twice; a `data:` URI (an image) in a payslip. | yes, when it is inside one payslip | Fix the data.                             |
| `too-large`     | More than 1,000 payslips or a message over 4 MB (no `index`); a payslip over 16 KB, or an employee who already has 50 revisions for that month (with `index`). | sometimes | Send fewer, or make it smaller; a retry cannot help. |
| `unavailable`   | As for rates and templates, including "could not confirm the save".                                         | no      | The rule below.                                                     |

**After "no answer" or `unavailable` on an issue: load the month again, then compare, before issuing again.** The rule is the one for rates and templates, read per month: the issue MAY have been stored. Because it is all or nothing, the load shows one of two things. Every employee of the selection is at `expected_revision + 1`: it went through; do not send it again. None has moved: it did not; the app may send the same message again. (An app that skips this is refused as `stale` at `index` 0 and stores nothing twice, but tells its user an issue failed when it did not.)

Ready-to-paste example:

```js
const hub = window.PayrollHubBridge;
const loadMonth = (period) =>
  hub.sendToDashboard("request-data", { dataType: "payslip-issue", params: { action: "load", brn, period } });

// 1. Load the month (the dashboard asks its user; allow up to two minutes).
const loaded = await loadMonth("2026-09");
if (!loaded.ok) return showMessage(loaded.code === "forbidden" ? "Only an admin can issue payslips." : loaded.error);
const seen = new Map(loaded.rows.map((row) => [row.national_id, row.revision]));

// 2. Issue the selected employees, all or none.
const payslips = selected.map((employee) => ({
  national_id: employee.ID,
  expected_revision: seen.get(employee.ID) ?? 0,
  template_id, template_version,
  rates: ratesUsed ?? null,
  lines: linesShownFor(employee),
  accepted_differences: acceptedFor(employee),
}));
const reply = await hub.sendToDashboard("send-data", {
  dataType: "payslip-issue",
  rows: [{ action: "issue", brn, period: "2026-09", payslips }],
});

if (reply.ok) reply.result.payslips.forEach((p) => seen.set(p.national_id, p.revision));
else if (reply.code === "locked") showMessage("Unlock the dashboard, then issue again."); // nothing was stored
else if (!reply.code || reply.code === "unavailable") reloadMonthAndCompare();             // the rule above
else if (typeof reply.index === "number") showMessage(`${nameOf(selected[reply.index])}: ${reply.error}`);
else showMessage(reply.error);
```

### `payslip-batch`

Payslips for several companies at once, download only: nothing is ever saved through this data type. Each company the app works on is one the user is an ADMIN of, read from the database at each request; everything else stays scoped to the selected company. `brn` must be the selected company's (`wrong-company` otherwise); it is required on `ask` and `load`.

| `params`                                                     | Asked of the user | Answer rows |
| ------------------------------------------------------------ | ----------------- | ----------- |
| `{ action: "companies", brn? }`                              | nothing           | One per company the user is an admin of and that has a BRN, the selected company first, then by name: `{ brn, name, selected }`. Names only. `meta.brn` is the selected company: the BRN to send on `ask` and `load`. |
| `{ action: "ask", brn, period, companies: [brn, ...] }` or `{ action: "ask", brn, period, all: true }` | ONE prompt, in the same dialog as a saved run, with the password gate open | The companies allowed: `{ brn, name }`. `meta.period` is the month. |
| `{ action: "load", brn, period, company_brn }`               | nothing more      | ONE row for that company (below). |

- **`ask`** names 1 to 100 companies, or `all: true` for every company the user is an admin of (an app with more than 100 chosen asks for all and loads only its own). A company the user is not an admin of is refused at once as `forbidden` ("Only companies where you are an admin can be chosen."), without asking. The prompt says which month and which companies ("It wants the September 2026 payroll of 10 companies: ABC Co Ltd, DEF Ltd, GHI Ltd and 7 more."). `denied`, `timeout` and `locked` as for `payroll-result`.
- **Agreeing allows `load`** for those companies and that month only, for this app, this user and the company selected now, for 15 minutes. It is kept in the dashboard's memory only and is forgotten when the password gate locks, on sign-out, or when the app asks again. A `load` outside it is refused as `denied` ("That company and month were not allowed in the dashboard for this app. Ask again."), with nothing read.
- **`load`** needs the gate open (`locked` otherwise, nothing read) and the user to be an admin of that company still (`forbidden`, "Only an admin of that company can make its payslips."). Its one row: `{ brn, company, period, run, employees, template, template_reason, rates, issued }`:
  - `run`: whether the company has a saved run for that month; `employees`: its rows, exactly as `payroll-result` gives them (none when there is no run).
  - `template`: the template its payslips use, `{ template_id, name, version, body }`: the version chosen for the payslips (`in_use_version`); otherwise its one published template's latest version; otherwise `null`, with `template_reason` `"none"` (no published template) or `"several"` (more than one, none chosen).
  - `rates`: every version of its statutory rates, as `statutory-rates` gives them.
  - `issued`: the payslips already issued for that month, the latest revision of each, as `payslip-issue` `load` gives them (`issued_by_you`, never a user id). The app downloads one that is issued and unchanged exactly as it was stored.
- Every request is a row in the Transfer log (a `load` counts one row: the company), never with a value.

## How to check it works

The bridge only trusts the **deployed** dashboard at `https://noor1290.github.io`. It will not connect to a dashboard running on `localhost`; there the app shows as "Not connected (local run)". So:

1. Deploy the app with the bridge added.
2. Open the deployed dashboard and go to **Workspace**. The app's dot should turn green ("Ready") within a few seconds. A violet ring ("Bridge not installed") means `init` was not called or the file is missing.
3. `payroll_sys`: click **Send to dashboard**. The dashboard should show "Payroll results received (N employees)".
4. `pdf-form-filler`: from that dialog choose **Send to… → PDF Form Filler**. The dashboard should say "Delivered" and the app should show the data.
5. Open each app directly in its own tab. No dashboard buttons should appear and everything should work as before.

To try the dashboard side without touching the real apps, run `npm run dev:demo` in the `payroll_hub` repo: it loads mock apps that use the real `bridge.js`. The mock payslip app has a button for each rates and template message, and buttons to load and issue a month of payslips, against fake data kept in memory.

## Protocol reference (version 1)

Every message is an envelope:

```js
{ type, from, to, version: 1, id, payload }
```

- `from` / `to`: an app id, or `"dashboard"`.
- `id`: unique per message (letters, digits, `-`, `_`; 8 to 64 characters). A reply reuses the id of the message it answers.

| Type            | Direction                    | Payload                                                             | Reply                            |
| --------------- | ---------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `ready`         | app → dashboard              | `{}`                                                                | a `ping`                         |
| `ping`          | either                       | `{}`                                                                | `pong`, same id                  |
| `activity`      | app → dashboard              | `{}`                                                                | none                             |
| `unsaved`       | app → dashboard              | `{ unsaved: true }` or `{ unsaved: false }`, nothing else           | none                             |
| `send-data`     | dashboard → app, or app → dashboard | `{ dataType, rows: [...], meta?: { period?: "YYYY-MM", label?, brn?, role? } }` | `received`, same id |
| `received`      | reply to `send-data`         | `{ ok: true, result? }` or `{ ok: false, error, code?, index? }`    |                                  |
| `request-data`  | app → dashboard              | `{ dataType, period?: "YYYY-MM", params? }`                         | `response-data`, same id         |
| `response-data` | dashboard → app              | `{ ok: true, dataType, rows, meta }` or `{ ok: false, error, code? }` |                                |

Still version 1. What the payslip app needed was added as optional parts, so an app written before them keeps working unchanged and `bridge.js` did not change: `params` on a request (an object of at most 2 KB, its shape checked per data type), `result` on an ok `received` from the dashboard, `code` on a refused `received`, `brn` and `role` in `meta`, `index` on a refused `received` (the position, from 0, of the payslip at fault in a refused month), more refusal codes, and an answer with no rows for `statutory-rates`, `payslip-template` and `payslip-issue` (`payroll-result` always has at least one).

`activity` (added 13 Oct 2026, also still version 1) is sent by `bridge.js` itself; an app has nothing to do for it. While the user clicks, types, scrolls or touches inside the app, `bridge.js` says so at most once every 30 seconds, at once if it has not said so lately and otherwise when its turn comes. The message has nothing in it: it says that something was done, never what. The dashboard treats it exactly like a key pressed in the dashboard itself, so neither its sign-out for inactivity nor its password gate happens in the middle of work in an app. It counts only from the app that is showing, in a visible tab, and at most once every 5 seconds per app whatever is sent. There is no reply. An app that still carries the older `bridge.js` keeps working and simply does not send it; its user can then be signed out while working in it, as before. A dashboard that does not know the message yet ignores it, so deploy the dashboard first and copy the new `bridge.js` into the apps after.

`unsaved` (added 17 Oct 2026, rehearsal fix F1, also still version 1) is sent by `bridge.js` when the app calls `setUnsaved`, and only when the value changes. It says whether the app holds changes not saved yet, never what they are. The dashboard keeps it per app frame and forgets it when the frame loads a page again. When its user changes company (a switch, or Add company, which selects the new company), the dashboard first asks if any app said `true`, naming the apps, with "Stay on <the company shown>" as the default and "Switch anyway"; then it reloads every app frame. After a company is added or deleted it does not ask again. There is no reply. An app that still carries the older `bridge.js` never sends it and counts as having nothing unsaved: its frame simply reloads. A save stays protected exactly as before: by the BRN check, whatever is answered.

Limits per data type, checked by the dashboard before anything else:

| Data type          | Rows an app may send in one message | Size of those rows as JSON      | Rows in an answer |
| ------------------ | ----------------------------------- | ------------------------------- | ----------------- |
| `payroll-result`   | 1 to 10,000                         | no limit of its own             | 1 to 10,000       |
| `statutory-rates`  | exactly 1                           | 4 KB                            | 0 to 1,000        |
| `payslip-template` | exactly 1                           | 160 KB (the body itself: 150 KB) | 0 to 50          |
| `payslip-issue`    | exactly 1, holding 1 to 1,000 payslips | 4 MB (each payslip: 16 KB)   | 0 to 5,000        |
| `payslip-batch`    | none: request only                  | none                            | 0 to 5,000        |
| `payroll-batch`    | none: request only                  | none                            | 0 to 500          |
| `pdf-template`     | exactly 1                           | 270 KB (the body itself: 250 KB) | 0 to 200         |
| `pdf-file`         | exactly 1, holding one file         | 7.1 MB (a 5 MB file as base64)  | exactly 1         |

Rules both sides follow:

- A message is accepted only from the expected window **and** the exact expected origin, with the expected `version`, `from` and `to`. Anything else is dropped.
- The target origin is always the exact origin, never `"*"`.
- The dashboard waits about 10 seconds for `received`. After that it reports a failure and offers **Retry** (same id) and **Download JSON instead**. An acknowledgement that arrives after the timeout is ignored.
- A refused `response-data` may carry a `code`: `"locked"` (the dashboard's password gate is closed and its user did not unlock it in time), `"denied"` (the user said no), `"timeout"` (nobody answered), or `"unavailable"`. The dashboard always answers a request within about 100 seconds; it never leaves one hanging. On `"locked"`, tell the user to unlock the dashboard and try again. Those first three only happen for `payroll-result` and `payslip-issue`, the two data types behind the password gate; an issue of payslips can also be refused as `"locked"`, at once.
- A refusal about rates, templates or issued payslips, whether to a request or to a save, always carries a `code`. For rates and templates it is one of `"stale"`, `"no-change"`, `"forbidden"`, `"wrong-company"`, `"invalid"`, `"not-found"`, `"too-large"`, `"unavailable"`. The table in the payslip section says what each means; `payslip-issue` has its own table there, which adds `"locked"`, `"denied"` and `"timeout"` and has no `"no-change"`. (A message the dashboard turns away before looking at it, such as a data type the app is "not registered" for, has an `error` and no `code`.)
- The dashboard answers an app's save within 8 seconds, inside the 10 seconds `bridge.js` waits: with the outcome, or with `"unavailable"` when it has none yet. It never answers the same save twice. After `"unavailable"` or no answer, an app reloads and compares the revision before it saves again (the payslip section has the rule in full).
- An app may only send a data type listed in its registry entry's `produces`, and only receive or request one listed in `accepts`.
- The dashboard pings every 15 seconds while its tab is visible. Two missed pings show the app as "Not responding".
- Pings are not activity. Only `activity`, which follows something the user did, holds off the sign-out and the password gate.

## Moving the dashboard to another origin later

The trusted origin is one line at the top of `bridge.js` (`HUB_ORIGIN`) and one constant in the dashboard (`HOSTING.dashboard` in `src/config/origins.ts`). A test in the dashboard fails if they differ. Change both, redeploy the dashboard, and copy the new `bridge.js` into each app.
