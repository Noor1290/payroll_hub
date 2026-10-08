# Known issues (payroll-hub)

Issues in this repo only. The payroll app keeps its own list in `docs/KNOWN_ISSUES.md` in payroll_sys.

Status is one of: **open** (to fix), **watch** (not a fault today; look again if it gets worse), **fixed** (kept for the record).

## 1. A slow test in demoIssuedPayslips.test.ts (watch)

- **Where:** `src/lib/demo/demoIssuedPayslips.test.ts`, the test "issues a month at revision 1, then a re-issue at revision 2, and reads the latest of each".
- **What:** it takes about 3.5 s (3.4 s measured alone on 8 Oct 2026), against Vitest's default limit of 5 s per test. The four "refuses a month because of ..." tests in the same file take about 1.3 s each.
- **Why:** the demo store waits a short time on every call to look like a network, and this test makes about a dozen calls one after another. Nothing is wrong with what it checks.
- **Risk:** on a slow or busy machine it could pass the 5 s limit and fail for no real reason, as the PayrollTable tests did before `fix/test-timeouts`.
- **When to act:** if it fails with a timeout, or is seen above about 4 s. Then make the demo store's pause short under test. Do not raise the limit and do not cut what the test checks.
