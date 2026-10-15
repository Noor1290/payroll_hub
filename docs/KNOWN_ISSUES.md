# Known issues (payroll-hub)

Issues in this repo only. The payroll app keeps its own list in `docs/KNOWN_ISSUES.md` in payroll_sys.

Status is one of: **open** (to fix), **watch** (not a fault today; look again if it gets worse), **fixed** (kept for the record).

## 1. A slow test in demoIssuedPayslips.test.ts (watch)

- **Where:** `src/lib/demo/demoIssuedPayslips.test.ts`, the test "issues a month at revision 1, then a re-issue at revision 2, and reads the latest of each".
- **What:** it takes about 3.5 s (3.4 s measured alone on 8 Oct 2026), against Vitest's default limit of 5 s per test. The four "refuses a month because of ..." tests in the same file take about 1.3 s each.
- **Why:** the demo store waits a short time on every call to look like a network, and this test makes about a dozen calls one after another. Nothing is wrong with what it checks.
- **Risk:** on a slow or busy machine it could pass the 5 s limit and fail for no real reason, as the PayrollTable tests did before `fix/test-timeouts`.
- **When to act:** if it fails with a timeout, or is seen above about 4 s. Then make the demo store's pause short under test. Do not raise the limit and do not cut what the test checks.

## 2. The full test run timed out on a busy machine (fixed)

- **Where:** `npm test`, the whole suite. Seen in `PayrollTable.test.tsx`, `LinksPage.test.tsx`, `ProfilePage.test.tsx`, `DatabasePage.test.tsx`, `DeleteCompanySection.test.tsx`, `SettingsPage.test.tsx`, `appDataIssue.test.tsx` and `baseline.test.tsx`.
- **What:** on 13 Oct 2026 the full run failed with "Test timed out in 5000ms" in 7 to 17 tests, a different set each time. It did so on the committed code as well (17 of 922 failed with no change in the working tree), so it is not caused by a change. Each failing file passes when run alone, and the whole suite passes with fewer files run at once: `npm test -- --maxWorkers=4` gave 946 passed (946) in 85 s.
- **Why:** each test file builds its own browser-like environment, and with 16 files at once on this machine the slower screen tests no longer finish inside Vitest's 5 s limit. One timed-out test also leaves its screen behind, which makes the next test in that file fail.
- **Risk:** a red run that says nothing about the code. It hides a real failure only if the output is not read.
- **When to act:** if it keeps happening, set `maxWorkers` in the Vitest config or share the environment between files (Vitest prints that suggestion at the end of a run). Do not raise the 5 s limit.
- **Fixed 13 Oct 2026:** `maxWorkers: 4` in the test settings of vite.config.ts. Plain `npm test` then passed three times in a row.

## 3. Three breaks in `npm run test:prove` are out of date since Phase 1 (fixed 15 Oct 2026)

- **Where:** `scripts/prove.mjs`, breaks 65, 77 and 79 (numbers as the run of 14 Oct 2026 prints them).
- **What:** the run ends "109 of 112 breaks caught". Break 65 ("Issued payslips become available to another app") looks for the PDF form filler's old `accepts: [PAYROLL_RESULT]`, which Phase 1 changed; break 79 looks for `const MIGRATION = "0011_issued_payslips.sql"`, which Phase 1 moved to 0012; break 77 removes a delete from the `delete_company` of 0011, which 0012 replaced, so no test notices. All three are the same on `main` (checked with `git show main:...`): not caused by Phase 2. Every Phase 2 break (106 to 112) is caught.
- **Risk:** the three rules they guarded are still tested; only the proof that those tests can fail is missing.
- **When to act:** when `prove.mjs` is next changed: point 65 at the payslip app's own `accepts`, 79 at the newest migration file name, and 77 at the newest `delete_company`.
- **Fixed (15 Oct 2026, Phase 3):** 65 now adds `PAYSLIP_ISSUE` to the PDF form filler's current `accepts`, 79 names the newest migration (0014), and 77 and the Phase 2 break on the company setup point at the newest `delete_company` (0014). The run ends "122 of 122 breaks caught".

## 4. The payroll app's first question can arrive before the dashboard knows who is signed in (open)

- **Where:** seen against the real database on 15 Oct 2026 (the Phase 3 test, TEST Co Ltd), three times: right after a full page reload or a sign-in, the payroll app inside the dashboard showed "The column setup could not be loaded from the dashboard. Nobody is signed in to the dashboard, or no company is selected." Pressing "Try again" a moment later loaded it every time.
- **Why (from the code, not proven by a test):** the app asks as soon as its frame is ready; the dashboard answers from `exchangeContext` (`appData.ts`), which `BridgeDialogs` fills only once the session and the selected company have loaded. A question that arrives first is refused as `unavailable`.
- **Risk:** none to data: nothing is read or written. It is a confusing screen on every reload until "Try again".
- **When to act:** before more people use the payroll app inside the dashboard. Either the dashboard holds such a question until the company has loaded (a few seconds at most), or the app asks once more by itself after a moment.
