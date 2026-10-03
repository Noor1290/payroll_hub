# Connecting an app to Payroll Hub

This is for whoever adds the bridge to an app (`payroll_sys`, `pdf-form-filler`, the future payslip app), including Claude Code working in that app's repository. It explains what to copy, what to wire up, and how to check it works.

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
     meta?: { period?: string; label?: string };
   }
   type PayrollHubReply = ({ ok: true } & Partial<PayrollHubPayload>) | { ok: false; error: string };
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

Ready-to-paste task for Claude Code in the `pdf-form-filler` repo:

> Read `docs/INTEGRATION.md` and `docs/bridge.js` from the payroll-hub repo (I will paste or copy them in). Copy bridge.js unchanged to `src/payrollHubBridge.js`, import it once in the entry file, and call `PayrollHubBridge.init({ appId: "pdf-editor", onData })` once in the root component. `onData` must pass `payload.rows` into the same code path the JSON file import uses after parsing (find it via the message "doesn't look like a valid JSON file"), and throw an Error with a clear message when the rows cannot be used. Add a "Get from dashboard" button shown only when `PayrollHubBridge.isEmbedded()`, using `requestData("payroll-result")`. Do not write the received data to localStorage, do not edit bridge.js, and make sure the app behaves exactly as before when opened on its own.

## Future payslip app (app id: `payslip`)

Same as `pdf-form-filler`: copy the file, `init({ appId: "payslip", onData })`, and import `payload.rows`. On the dashboard side, give the registry entry in `src/config/apps.config.ts` its URL and change `status` to `"active"`. Nothing else in the dashboard needs to change.

## How to check it works

The bridge only trusts the **deployed** dashboard at `https://noor1290.github.io`. It will not connect to a dashboard running on `localhost`; there the app shows as "Not connected (local run)". So:

1. Deploy the app with the bridge added.
2. Open the deployed dashboard and go to **Workspace**. The app's dot should turn green ("Ready") within a few seconds. A violet ring ("Bridge not installed") means `init` was not called or the file is missing.
3. `payroll_sys`: click **Send to dashboard**. The dashboard should show "Payroll results received (N employees)".
4. `pdf-form-filler`: from that dialog choose **Send to… → PDF Form Filler**. The dashboard should say "Delivered" and the app should show the data.
5. Open each app directly in its own tab. No dashboard buttons should appear and everything should work as before.

To try the dashboard side without touching the real apps, run `npm run dev:demo` in the `payroll-hub` repo: it loads mock apps that use the real `bridge.js`.

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
| `send-data`     | dashboard → app, or app → dashboard | `{ dataType, rows: [...], meta?: { period?: "YYYY-MM", label? } }` | `received`, same id              |
| `received`      | reply to `send-data`         | `{ ok: true }` or `{ ok: false, error }`                            |                                  |
| `request-data`  | app → dashboard              | `{ dataType, period?: "YYYY-MM" }`                                  | `response-data`, same id         |
| `response-data` | dashboard → app              | `{ ok: true, dataType, rows, meta }` or `{ ok: false, error, code? }` |                                |

Rules both sides follow:

- A message is accepted only from the expected window **and** the exact expected origin, with the expected `version`, `from` and `to`. Anything else is dropped.
- The target origin is always the exact origin, never `"*"`.
- The dashboard waits about 10 seconds for `received`. After that it reports a failure and offers **Retry** (same id) and **Download JSON instead**. An acknowledgement that arrives after the timeout is ignored.
- A refused `response-data` may carry a `code`: `"locked"` (the dashboard's password gate is closed and its user did not unlock it in time), `"denied"` (the user said no), `"timeout"` (nobody answered), or `"unavailable"`. The dashboard always answers a request within about 100 seconds; it never leaves one hanging. On `"locked"`, tell the user to unlock the dashboard and try again.
- An app may only send a data type listed in its registry entry's `produces`, and only receive or request one listed in `accepts`.
- The dashboard pings every 15 seconds while its tab is visible. Two missed pings show the app as "Not responding".

## Moving the dashboard to another origin later

The trusted origin is one line at the top of `bridge.js` (`HUB_ORIGIN`) and one constant in the dashboard (`HOSTING.dashboard` in `src/config/origins.ts`). A test in the dashboard fails if they differ. Change both, redeploy the dashboard, and copy the new `bridge.js` into each app.
