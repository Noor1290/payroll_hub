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

1. **Copy the file.** Copy `docs/bridge.js` from the `payroll-hub` repo to `src/payrollHubBridge.js` in the app. Do not edit it. If the app lints its sources, add the file to the linter's ignore list.
2. **Load it once**, at the top of the app's entry file (`src/main.jsx` or `src/main.tsx`):

   ```js
   import "./payrollHubBridge.js"; // defines window.PayrollHubBridge
   ```

   For TypeScript, add a declaration file `src/payrollHubBridge.d.ts`:

   ```ts
   interface PayrollHubPayload {
     dataType: string;
     rows: Record<string, unknown>[];
     meta?: { period?: string; label?: string; brn?: string };
   }
   type PayrollHubReply =
     | ({ ok: true; result?: Record<string, unknown> } & Partial<PayrollHubPayload>)
     | { ok: false; error: string; code?: string };
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
       onStatus(listener: (connected: boolean) => void): () => void;
     };
   }
   ```

3. **Start it once**, with the app's id from the dashboard registry (see the per-app sections).
4. **Show the dashboard buttons only when embedded**: `window.PayrollHubBridge.isEmbedded()`. Standalone, the app must look and behave as it does now.
5. **Never** change `HUB_ORIGIN`, never add a localhost origin, never use `"*"` as a target origin, and never write received payroll data to `localStorage` or the URL.

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

> Read `docs/INTEGRATION.md` and `docs/bridge.js` from the payroll-hub repo (I will paste or copy them in). Copy bridge.js unchanged to `src/payrollHubBridge.js`, import it once in the entry file, and call `PayrollHubBridge.init({ appId: "payroll" })` once in the root component. Find where the "pdf-fill" JSON export array is built and add a "Send to dashboard" button beside the existing export button, shown only when `PayrollHubBridge.isEmbedded()`. It must send the exact same array with `dataType: "payroll-result"` and `meta.period` as `YYYY-MM`, and show the reply's success or error. Do not change the existing export, do not edit bridge.js, and make sure the app behaves exactly as before when opened on its own.

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

> Read `docs/INTEGRATION.md` and `docs/bridge.js` from the payroll-hub repo (I will paste or copy them in). Copy bridge.js unchanged to `src/payrollHubBridge.js`, import it once in the entry file, and call `PayrollHubBridge.init({ appId: "pdf-editor", onData })` once in the root component. `onData` must pass `payload.rows` into the same code path the JSON file import uses after parsing (find it via the message "doesn't look like a valid JSON file"), and throw an Error with a clear message when the rows cannot be used. Add a "Get from dashboard" button shown only when `PayrollHubBridge.isEmbedded()`, using `requestData("payroll-result")`. Do not write the received data to localStorage, do not edit bridge.js, and make sure the app behaves exactly as before when opened on its own.

## Payslip app (app id: `payslip`)

The dashboard's registry entry is active and loads the app from `https://noor1290.github.io/payslip/` (keep the trailing slash). It is registered for three data types:

| Data type          | The app may ask for it | The app may save it | Asked of the dashboard's user        |
| ------------------ | ---------------------- | ------------------- | ------------------------------------ |
| `payroll-result`   | yes                    | no                  | a prompt, and the password gate open |
| `statutory-rates`  | yes                    | yes                 | nothing                              |
| `payslip-template` | yes                    | yes                 | nothing                              |

`payslip-issue` (issued payslips) is not registered yet: asking for it or sending it is answered with "not registered".

### Payroll results

Same as `pdf-form-filler`: copy the file, `init({ appId: "payslip", onData })`, and import `payload.rows`. A **Get from dashboard** button works the same way too: `requestData("payroll-result", "2026-09")`.

The payslip needs each employee's `Employee CSG` and `Employee NSF`. They are optional in the rows (see the note in the `pdf-form-filler` section): when a key is missing, show that employee's figure as missing; do not use `0`.

