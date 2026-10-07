// Proves that the tests can fail.
//
// A test that passes says little until you have seen it fail for the right reason. This script
// applies ONE small break to the source at a time, runs the test that is supposed to notice,
// and requires that test (by name) to fail. Then it puts the file back.
//
// Safety:
//  - It refuses to start unless `git status` is clean, so there is nothing of yours to lose.
//  - Each file is restored from memory in a `finally` block, and again if the script is
//    interrupted, so a crashed test run cannot leave a break behind.
//  - At the end it checks that `git status` is clean again, and fails if it is not.
//
// Run it with `npm run test:prove`. It uses nothing but Node and the project's own Vitest.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Each break: the file, the exact text to find (it must occur exactly once), what to put in its
 * place, the test file to run, and part of the name of the test that must fail.
 */
const BREAKS = [
  // ---------- "Employee CSG" / "Employee NSF" (HUB_CHANGES item 1) ----------
  {
    what: 'An absent figure is sent to apps as ""',
    file: "src/config/payrollFields.ts",
    find: "if (value !== undefined) out[field.jsonKey] = value;",
    replace: 'out[field.jsonKey] = value ?? "";',
    test: "src/config/apps.config.test.ts",
    mustFail: "leaves an absent figure out",
  },
  {
    what: "The storage names (employee_csg) leak into what apps receive",
    file: "src/config/payrollFields.ts",
    find: "if (!(key in out) && !RESERVED_EXTRA_KEYS.has(key)) out[key] = value;",
    replace: "if (!(key in out)) out[key] = value;",
    test: "src/config/apps.config.test.ts",
    mustFail: "never sends the storage names",
  },
  {
    what: "The two fields stop being sensitive",
    file: "src/config/payrollFields.ts",
    find: "  required: false,\n  sensitive: true,\n  inExtra: true,",
    replace: "  required: false,\n  sensitive: false,\n  inExtra: true,",
    test: "src/config/apps.config.test.ts",
    mustFail: "lists both as optional, sensitive numbers",
  },
  {
    what: "The two fields become required (older files would be refused)",
    file: "src/config/payrollFields.ts",
    find: "  required: false,\n  sensitive: true,\n  inExtra: true,",
    replace: "  required: true,\n  sensitive: true,\n  inExtra: true,",
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "treats them as absent, not as an error and not as 0, when the key is not there",
  },
  {
    what: "An absent figure is stored as 0 by the import",
    file: "src/features/import/parsePayroll.ts",
    find: "if (isBlank(value)) return undefined;",
    replace: "if (isBlank(value)) return 0;",
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: 'treats them as absent, not as an error and not as 0, when the value is ""',
  },
  {
    what: "Text in a figure is dropped quietly instead of being a row error",
    file: "src/features/import/parsePayroll.ts",
    find: "if (isBlank(value)) return undefined;\n  const checked = checkMoney(value);\n  if (!checked.ok) {",
    replace:
      'if (isBlank(value) || typeof value === "string") return undefined;\n  const checked = checkMoney(value);\n  if (!checked.ok) {',
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "refuses text, like the other money fields",
  },
  {
    what: "A figure with more than 2 decimals is rounded instead of refused",
    file: "src/features/import/parsePayroll.ts",
    find: "if (isBlank(value)) return undefined;\n  const checked = checkMoney(value);",
    replace:
      'if (isBlank(value)) return undefined;\n  const checked = checkMoney(typeof value === "number" ? Math.round(value * 100) / 100 : value);',
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "never rounds: more than 2 decimals is a row error",
  },
  {
    what: "The figures are stored under the file's names, not employee_csg / employee_nsf",
    file: "src/features/import/parsePayroll.ts",
    find: "if (field.inExtra) extra[field.column] = value;",
    replace: "if (field.inExtra) extra[field.jsonKey] = value;",
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "stores both inside extra under their column names",
  },
  {
    what: "An unknown field may use a reserved storage name",
    file: "src/features/import/parsePayroll.ts",
    find: 'else if (RESERVED_EXTRA_KEYS.has(key)) fail(key, "is a name the dashboard reserves");',
    replace: 'else if (key === "") fail(key, "is a name the dashboard reserves");',
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "refuses an unknown field that uses one of the reserved storage names",
  },
  {
    what: 'The wizard sends "" for a figure the row does not have',
    file: "src/features/transfer/mapping.ts",
    find: '      if (field.type === "number" && !field.required && isEmpty(value)) continue;\n',
    replace: "",
    test: "src/features/transfer/mapping.test.ts",
    mustFail: "leaves an empty optional number out of that row",
  },
  {
    what: "The grid shows an amount for a figure the run does not have",
    file: "src/components/PayrollTable.tsx",
    find: '      if (value === undefined) return "";\n',
    replace: "",
    test: "src/components/PayrollTable.test.tsx",
    mustFail: "shows nothing, not Rs 0.00",
  },
  {
    what: "The grid shows the storage name as an extra column",
    file: "src/components/PayrollTable.tsx",
    find: "    .filter((key) => !RESERVED_EXTRA_KEYS.has(key))\n",
    replace: "",
    test: "src/components/PayrollTable.test.tsx",
    mustFail: "shows each as one known column",
  },

  // ---------- payslip registry entry (HUB_CHANGES item 2) ----------
  {
    what: "The payslip URL loses its trailing slash",
    file: "src/config/apps.config.ts",
    find: "url: `${HOSTING.apps}/payslip/`,",
    replace: "url: `${HOSTING.apps}/payslip`,",
    test: "src/config/apps.config.test.ts",
    mustFail: "uses the exact app URLs, with trailing slashes",
  },
  {
    what: "The payslip app goes back to coming soon",
    file: "src/config/apps.config.ts",
    find: 'accentColor: "var(--warn)",\n    status: "active",',
    replace: 'accentColor: "var(--warn)",\n    status: "coming-soon",',
    test: "src/config/apps.config.test.ts",
    mustFail: "has unique ids, and every app is active",
  },

  // ---------- the baseline record ----------
  {
    what: "A value in the rows sent from a saved run changes",
    file: "src/config/payrollFields.ts",
    find: 'out[field.jsonKey] = row.age_60_plus ? "Yes" : "No";',
    replace: 'out[field.jsonKey] = row.age_60_plus ? "yes" : "no";',
    test: "src/features/workspace/baseline.test.tsx",
    mustFail: "baseline: the 2026-10 sample is sent like this to an app from a saved run",
  },
  {
    what: "What an import stores changes",
    file: "src/features/import/importPlan.ts",
    find: "    age_60_plus: row.age_60_plus,\n",
    replace: "    age_60_plus: !row.age_60_plus,\n",
    test: "src/features/workspace/baseline.test.tsx",
    mustFail: "baseline: the 2026-10 sample is stored like this by an import",
  },
  {
    what: 'The answer to "Get from dashboard" changes (the period it reports)',
    file: "src/features/workspace/BridgeDialogs.tsx",
    find: "meta: { period: run.period.slice(0, 7), label: current.company.name },",
    replace: "meta: { period: run.period, label: current.company.name },",
    test: "src/features/workspace/baseline.test.tsx",
    mustFail: "asks the user, then answers with the run's rows",
  },
];

