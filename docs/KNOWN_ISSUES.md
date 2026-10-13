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