A row from a saved run also has `Date of Employment` (text, `YYYY-MM-DD`) when the dashboard has that employee's date. The key is left out when it does not; it is never `""`. The date is typed in the dashboard's Data explorer: a payroll file cannot set it.

### Rates and templates: what is the same for both

- **No prompt and no password gate.** The dashboard answers by itself, straight away. This departs from the rule "a `request-data` always asks the user first" (docs/BRIEF.md, section 12), on purpose: rates and templates are settings and layout, with nothing about any employee in them, and the payslip app reads and saves them many times in a sitting. A prompt each time would only teach the user to click through it. In its place, every exchange is a row in the dashboard's Transfer log (who, when, how many rows, the outcome; never the values, a template's name or its body), and every save shows a toast in the dashboard. `payroll-result` keeps its prompt and its gate.
- **The database decides who may do what.** Any member of the company may read, drafts included. Only an admin may save or publish. The dashboard checks the role first only to answer sooner.
- **A request** is `sendToDashboard("request-data", { dataType, params })`. `bridge.js` waits up to 120 seconds for the answer; the dashboard normally answers in well under one. The answer is `{ ok: true, dataType, rows, meta: { label, brn } }`: `rows` may be empty, `label` is the company's name, and `brn` is the BRN of the company the answer is about (left out only if that company has none). Check `meta.brn` against the company the app is showing before using the rows.
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
| `{ action: "list", brn? }`                       | One per template, by name, without bodies: `template_id`, `name`, `draft_revision`, `updated_at`, `updated_by_you`, `published_version` and `published_at` (both `null` when never published). |
| `{ action: "load", template_id, brn? }`          | One row, the draft: `template_id`, `name`, `draft_revision`, `body`, `updated_at`, `updated_by_you`.                            |
| `{ action: "load", template_id, version, brn? }` | One row, that published version: `template_id`, `name` (as it was when published), `version`, `body`, `published_at`, `published_by_you`. |

Saves, by the row's `action`:

| Row                                                                                   | `result`                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `{ action: "save-draft", brn, name, body, expected_revision: 0 }` (a new template; `template_id` absent or `null`) | `{ template_id, name, draft_revision: 1, updated_at }` |
| `{ action: "save-draft", brn, template_id, name, body, expected_revision }`           | `{ template_id, name, draft_revision, updated_at }`         |
| `{ action: "publish", brn, template_id, expected_revision }`                          | `{ template_id, version, draft_revision, published_at }`    |

`expected_revision` is the `draft_revision` the app last saw. A save-draft always sends the whole draft (name and body); renaming is a save-draft with the new name. Publishing publishes exactly the draft revision named, or is refused as `stale`.

Limits:

- A body is at most 150 KB as JSON at the dashboard (`too-large`). The database's own limit is 256 KB; the dashboard's is lower so that a template always fits in one message with room to spare.
- A company has at most 50 templates (`too-large`).
- A name is 1 to 80 characters after trimming, and unique in its company whatever the capitals (`invalid`).
- No images or other embedded files: a body in which any text or key contains a `data:` URI is refused (`invalid`). A logo is not part of a template in this stage.
- There is no action to delete or archive a template, and a published version can never be removed. Anything other than the four actions above is `invalid`. (Follow-up: docs/FUTURE_WORK.md, section 9c.)

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

## How to check it works

The bridge only trusts the **deployed** dashboard at `https://noor1290.github.io`. It will not connect to a dashboard running on `localhost`; there the app shows as "Not connected (local run)". So:

1. Deploy the app with the bridge added.
2. Open the deployed dashboard and go to **Workspace**. The app's dot should turn green ("Ready") within a few seconds. A violet ring ("Bridge not installed") means `init` was not called or the file is missing.
3. `payroll_sys`: click **Send to dashboard**. The dashboard should show "Payroll results received (N employees)".
4. `pdf-form-filler`: from that dialog choose **Send to… → PDF Form Filler**. The dashboard should say "Delivered" and the app should show the data.
5. Open each app directly in its own tab. No dashboard buttons should appear and everything should work as before.