const gitStatus = () =>
  spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim();

/** Runs the given test files and returns each test's full name and whether it passed. */
function runTests(files, reportDir) {
  const report = join(reportDir, "report.json");
  rmSync(report, { force: true });
  const run = spawnSync(
    process.execPath,
    ["scripts/vitest.mjs", "run", ...files, "--reporter=json", `--outputFile=${report}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  let tests = null;
  try {
    const parsed = JSON.parse(readFileSync(report, "utf8"));
    tests = parsed.testResults.flatMap((file) =>
      file.assertionResults.map((t) => ({ name: t.fullName, passed: t.status === "passed" })),
    );
  } catch {
    // No report: the run crashed before it could write one. Treated as "not proven".
  }
  return { exitCode: run.status, tests };
}

if (gitStatus() !== "") {
  console.error(
    "test:prove needs a clean git tree, so that it can show it left nothing behind.\nCommit or stash your changes first.",
  );
  process.exit(2);
}

const reportDir = mkdtempSync(join(tmpdir(), "payroll-hub-prove-"));

// Whatever happens, the file being broken right now is put back.
let restore = () => {};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}
process.on("exit", () => restore());

const rows = [];
let failed = false;

// The tests must pass before anything is broken, or a failure would prove nothing.
const testFiles = [...new Set(BREAKS.map((b) => b.test))];
const control = runTests(testFiles, reportDir);
if (control.exitCode !== 0 || !control.tests || control.tests.some((t) => !t.passed)) {
  console.error(
    "The tests do not pass as they are, so nothing can be proven. Run `npm test` first.",
  );
  process.exit(1);
}

for (const [index, item] of BREAKS.entries()) {
  const original = readFileSync(item.file, "utf8");
  let result;

  if (original.split(item.find).length !== 2) {
    result = "BREAK OUT OF DATE (text not found exactly once)";
  } else if (!control.tests.some((t) => t.name.includes(item.mustFail))) {
    result = "BREAK OUT OF DATE (no test with that name)";
  } else {
    restore = () => writeFileSync(item.file, original);
    try {
      writeFileSync(
        item.file,
        original.replace(item.find, () => item.replace),
      );
      const { tests } = runTests([item.test], reportDir);
      const target = tests?.filter((t) => t.name.includes(item.mustFail)) ?? [];
      if (!tests) result = "NOT PROVEN (the test run crashed)";
      else if (target.length === 0) result = "NOT PROVEN (the test did not run)";
      else if (target.every((t) => t.passed)) result = "NOT CAUGHT (the test still passes)";
      else result = "caught";
    } finally {
      restore();
      restore = () => {};
    }
    if (readFileSync(item.file, "utf8") !== original) result = "FILE NOT RESTORED";
  }

  if (result !== "caught") failed = true;
  rows.push({ n: index + 1, ...item, result });
  console.error(
    `${String(index + 1).padStart(2)}/${BREAKS.length}  ${result.padEnd(8)} ${item.what}`,
  );
}

rmSync(reportDir, { recursive: true, force: true });

const status = gitStatus();
const clean = status === "";

console.log("\n| # | Break applied | File | Test that must fail | Result |");
console.log("| - | - | - | - | - |");
for (const row of rows) {
  console.log(
    `| ${row.n} | ${row.what} | ${row.file.replace(/^src\//, "")} | ${row.mustFail} | ${row.result} |`,
  );
}
const caught = rows.filter((row) => row.result === "caught").length;
console.log(`\n${caught} of ${rows.length} breaks caught.`);
console.log(
  clean ? "git status: clean (every file was restored)." : `git status: NOT CLEAN\n${status}`,
);

process.exit(failed || !clean ? 1 : 0);