To try the dashboard side without touching the real apps, run `npm run dev:demo` in the `payroll-hub` repo: it loads mock apps that use the real `bridge.js`. The mock payslip app has a button for each rates and template message, against fake data kept in memory.

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
| `send-data`     | dashboard → app, or app → dashboard | `{ dataType, rows: [...], meta?: { period?: "YYYY-MM", label?, brn? } }` | `received`, same id        |
| `received`      | reply to `send-data`         | `{ ok: true, result? }` or `{ ok: false, error, code? }`            |                                  |
| `request-data`  | app → dashboard              | `{ dataType, period?: "YYYY-MM", params? }`                         | `response-data`, same id         |
| `response-data` | dashboard → app              | `{ ok: true, dataType, rows, meta }` or `{ ok: false, error, code? }` |                                |

Still version 1. What the payslip app needed was added as optional parts, so an app written before them keeps working unchanged and `bridge.js` did not change: `params` on a request (an object of at most 2 KB, its shape checked per data type), `result` on an ok `received` from the dashboard, `code` on a refused `received`, `brn` in `meta`, more refusal codes, and an answer with no rows for `statutory-rates` and `payslip-template` (`payroll-result` always has at least one).

Limits per data type, checked by the dashboard before anything else:

| Data type          | Rows an app may send in one message | Size of those rows as JSON      | Rows in an answer |
| ------------------ | ----------------------------------- | ------------------------------- | ----------------- |
| `payroll-result`   | 1 to 10,000                         | no limit of its own             | 1 to 10,000       |
| `statutory-rates`  | exactly 1                           | 4 KB                            | 0 to 1,000        |
| `payslip-template` | exactly 1                           | 160 KB (the body itself: 150 KB) | 0 to 50          |

Rules both sides follow:

- A message is accepted only from the expected window **and** the exact expected origin, with the expected `version`, `from` and `to`. Anything else is dropped.
- The target origin is always the exact origin, never `"*"`.
- The dashboard waits about 10 seconds for `received`. After that it reports a failure and offers **Retry** (same id) and **Download JSON instead**. An acknowledgement that arrives after the timeout is ignored.
- A refused `response-data` may carry a `code`: `"locked"` (the dashboard's password gate is closed and its user did not unlock it in time), `"denied"` (the user said no), `"timeout"` (nobody answered), or `"unavailable"`. The dashboard always answers a request within about 100 seconds; it never leaves one hanging. On `"locked"`, tell the user to unlock the dashboard and try again. Those first three only happen for `payroll-result`, the one data type that asks the user.
- A refusal about rates or templates, whether to a request or to a save, always carries one of `"stale"`, `"no-change"`, `"forbidden"`, `"wrong-company"`, `"invalid"`, `"not-found"`, `"too-large"`, `"unavailable"`. The table in the payslip section says what each means. (A message the dashboard turns away before looking at it, such as a data type the app is "not registered" for, has an `error` and no `code`.)
- The dashboard answers an app's save within 8 seconds, inside the 10 seconds `bridge.js` waits: with the outcome, or with `"unavailable"` when it has none yet. It never answers the same save twice. After `"unavailable"` or no answer, an app reloads and compares the revision before it saves again (the payslip section has the rule in full).
- An app may only send a data type listed in its registry entry's `produces`, and only receive or request one listed in `accepts`.
- The dashboard pings every 15 seconds while its tab is visible. Two missed pings show the app as "Not responding".

## Moving the dashboard to another origin later

The trusted origin is one line at the top of `bridge.js` (`HUB_ORIGIN`) and one constant in the dashboard (`HOSTING.dashboard` in `src/config/origins.ts`). A test in the dashboard fails if they differ. Change both, redeploy the dashboard, and copy the new `bridge.js` into each app.
