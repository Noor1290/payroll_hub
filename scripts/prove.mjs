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
    find: "if (!(key in out) && !RESERVED_EXTRA_KEYS.has(key) && !isHubOwnedKey(key)) out[key] = value;",
    replace: "if (!(key in out) && !isHubOwnedKey(key)) out[key] = value;",
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
    find: '      const leaveOut = field.type === "number" || field.type === "date";\n',
    replace: '      const leaveOut = field.type === "date";\n',
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

  // ---------- Stage B: date of employment (HUB_CHANGES item 3) ----------
  {
    what: 'An employee without a date is sent "Date of Employment": ""',
    file: "src/config/payrollFields.ts",
    find: "if (isEmploymentDate(row.date_of_employment)) out[DATE_OF_EMPLOYMENT] = row.date_of_employment;",
    replace: 'out[DATE_OF_EMPLOYMENT] = row.date_of_employment ?? "";',
    test: "src/config/apps.config.test.ts",
    mustFail: "leaves the key out when the stored value is",
  },
  {
    what: "An import stores the date a file carries in the rows",
    file: "src/features/import/parsePayroll.ts",
    find: "        fileDate = value;",
    replace: "        fileDate = value;\n        extra[key] = value;",
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "is still never stored: not as the date, and not in extra",
  },
  {
    what: "The import no longer says that the date in a file is ignored",
    file: "src/features/import/parsePayroll.ts",
    find: "        dateOfEmploymentIgnored = true;\n        fileDate = value;",
    replace: "        fileDate = value;",
    test: "src/features/import/parsePayroll.test.ts",
    mustFail: "is reported as ignored when any row has it",
  },
  {
    // Rehearsal fix F6, and migration 0017: a sent date replaces a stored one only from the same or a newer month, and never one changed between the read and the save.
    what: "A saved file overwrites a date of employment that was set meanwhile",
    file: "src/lib/supabase/payroll.ts",
    find: "? update.is(\"date_of_employment\", null)",
    replace: "? update",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "fills an empty date; replaces one from an older month",
  },
  {
    what: "A date changed meanwhile is replaced unseen",
    file: "src/lib/supabase/payroll.ts",
    find: ": update.eq(\"date_of_employment\", employee.date_of_employment)",
    replace: ": update",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "fills an empty date; replaces one from an older month",
  },
  {
    what: "Where a date came from is not checked before it is replaced",
    file: "src/lib/supabase/payroll.ts",
    find: ": update.eq(\"date_of_employment_month\", month);",
    replace: ": update;",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "fills an empty date; replaces one from an older month",
  },
  {
    what: "Re-sending an older month overwrites a newer month's date of employment",
    file: "src/features/import/employmentDateRule.ts",
    find: "return newer || sentMonth === stored.month ? \"replace\" : \"keep-newer\";",
    replace: "return \"replace\";",
    test: "src/features/import/employmentDateRule.test.ts",
    mustFail: "is NOT replaced by an older month sent again",
  },
  {
    what: "The same month sent again, corrected, no longer replaces its date",
    file: "src/features/import/employmentDateRule.ts",
    find: "return newer || sentMonth === stored.month ? \"replace\" : \"keep-newer\";",
    replace: "return newer ? \"replace\" : \"keep-newer\";",
    test: "src/features/import/employmentDateRule.test.ts",
    mustFail: "is replaced by a different date sent for the same month",
  },
  {
    what: "A date typed in the Data explorer is replaced by a month that is not newer",
    file: "src/features/import/employmentDateRule.ts",
    find: "const newer = typedAgainst === null || sentMonth > typedAgainst;",
    replace: "const newer = typedAgainst === null || sentMonth >= typedAgainst;",
    test: "src/features/import/employmentDateRule.test.ts",
    mustFail: "is kept while the months sent are not newer",
  },
  {
    what: "A date stored before migration 0017 is not treated as typed",
    file: "src/features/import/employmentDateRule.ts",
    find: "const typedAgainst = stored.typed === true ? stored.month : newestBefore;",
    replace: "const typedAgainst = stored.month;",
    test: "src/features/import/employmentDateRule.test.ts",
    mustFail: "against the company's newest month saved before this import",
  },
  {
    what: "A date typed in the Data explorer is not recorded as typed",
    file: "src/lib/supabase/payroll.ts",
    find: "      date_of_employment_typed: true,",
    replace: "      date_of_employment_typed: false,",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "updates that one employee, recorded as typed",
  },
  {
    what: "The demo store does not follow the rule",
    file: "src/lib/demo/demoData.ts",
    find: "if (decision === \"keep-newer\") counts.keptNewer++;",
    replace: "if (decision === \"keep-newer\") counts.changed++;",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "in demo mode: a newer month overwrites",
  },
  {
    what: "Setting a date is no longer limited to that one employee",
    file: "src/lib/supabase/payroll.ts",
    find: '      .update(change)\n      .eq("id", employeeId)\n',
    replace: "      .update(change)\n",
    test: "src/lib/supabase/employeeDate.test.ts",
    mustFail: "updates that one employee, recorded as typed",
  },

  // ---------- Stage B: protocol and saves that take time (item 4) ----------
  {
    what: "Payroll results may be answered with no rows",
    file: "src/lib/bridge/protocol.ts",
    find: "sendBytes: null, answerRows: [1, MAX_ROWS] };",
    replace: "sendBytes: null, answerRows: [0, MAX_ROWS] };",
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "never sends payroll results with no rows",
  },
  {
    what: "A rates save may carry several rows",
    file: "src/lib/bridge/protocol.ts",
    find: '"statutory-rates": { sendRows: 1,',
    replace: '"statutory-rates": { sendRows: 10,',
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "refuses more than one row for a save",
  },
  {
    what: "A template message has no size limit at the hub",
    file: "src/lib/bridge/protocol.ts",
    find: '"payslip-template": { sendRows: 1, sendBytes: 160_000,',
    replace: '"payslip-template": { sendRows: 1, sendBytes: null,',
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "refuses a template message that is too large",
  },
  {
    what: "The hub answers a slow save after the app has given up (11 s)",
    file: "src/lib/bridge/hub.ts",
    find: "options.saveAnswerMs ?? 8_000;",
    replace: "options.saveAnswerMs ?? 11_000;",
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "answers by itself at 8 seconds",
  },
  {
    what: "The hub answers the same save twice",
    file: "src/lib/bridge/hub.ts",
    find: "            if (answered) return;\n",
    replace: "",
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "answers by itself at 8 seconds",
  },

  // ---------- Stage B: the transfer log (item 10) ----------
  {
    what: '"Get from dashboard" is no longer logged',
    file: "src/features/workspace/appData.ts",
    find: "answerRequest(appId, PAYROLL_RESULT, () => handleDataRequest(appId, payload)),",
    replace: "handleDataRequest(appId, payload),",
    test: "src/features/workspace/exchangeLog.test.ts",
    mustFail: "still wait for the user, and are logged when the user declines",
  },
  {
    what: "A value from the rows is written into the transfer log",
    file: "src/features/workspace/deliver.ts",
    find: "from: period ? `${DATABASE.name}, ${formatPeriod(`${period}-01`)}` : undefined,",
    replace: "from: JSON.stringify(response.rows[0]),",
    test: "src/features/workspace/exchangeLog.test.ts",
    mustFail: "never puts a value from the rows into the log",
  },

  // ---------- Stage B: statutory rates (items 5 and 6) ----------
  {
    what: "A save for another company's BRN is accepted",
    file: "src/features/workspace/appData.ts",
    find: "    if (!selected || normaliseBrn(selected) !== normaliseBrn(brn)) {",
    replace: "    if (!selected && normaliseBrn(String(selected)) !== normaliseBrn(brn)) {",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "refuses a save for another company, or with no BRN",
  },
  {
    what: "A rates save without a BRN is accepted",
    file: "src/features/workspace/appData.ts",
    find: "const ratesSaveSchema = z.strictObject({\n  brn: brnSchema,",
    replace: "const ratesSaveSchema = z.strictObject({\n  brn: brnSchema.optional(),",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "refuses a save for another company, or with no BRN",
  },
  {
    what: "A rate with too many decimals is passed on instead of refused",
    file: "src/features/workspace/appData.ts",
    find: "const rateSchema = z.number().min(0).max(100).refine(decimals(4));",
    replace: "const rateSchema = z.number().min(0).max(100);",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "refuses a rate with 5 decimals as invalid",
  },
  {
    what: "A field the dashboard does not know is let through in a rates save",
    file: "src/features/workspace/appData.ts",
    find: "const ratesSaveSchema = z.strictObject({",
    replace: "const ratesSaveSchema = z.object({",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "refuses a field it does not know as invalid",
  },
  {
    what: "A user id is sent with the rates",
    file: "src/features/workspace/appData.ts",
    find: "        created_by_you: created_by !== null && created_by === current.viewer.id,\n",
    replace:
      "        created_by_you: created_by !== null && created_by === current.viewer.id,\n        created_by,\n",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "answers with every version of the selected company",
  },
  {
    what: "A stale save is reported as something else",
    file: "src/features/workspace/appData.ts",
    find: 'if (text.includes("PH_STALE")) {',
    replace: 'if (text.includes("PH_STALE_")) {',
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "tells the app P0001 PH_STALE as code stale",
  },

  // ---------- Stage B: payslip templates (item 7) ----------
  {
    what: "The payslip app may no longer save templates",
    file: "src/config/apps.config.ts",
    find: "produces: [STATUTORY_RATES, PAYSLIP_TEMPLATE, PAYSLIP_ISSUE],",
    replace: "produces: [STATUTORY_RATES, PAYSLIP_ISSUE],",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "saves a draft, answers with the result, logs it and shows a toast",
  },
  {
    what: "The list of templates is read with their bodies",
    file: "src/lib/supabase/payslipTemplates.ts",
    find: 'const SUMMARY_COLUMNS = "id, name, draft_revision, updated_by, updated_at";',
    replace:
      'const SUMMARY_COLUMNS = "id, name, draft_revision, updated_by, updated_at, draft_body";',
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "lists the selected company's templates without bodies",
  },
  {
    what: "A draft is loaded without checking it belongs to the company",
    file: "src/lib/supabase/payslipTemplates.ts",
    find: '    .select(`${SUMMARY_COLUMNS}, draft_body`)\n    .eq("company_id", companyId)\n',
    replace: "    .select(`${SUMMARY_COLUMNS}, draft_body`)\n",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "returns the draft, body exactly as stored, when no version is named",
  },
  {
    what: "A body over 150 KB is sent on to the database",
    file: "src/features/workspace/appData.ts",
    find: "if (jsonBytes(row.data.body) > TEMPLATE_BODY_BYTES) {",
    replace: "if (jsonBytes(row.data.body) > TEMPLATE_BODY_BYTES * 2) {",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "refuses a body over 150 KB as too large",
  },
  {
    what: "A body with an image is saved",
    file: "src/features/workspace/appData.ts",
    find: "if (hasEmbeddedFile(row.data.body)) {",
    replace: "if (hasEmbeddedFile(row.data.name)) {",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "refuses a body with a logo as a data URI",
  },
  {
    what: "An image nested inside a template line is missed",
    file: "src/features/workspace/appData.ts",
    find: "      for (const inner of value as unknown[]) pending.push(inner);\n",
    replace: "",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "refuses a body with an image deep inside a line",
  },
  {
    what: "A viewer may save or publish a template",
    file: "src/features/workspace/appData.ts",
    find: '  if (current.membership.role !== "admin") {\n    return refuse("forbidden", "Only an admin of this company can save or publish a template.");\n  }\n',
    replace: "",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "refuses a viewer, and another company, before reaching the database",
  },
  {
    what: 'A "delete" action is accepted for a template',
    file: "src/features/workspace/appData.ts",
    find: 'action: z.literal("publish"),',
    replace: 'action: z.enum(["publish", "delete"]),',
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "refuses an action it does not know: there is no delete or archive",
  },
  {
    what: "The company's BRN is left out of an answer",
    file: "src/features/workspace/appData.ts",
    find: "  ...(company.brn ? { brn: company.brn } : {}),\n",
    replace: "",
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "answers a load straight away while the gate is locked",
  },
  {
    what: "The answer to a template request changes (the baseline record)",
    file: "src/features/workspace/appData.ts",
    find: "const params = templateParamsSchema.safeParse(payload.params ?? {});",
    replace: 'const params = templateParamsSchema.safeParse(payload.params ?? { action: "list" });',
    test: "src/features/workspace/baselineBridge.test.ts",
    mustFail: "the payslip app asks for a payslip template",
  },

  // ---------- Stage B: delete company (item 9) ----------
  {
    what: "The delete preview stops counting payslip templates",
    file: "src/features/company/deleteCompany.ts",
    find: 'db.from("payslip_templates").select("id", head)',
    replace: 'db.from("company_links").select("id", head)',
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "is counted, table by table, in the preview",
  },
  {
    what: "A missing rates table breaks the delete preview",
    file: "src/features/company/deleteCompany.ts",
    find: "    rates: optional(rates),\n",
    replace: "    rates: count.parse(rates.count),\n",
    test: "src/features/company/deleteCompany.test.ts",
    mustFail: "missing tables count as nothing",
  },
  {
    what: "The delete dialog hides the payslip templates that will go",
    file: "src/features/company/DeleteCompanySection.tsx",
    find: "{preview.templates > 0 && (",
    replace: "{preview.templates > 99 && (",
    test: "src/features/company/DeleteCompanySection.test.tsx",
    mustFail: "shows the statutory rates, payslip templates and issued payslips that go with it",
  },

  // ---------- Stage C: issued payslips (item 8) ----------
  {
    what: "A refused month no longer says which payslip was at fault",
    file: "src/features/workspace/appData.ts",
    find: "  return found ? { ...refusal, index: Number(found[1]) - 1 } : refusal;",
    replace: "  return refusal;",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "tells the app which payslip the database refused",
  },
  {
    what: "The position of the refused payslip is counted from 1 instead of 0",
    file: "src/features/workspace/appData.ts",
    find: "index: Number(found[1]) - 1 }",
    replace: "index: Number(found[1]) }",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "tells the app which payslip the database refused",
  },
  {
    what: "A payslip the dashboard itself finds invalid is not pointed at",
    file: "src/features/workspace/appData.ts",
    find: "? at(refusal, index) : refusal;",
    replace: "? refusal : refusal;",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "because of a field it does not know in one payslip",
  },
  {
    what: "A user id is sent with issued payslips",
    file: "src/features/workspace/appData.ts",
    find: "        issued_by_you: issued_by !== null && issued_by === viewer.id,\n",
    replace:
      "        issued_by_you: issued_by !== null && issued_by === viewer.id,\n        issued_by,\n",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "never sends a user id with issued payslips",
  },
  {
    what: "A month is issued while the password gate is locked",
    file: "src/features/workspace/appData.ts",
    find: "  if (!isUnlocked()) return SAVE_LOCKED;\n",
    replace: "",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "refuses at once while the password gate is locked",
  },
  {
    what: "Issued payslips are read while the password gate is locked",
    file: "src/features/workspace/appData.ts",
    find: '  if ("ok" in current) return current;\n  if (!isUnlocked()) return READ_LOCKED;\n\n  const { viewer, membership } = current;',
    replace: '  if ("ok" in current) return current;\n\n  const { viewer, membership } = current;',
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "sends nothing when the gate is locked at the moment the user's answer is acted on",
  },
  {
    what: "Issued payslips are sent without asking the user, once the gate is open",
    file: "src/features/workspace/appData.ts",
    find: "  return handleDataRequest(appId, payload, {\n    what: `the payslips issued for",
    replace:
      "  if (isUnlocked()) return loadIssued(brn, period);\n  return handleDataRequest(appId, payload, {\n    what: `the payslips issued for",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "waits for the user, reading nothing until they agree",
  },
  {
    what: "The company and the role are not checked again when the user agrees",
    file: "src/features/workspace/appData.ts",
    find: '  const current = adminContext(brn);\n  if ("ok" in current) return current;\n  if (!isUnlocked()) return READ_LOCKED;',
    replace:
      "  const current = exchangeContext.get();\n  if (!current) return READ_LOCKED;\n  if (!isUnlocked()) return READ_LOCKED;",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "checks the company and the role again when the user agrees",
  },
  {
    what: "A viewer may read and issue payslips",
    file: "src/features/workspace/appData.ts",
    find: '  if (current.membership.role !== "admin") {\n    return refuse("forbidden", "Only an admin of this company can read or issue payslips.");\n  }\n',
    replace: "",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "refuses a viewer, another company and a missing BRN before reaching the database",
  },
  {
    what: "Issued payslips can be asked for without a BRN",
    file: "src/features/workspace/appData.ts",
    find: "  /** Required here, unlike rates and templates: this is per-employee data. */\n  brn: brnSchema,",
    replace:
      "  /** Required here, unlike rates and templates: this is per-employee data. */\n  brn: brnSchema.optional(),",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "refuses no BRN (required here) as invalid without asking the user",
  },
  {
    what: "A payslip may set its own revision, issuer or time",
    file: "src/features/workspace/appData.ts",
    find: "const payslipSchema = z.strictObject({",
    replace: "const payslipSchema = z.object({",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "because of a revision chosen by the app in one payslip",
  },
  {
    what: "A payslip over 16 KB is sent on to the database",
    file: "src/features/workspace/appData.ts",
    find: "if (jsonBytes(payslip) > PAYSLIP_BYTES) {",
    replace: "if (jsonBytes(payslip) > PAYSLIP_BYTES * 10) {",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "refuses a payslip over 16 KB as too large",
  },
  {
    what: "A payslip with an image in a line is issued",
    file: "src/features/workspace/appData.ts",
    find: "if (hasEmbeddedFile(payslip)) {",
    replace: "if (hasEmbeddedFile(payslip.national_id)) {",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "refuses a payslip with an image in a line",
  },
  {
    what: "The log says one row for an issued month, whatever its size",
    file: "src/features/workspace/deliver.ts",
    find: "rowCount: count(ack.result ?? {}) });",
    replace: "rowCount: 1 });",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail:
      "issues a month sent by the app, answers with the result, and logs a count without values",
  },
  {
    what: "National IDs from a save's result are shown in a toast",
    file: "src/features/workspace/deliver.ts",
    find: "toast.success(describe(ack.result ?? {}), { description: `Saved from ${name}.` });",
    replace:
      "toast.success(describe(ack.result ?? {}), { description: JSON.stringify(ack.result) });",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail:
      "issues a month sent by the app, answers with the result, and logs a count without values",
  },
  {
    what: "Locking no longer wipes issued payslips (the query key is not gated)",
    file: "src/lib/queryClient.ts",
    find: "  [ISSUED_PAYSLIPS_KEY],\n",
    replace: "",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "keeps nothing in memory once the app has its answer",
  },
  {
    what: "Issued payslips stay in memory after the app has its answer",
    file: "src/features/workspace/appData.ts",
    find: "    queryClient.removeQueries({ queryKey });\n",
    replace: "",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "keeps nothing in memory once the app has its answer",
  },
  {
    what: "Issued payslips become available to another app",
    file: "src/config/apps.config.ts",
    find: "    accepts: [PAYROLL_RESULT, PDF_TEMPLATE, PDF_FILE],",
    replace: "    accepts: [PAYROLL_RESULT, PDF_TEMPLATE, PDF_FILE, PAYSLIP_ISSUE],",
    test: "src/features/workspace/appDataIssue.test.tsx",
    mustFail: "is registered for the payslip app only",
  },
  {
    what: "A month of payslips has no size limit at the hub",
    file: "src/lib/bridge/protocol.ts",
    find: '"payslip-issue": { sendRows: 1, sendBytes: 4_000_000,',
    replace: '"payslip-issue": { sendRows: 1, sendBytes: null,',
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "takes a month of payslips as ONE row of at most 4 MB",
  },
  {
    what: "The answer to a request for issued payslips changes (the baseline record)",
    file: "src/features/workspace/appData.ts",
    find: "const params = issuedParamsSchema.safeParse(payload.params ?? {});",
    replace: 'const params = issuedParamsSchema.safeParse(payload.params ?? { action: "load" });',
    test: "src/features/workspace/baselineBridge.test.ts",
    mustFail: "the payslip app asks for issued payslips",
  },

  // ---------- Stage C: the user's role in meta ----------
  {
    what: "The user's role is left out of an answer",
    file: "src/features/workspace/appData.ts",
    find: '  role: role === "admin" ? ("admin" as const) : ("member" as const),\n',
    replace: "",
    test: "src/features/workspace/appDataRates.test.ts",
    mustFail: "says in meta whether the user is an admin or a member",
  },
  {
    what: 'A viewer is told the database\'s word "viewer" instead of "member"',
    file: "src/features/workspace/appData.ts",
    find: '  role: role === "admin" ? ("admin" as const) : ("member" as const),\n',
    replace: '  role: role as "admin",\n',
    test: "src/features/workspace/appDataTemplates.test.ts",
    mustFail: "says in meta whether the user is an admin or a member",
  },
  {
    what: "The protocol accepts any text as a role",
    file: "src/lib/bridge/protocol.ts",
    find: 'role: z.enum(["admin", "member"]).optional(),',
    replace: "role: z.string().optional(),",
    test: "src/lib/bridge/hubSaves.test.ts",
    mustFail: "carry the user's role in an answer's meta",
  },

  // ---------- Stage C: migration 0011, in a real Postgres ----------
  {
    what: "Any member of the company can read issued payslips",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "  using (public.is_company_admin(company_id));",
    replace: "  using (public.is_company_member(company_id));",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail: "lets only an admin of the company see the rows",
  },
  {
    what: "The same month can be issued twice (no check of the revision last seen)",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "    if v_latest <> v_expected then\n      raise exception 'PH_STALE: payslip %', v_n using errcode = 'P0001';\n    end if;\n",
    replace: "",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail:
      "refuses the same save arriving twice (its first answer was lost): no second revision",
  },
  {
    what: "The database no longer says which payslip is behind",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "raise exception 'PH_STALE: payslip %', v_n using errcode = 'P0001';",
    replace: "raise exception 'PH_STALE' using errcode = 'P0001';",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail: "stores nothing for anyone when one employee of the month is behind",
  },
  {
    what: "The database names the employee (national ID) in a refusal",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "raise exception 'PH_UNKNOWN_EMPLOYEE: payslip %', v_n using errcode = 'P0002';",
    replace:
      "raise exception 'PH_UNKNOWN_EMPLOYEE: payslip % (%)', v_n, v_national_id using errcode = 'P0002';",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail: "because of someone who is not an employee here",
  },
  {
    what: "A soft-deleted employee can be issued a payslip",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "      and e.national_id = v_national_id\n      and e.deleted_at is null;",
    replace: "      and e.national_id = v_national_id;",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail: "because of a soft-deleted employee",
  },
  {
    what: "Another company's template is not checked by the function",
    file: "supabase/migrations/0011_issued_payslips.sql",
    find: "      where v.company_id = p_company_id\n        and v.template_id = v_template",
    replace: "      where v.template_id = v_template",
    test: "src/features/workspace/payslipMigrations.db.test.ts",
    mustFail: "refuses another company's template, and names the payslip",
  },
  {
    what: "delete_company forgets the issued payslips",
    // The newest definition is the one that counts (0018 since multi-company publishing).
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "  delete from public.issued_payslips p where p.company_id = p_company_id;\n",
    replace: "",
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "deletes from every table that belongs to a company, then the company",
  },

  // ---------- Stage C: delete company ----------
  {
    what: "The delete preview stops counting issued payslips",
    file: "src/features/company/deleteCompany.ts",
    find: 'db.from("issued_payslips").select("id", head)',
    replace: 'db.from("company_links").select("id", head)',
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "is counted, table by table, in the preview",
  },
  {
    what: "The dashboard names an old migration when delete_company is missing",
    file: "src/features/company/deleteCompany.ts",
    find: 'const MIGRATION = "0018_payslip_template_in_use.sql";',
    replace: 'const MIGRATION = "0014_payroll_months.sql";',
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "is defined last in 0018, the file the dashboard names",
  },
  {
    what: "The delete dialog hides the issued payslips that will go",
    file: "src/features/company/DeleteCompanySection.tsx",
    find: "{preview.issuedPayslips > 0 && <li>",
    replace: "{preview.issuedPayslips > 99 && <li>",
    test: "src/features/company/DeleteCompanySection.test.tsx",
    mustFail: "shows the statutory rates, payslip templates and issued payslips that go with it",
  },
  // ---------- Database page: the payslip tables ----------
  {
    what: "The Database page shows issued lines unmasked",
    file: "src/lib/supabase/database.ts",
    find: '{ key: "lines", kind: "list", sensitive: true },',
    replace: '{ key: "lines", kind: "list" },',
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "masks issued lines, rates and accepted differences",
  },
  {
    what: "The Database page shows an issued payslip's rates snapshot unmasked",
    file: "src/lib/supabase/database.ts",
    find: '{ key: "rates_snapshot", kind: "json", nullable: true, sensitive: true },',
    replace: '{ key: "rates_snapshot", kind: "json", nullable: true },',
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "masks issued lines, rates and accepted differences",
  },
  {
    what: "The Database page shows a template body unmasked",
    file: "src/lib/supabase/database.ts",
    find: '{ key: "draft_body", kind: "json", sensitive: true },',
    replace: '{ key: "draft_body", kind: "json" },',
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "shows a template body masked, then collapsed",
  },
  {
    what: "A revealed JSON cell shows the whole value instead of one short line",
    file: "src/features/database/view.ts",
    find: "return json.length > 48 ? `${json.slice(0, 47)}…` : json;",
    replace: "return json;",
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "shows a template body masked, then collapsed",
  },
  {
    what: "The payslip tables show a shortened user id instead of You / Another admin",
    file: "src/lib/supabase/database.ts",
    find: "values[column.key] = values[column.key] === viewerId ? ACTOR_YOU : ACTOR_OTHER;",
    replace: "values[column.key] = shortId(String(values[column.key]));",
    test: "src/lib/supabase/database.test.ts",
    mustFail: "says You or Another admin in the payslip tables, and keeps no user id",
  },
  {
    what: 'Every row in the payslip tables says "You"',
    file: "src/lib/supabase/database.ts",
    find: "values[column.key] = values[column.key] === viewerId ? ACTOR_YOU : ACTOR_OTHER;",
    replace: "values[column.key] = ACTOR_YOU;",
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "says You or Another admin, and never shows a user id",
  },
  {
    what: "The payslip tables can be sorted by who did it",
    file: "src/lib/supabase/database.ts",
    find: 'column.kind !== "json" && column.kind !== "list" && column.kind !== "actor";',
    replace: 'column.kind !== "json" && column.kind !== "list";',
    test: "src/lib/supabase/database.test.ts",
    mustFail: "never sorts the payslip tables by who did it or by a JSON column",
  },
  {
    what: "Issued payslips are counted for someone who is not an admin",
    file: "src/lib/supabase/database.ts",
    find: "      if (table.adminOnly && !isAdmin) return [name, null] as const;\n",
    replace: "",
    test: "src/lib/supabase/database.test.ts",
    mustFail: "does not even count an admin-only table for someone who is not an admin",
  },
  {
    what: "The issued payslips tab reads rows for someone who is not an admin",
    file: "src/features/database/DatabasePage.tsx",
    find: "!isAdmin && !!DB_TABLES[name].adminOnly;",
    replace: "false && !isAdmin && !!DB_TABLES[name].adminOnly;",
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "tells someone who is not an admin that issued payslips are for admins only",
  },
  {
    what: "A search that cannot match issued payslips reads the whole table instead",
    file: "src/lib/supabase/database.ts",
    find: "  if (searchCannotMatch(table, query.search)) return { rows: [], total: 0 };\n",
    replace: "",
    test: "src/lib/supabase/database.test.ts",
    mustFail: "finds a month in the payslip tables, and asks nothing when a search cannot match",
  },

  // ---------- Migration plan, step 0c: activity inside an app, and the gate ----------
  {
    what: "Work inside an app's frame no longer reaches the dashboard's activity signal",
    file: "src/lib/bridge/bridge.ts",
    find: "  onActivity: () => reportActivity(),\n",
    replace: "",
    test: "src/lib/bridge/activity.test.ts",
    mustFail: "a click and a key every 3 seconds inside an app's frame: still signed in",
  },
  {
    what: "The idle sign-out stops listening to the shared activity signal",
    file: "src/lib/idle.ts",
    find: "  const stopListening = onActivity(markActive);",
    replace: "  const stopListening = onActivity(() => {});",
    test: "src/lib/bridge/activity.test.ts",
    mustFail: "a key pressed in the dashboard itself every 3 seconds: still signed in",
  },
  {
    what: "The hub drops the activity message",
    file: "src/lib/bridge/hub.ts",
    find: "        this.handlers.onActivity?.(state.app.id);\n",
    replace: "",
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "is passed on from the app that is showing, and gets no reply",
  },
  {
    what: "Every activity message counts, however many an app sends",
    file: "src/lib/bridge/hub.ts",
    find: "        if (since !== null && since >= 0 && since < this.activityEveryMs) return;\n",
    replace: "",
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "counts 100 messages in one second once",
  },
  {
    what: "A clock set back silences an app until it catches up",
    file: "src/lib/bridge/hub.ts",
    find: "if (since !== null && since >= 0 && since < this.activityEveryMs) return;",
    replace: "if (since !== null && since < this.activityEveryMs) return;",
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "an hour's step back does not silence it for an hour",
  },
  {
    what: "Activity counts from an app whose frame is not showing",
    file: "src/lib/bridge/hub.ts",
    find: 'if (!state.shown || document.visibilityState !== "visible") return;',
    replace: 'if (document.visibilityState !== "visible") return;',
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "is ignored from an app whose frame is not showing",
  },
  {
    what: "Activity counts while the dashboard's tab is hidden",
    file: "src/lib/bridge/hub.ts",
    find: 'if (!state.shown || document.visibilityState !== "visible") return;',
    replace: "if (!state.shown) return;",
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "is ignored while the dashboard's tab is hidden",
  },
  {
    what: "An app taken out of the workspace still counts as showing",
    file: "src/lib/bridge/hub.ts",
    find: "    state.shown = false;\n    state.activityAt = null;\n",
    replace: "    state.activityAt = null;\n",
    test: "src/lib/bridge/hub.test.ts",
    mustFail: "stops counting when the frame is taken away, until it is shown again",
  },
  {
    what: "bridge.js does not report activity",
    file: "docs/bridge.js",
    find: '    post("activity", {});\n',
    replace: "",
    test: "src/lib/bridge/appBridge.test.ts",
    mustFail: "tells the dashboard when the user clicks, types, scrolls or touches",
  },
  {
    what: "bridge.js reports every key and click",
    file: "docs/bridge.js",
    find: "    if (wait <= 0) sendActivity();\n    else activityTimer",
    replace: "    if (wait <= 30000) sendActivity();\n    else activityTimer",
    test: "src/lib/bridge/appBridge.test.ts",
    mustFail: "sends at most one every 30 seconds, however much is typed",
  },
  {
    what: "bridge.js drops what was done between two reports",
    file: "docs/bridge.js",
    find: "    else activityTimer = setTimeout(sendActivity, Math.min(wait, ACTIVITY_EVERY_MS));\n",
    replace: "",
    test: "src/lib/bridge/appBridge.test.ts",
    mustFail: "reports the last thing done, when its turn comes, and then goes quiet",
  },
  {
    what: "The password gate goes back to a fixed time after unlocking",
    file: "src/lib/unlock.ts",
    find: "  if (stopListening === null) stopListening = onActivity(extend);\n",
    replace: "",
    test: "src/lib/unlock.test.ts",
    mustFail: "counts from the last activity, not from unlocking",
  },
  {
    what: "The gate, fixed again, locks under someone typing in an app",
    file: "src/lib/unlock.ts",
    find: "  if (stopListening === null) stopListening = onActivity(extend);\n",
    replace: "",
    test: "src/lib/bridge/activity.test.ts",
    mustFail: "stays open while someone types in an app, far past 10 minutes after unlocking",
  },
  {
    what: "Activity after the deadline reopens the gate",
    file: "src/lib/unlock.ts",
    find: "  enforce();\n  const { unlocked, expiresAt } = unlockState.get();\n  if (!unlocked || expiresAt === null) return;\n  const next",
    replace:
      "  const { expiresAt } = unlockState.get();\n  if (expiresAt === null) return;\n  const next",
    test: "src/lib/unlock.test.ts",
    mustFail: "is not reopened by activity that comes after the deadline",
  },
  {
    what: "The gate redraws its screens on every key",
    file: "src/lib/unlock.ts",
    find: "  if (next - expiresAt < EXTEND_EVERY_MS) return;\n",
    replace: "",
    test: "src/lib/unlock.test.ts",
    mustFail: "the deadline moves once a second at most",
  },

  // ---------- Phase 2: the payroll column setup (migration 0013, payroll-setup) ----------
  {
    what: "An admin of ANY attached company may change the shared setup",
    file: "supabase/migrations/0013_payroll_setups.sql",
    find: "      then not exists (\n        select 1\n        from public.payroll_company_setups cs\n        where cs.shared_setup_id = p_setup_id\n          and not exists (",
    replace:
      "      then exists (\n        select 1\n        from public.payroll_company_setups cs\n        where cs.shared_setup_id = p_setup_id\n          and exists (",
    test: "src/features/workspace/payrollSetups.db.test.ts",
    mustFail: "an admin of some but not all attached companies can read it, and cannot change it",
  },
  {
    what: "A save of the shared setup with an old revision overwrites",
    file: "supabase/migrations/0016_shared_setup_needs_admin.sql",
    find: "    if v_setup.revision <> p_expected_revision then\n      raise exception 'PH_STALE' using errcode = 'P0001';\n    end if;\n\n    update public.payroll_shared_setups s",
    replace: "    update public.payroll_shared_setups s",
    test: "src/features/workspace/payrollSetups.db.test.ts",
    mustFail: "refuses a save of the shared setup that carries an old revision",
  },
  {
    what: "A company setup saved with the shared setup skips its revision check",
    file: "supabase/migrations/0016_shared_setup_needs_admin.sql",
    find: "      if v_company.revision <> (v_item ->> 'expected_revision')::integer then\n        raise exception 'PH_STALE' using errcode = 'P0001';\n      end if;\n",
    replace: "",
    test: "src/features/workspace/payrollSetups.db.test.ts",
    mustFail: "saves company setups with the shared setup all or nothing",
  },
  {
    what: "delete_company leaves the company's payroll setup behind",
    // The newest definition is the one that counts (0018 since multi-company publishing).
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "  delete from public.payroll_company_setups cs where cs.company_id = p_company_id;\n  get diagnostics v_setups = row_count;\n",
    replace: "  v_setups := 0;\n",
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "deletes from every table that belongs to a company",
  },
  {
    what: "The dashboard forwards a setup body over 250 KB",
    file: "src/features/workspace/payrollSetupData.ts",
    find: "            (b) => jsonBytes(b) > SETUP_BODY_BYTES,\n",
    replace: "            (b) => jsonBytes(b) > SETUP_BODY_BYTES * 2,\n",
    test: "src/features/workspace/payrollSetupData.test.ts",
    mustFail: "refuses a body over 250 KB",
  },
  {
    what: "The import is offered companies the user only views",
    file: "src/features/workspace/payrollSetupData.ts",
    find: '(m) => m.role === "admin" && m.company.brn,',
    replace: "(m) => Boolean(m.company.brn),",
    test: "src/features/workspace/payrollSetupData.test.ts",
    mustFail: "lists only the companies the user is an admin of",
  },
  {
    what: "The app is told it may change Global columns it may not",
    file: "src/features/workspace/payrollSetupData.ts",
    find: "            can_change: access.can_change,",
    replace: "            can_change: true,",
    test: "src/features/workspace/payrollSetupData.test.ts",
    mustFail: "an admin of some but not all attached companies cannot change the shared setup",
  },

  // ---------- Phase 3: the payroll months (migration 0014, payroll-month) ----------
  {
    what: "A viewer of the company can read its months",
    file: "supabase/migrations/0014_payroll_months.sql",
    find: 'create policy "payroll_months_select" on public.payroll_months\n  for select to authenticated\n  using (public.is_company_admin(company_id));',
    replace:
      'create policy "payroll_months_select" on public.payroll_months\n  for select to authenticated\n  using (public.is_company_member(company_id));',
    test: "src/features/workspace/payrollMonths.db.test.ts",
    mustFail: "a viewer of the company sees nothing at all",
  },
  {
    what: "A month saved with an old revision overwrites",
    file: "supabase/migrations/0014_payroll_months.sql",
    find: "    if v_month.revision <> p_expected_revision then\n      raise exception 'PH_STALE' using errcode = 'P0001';\n    end if;\n\n    -- What is about to be replaced",
    replace: "    -- What is about to be replaced",
    test: "src/features/workspace/payrollMonths.db.test.ts",
    mustFail: "refuses an old revision",
  },
  {
    what: "What another admin saved is lost when someone saves over it",
    file: "supabase/migrations/0014_payroll_months.sql",
    find: "       and (coalesce(p_keep_previous, false)\n            or v_month.updated_by is distinct from v_user\n",
    replace: "       and (coalesce(p_keep_previous, false)\n",
    test: "src/features/workspace/payrollMonths.db.test.ts",
    mustFail: "what someone else saved, when another admin saves over it",
  },
  {
    what: "A Global key moves the values in one company only",
    file: "supabase/migrations/0014_payroll_months.sql",
    find: "      from public.payroll_company_setups cs\n      where cs.shared_setup_id = v_setup_id;\n    end if;",
    replace:
      "      from public.payroll_company_setups cs\n      where cs.shared_setup_id = v_setup_id\n        and cs.company_id = (select min(o.company_id) from public.payroll_company_setups o where o.shared_setup_id = v_setup_id);\n    end if;",
    test: "src/features/workspace/payrollMonths.db.test.ts",
    mustFail: "the values move in every month of every attached company",
  },
  {
    what: "delete_company leaves the company's months behind",
    // The newest definition is the one that counts (0018 since multi-company publishing).
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "  delete from public.payroll_months pm where pm.company_id = p_company_id;\n  get diagnostics v_months = row_count;\n",
    replace: "  v_months := 0;\n",
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "deletes from every table that belongs to a company",
  },
  {
    what: "The dashboard reads months while its password gate is locked",
    file: "src/features/workspace/payrollMonthData.ts",
    find: "  if (!isUnlocked()) return READ_LOCKED;\n\n  try {",
    replace: "  try {",
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "refuses every read and every save at once as locked",
  },
  {
    what: "A viewer is answered months",
    file: "src/features/workspace/payrollMonthData.ts",
    find: '  if (command.action === "gate") return answer([{ unlocked: isUnlocked() }]);\n  if (membership.role !== "admin") return notAdmin(membership.company.name);',
    replace: '  if (command.action === "gate") return answer([{ unlocked: isUnlocked() }]);',
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "a viewer is refused everything but 'gate'",
  },
  {
    what: "Every saved month shows a toast",
    file: "src/features/workspace/payrollMonthData.ts",
    find: '  return row?.action === "save" && row.restored_from === undefined;',
    replace: "  return false;",
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "no toast for a saved month",
  },
  {
    what: "The app is told about the gate on every tick, not only when it opens or locks",
    file: "src/features/workspace/payrollMonthData.ts",
    find: "  if (unlocked === toldUnlocked) return;\n",
    replace: "",
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "only when that changes",
  },
  {
    what: "The unlock prompt waits for a Send instead of answering once unlocked",
    file: "src/features/workspace/BridgeDialogs.tsx",
    find: "    if (!unlockOnly || !unlocked || answered.current || !user || !current) return;\n",
    replace: "    return;\n",
    test: "src/features/workspace/payrollMonthUnlock.test.tsx",
    mustFail: "asks only for the password",
  },
  {
    what: "An app that asks before the dashboard knows who is signed in is refused at once (known issue 4)",
    file: "src/features/workspace/deliver.ts",
    find: "    if (signingIn) await signingIn;\n    response = await answer();",
    replace: "    response = await answer();",
    test: "src/features/workspace/signInWait.test.ts",
    mustFail: "the question waits for the sign-in and is answered, not refused",
  },

  // ---------- Phase 3 follow-ups: history and restore, Database page tabs ----------
  {
    what: "A month revision whose content was not kept is answered with the month as it is now",
    file: "src/lib/demo/demoPayrollMonths.ts",
    find: "    record.employees ?? (month && month.revision === revision ? month.employees : null);",
    replace: "    record.employees ?? month?.employees ?? null;",
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "a revision whose content was not kept",
  },
  {
    what: "A restored month is saved quietly, with no toast",
    file: "src/features/workspace/payrollMonthData.ts",
    find: '  return row?.action === "save" && row.restored_from === undefined;',
    replace: '  return row?.action === "save";',
    test: "src/features/workspace/payrollMonthData.test.ts",
    mustFail: "a restore is a save naming the revision it restores",
  },
  {
    what: "The Database page shows a month's employees unmasked",
    file: "src/lib/supabase/database.ts",
    find: '      { key: "employees", kind: "list", sensitive: true },',
    replace: '      { key: "employees", kind: "list" },',
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "mask every month's salaries and national IDs by default",
  },
  {
    what: "The month tables are read for someone who is not an admin",
    file: "src/lib/supabase/database.ts",
    find: '    adminOnly: true,\n    canBeDeleted: false,\n    defaultSort: { column: "period", ascending: false },',
    replace: '    canBeDeleted: false,\n    defaultSort: { column: "period", ascending: false },',
    test: "src/features/database/DatabasePage.test.tsx",
    mustFail: "are for admins only: someone else is told so",
  },
  {
    what: "The shared setup tabs read every shared setup, not the selected company's",
    file: "src/lib/supabase/database.ts",
    find: "      return query.eq(SHARED_SETUP_JOIN[table.name].company, companyId);",
    replace: "      return query;",
    test: "src/lib/supabase/database.test.ts",
    mustFail: "the shared setup through the company attached to it",
  },

  // ---------- safety checks against the live project (src/safety) ----------
  {
    what: "The non-member check passes a read that returned rows",
    file: "src/safety/outcome.ts",
    find: "  if (rows > 0 || (result.count ?? 0) > 0) {",
    replace: "  if (false) {",
    test: "src/safety/outcome.test.ts",
    mustFail: "fails when any row comes back",
  },
  {
    what: "A table drops out of the non-member check",
    file: "src/safety/nonmemberChecks.ts",
    find: "  payroll_month_history: {",
    replace: "  payroll_month_history_old: {",
    test: "src/safety/nonmemberChecks.test.ts",
    mustFail: "tries every table the migrations create",
  },
  {
    what: "A write attempt is aimed at a company that is not a TEST company",
    file: "src/safety/nonmemberChecks.ts",
    find: "args: (t) => ({ p_from_company_id: t.b,",
    replace: 'args: (t) => ({ p_from_company_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",',
    test: "src/safety/nonmemberChecks.test.ts",
    mustFail: "aims every write at the two TEST companies",
  },
  {
    what: "The keep-awake job counts any answer as the database answering",
    file: "src/safety/keepAwake.ts",
    find: '  if (status === 200 && text === "true") return { ok: true, reason: "the database answered" };',
    replace: '  if (status < 600) return { ok: true, reason: "the database answered" };',
    test: "src/safety/keepAwake.test.ts",
    mustFail: "is OK only for HTTP 200 answering true",
  },
  {
    what: "The 60-day warning is skipped when the database request failed",
    file: ".github/workflows/keep-awake.yml",
    find: "        if: always()",
    replace: "        if: success()",
    test: "src/safety/keepAwake.test.ts",
    mustFail: "checks the 60-day rule even when the database request failed",
  },
  {
    what: "Migration 0015 forgets to open keep_awake() to anon",
    file: "supabase/migrations/0015_keep_awake.sql",
    find: "grant execute on function public.keep_awake() to anon, authenticated;",
    replace: "grant execute on function public.keep_awake() to authenticated;",
    test: "src/safety/safetyMigrations.db.test.ts",
    mustFail: "answers true to the anon key and to a signed-in user",
  },
  {
    what: "Migration 0016 checks the input before who may create a setup",
    file: "supabase/migrations/0016_shared_setup_needs_admin.sql",
    find: "  if p_expected_revision = 0 and not exists (",
    replace: "  if false and not exists (",
    test: "src/safety/safetyMigrations.db.test.ts",
    mustFail: "refuses before looking at the input",
  },
  {
    what: "The non-member check tries to create a shared setup with a valid name (it could be stored)",
    file: "src/safety/nonmemberChecks.ts",
    find: 'args: () => ({ p_setup_id: SAFETY_SETUP_ID, p_name: "",',
    replace: 'args: () => ({ p_setup_id: SAFETY_SETUP_ID, p_name: "SAFETY CHECK",',
    test: "src/safety/nonmemberChecks.test.ts",
    mustFail: "asks for a new shared setup only with an empty name",
  },

  // ---------- Publishing a template to several companies (migration 0018) ----------
  {
    what: "Anyone signed in can see a company's newest run columns",
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "    where m.company_id = p_company_id and m.user_id = v_user and m.role = 'admin'\n  ) then\n    raise exception 'PH_NOT_ADMIN' using errcode = '42501';\n  end if;\n\n  -- The newest saved run",
    replace: "  ) or true then\n    null;\n  end if;\n\n  -- The newest saved run",
    test: "src/features/workspace/templateInUse.db.test.ts",
    mustFail: "is for admins of that company only, checked in the database",
  },
  {
    what: "The run columns function returns what is stored, not only the key names",
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "    select distinct jsonb_object_keys(e.extra) as key",
    replace: "    select distinct e.extra::text as key",
    test: "src/features/workspace/templateInUse.db.test.ts",
    mustFail: "never a value",
  },
  {
    what: "Publishing to a company overwrites a draft saved there after the check",
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "    if v_template.draft_revision <> p_expected_revision then",
    replace: "    if false then",
    test: "src/features/workspace/templateInUse.db.test.ts",
    mustFail: "refuses, changing nothing, when that company's draft moved on",
  },
  {
    what: "Publishing to a company does not make it the one used for its payslips",
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "  values (p_company_id, v_version.template_id, v_version.version, v_user, now())",
    replace: "  select p_company_id, v_version.template_id, v_version.version, v_user, now() where false",
    test: "src/features/workspace/templateInUse.db.test.ts",
    mustFail: "makes a new template at version 1 in a company that has none with that name",
  },
  {
    what: "delete_company leaves the template used for the payslips behind",
    file: "supabase/migrations/0018_payslip_template_in_use.sql",
    find: "  delete from public.payslip_template_in_use u where u.company_id = p_company_id;\n  get diagnostics v_in_use = row_count;\n",
    replace: "  v_in_use := 0;\n",
    test: "src/features/company/deleteCompanyMigration.test.ts",
    mustFail: "deletes from every table that belongs to a company",
  },
  {
    what: "The dashboard publishes to a company where the user is only a member",
    file: "src/features/workspace/appData.ts",
    find: '(membership) => membership.role === "admin" && membership.company.brn,',
    replace: "(membership) => Boolean(membership.company.brn),",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "refuses a company where the user is only a member, or not a member",
  },
  {
    what: "A member of the selected company may run the check before publishing",
    file: "src/features/workspace/appData.ts",
    find: '        return refuse("forbidden", "Only an admin of this company can publish a template.");',
    replace: "        void 0;",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "is refused to a member who is not an admin of the selected company",
  },
  {
    what: "The check says every company already has the version being published",
    file: "src/features/workspace/appData.ts",
    find: "              sameJson(latest.body, published),",
    replace: "              true,",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "answers one row per company the user is an ADMIN of",
  },
  {
    what: "Each company of a batch shows its own toast",
    file: "src/features/workspace/appData.ts",
    find: '      { silent: action === "publish-copy" },',
    replace: "      { silent: false },",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "logs each company published to, with no toast of its own",
  },
  {
    what: "A refused company of a batch still shows a toast",
    file: "src/features/workspace/deliver.ts",
    find: "    if (!silent) toast.error(",
    replace: "    if (silent || !silent) toast.error(",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "logs each company published to, with no toast of its own",
  },
  {
    what: "Every page of the check gives the first companies again",
    file: "src/features/workspace/appData.ts",
    find: "            .slice(page * CHECK_PAGE, (page + 1) * CHECK_PAGE)",
    replace: "            .slice(0, CHECK_PAGE)",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "companies at a time, so any number of companies can be checked",
  },
  // ---------- Payslips for several companies (payslip-batch) ----------
  {
    what: "Several companies: a company the user only views can be chosen",
    file: "src/features/workspace/batchAccess.ts",
    find: '    .filter((membership) => membership.role === "admin" && membership.company.brn)',
    replace: "    .filter((membership) => Boolean(membership.company.brn))",
    test: "src/features/workspace/payslipBatch.test.tsx",
    mustFail: "lists only companies where the user is an admin",
  },
  {
    what: "Several companies: asking for a non-admin company is not refused",
    file: "src/features/workspace/payslipBatchData.ts",
    find: "      if (chosen.some((one) => one === null) || chosen.length === 0) {",
    replace: "      if (chosen.length === 0) {",
    test: "src/features/workspace/payslipBatch.test.tsx",
    mustFail: "refuses at once, without asking, a company where the user is only a member",
  },
  {
    what: "Several companies: a company that was not allowed can be loaded",
    file: "src/features/workspace/batchAccess.ts",
    find: "        permit.brns.has(normaliseBrn(load.brn))\n",
    replace: "        true\n",
    test: "src/features/workspace/payslipBatch.test.tsx",
    mustFail: "is refused for a company or a month that was not allowed",
  },
  {
    what: "Several companies: locking the gate keeps what was allowed",
    file: "src/features/workspace/payslipBatchData.ts",
    find: "registerLockCleanup(forgetBatchAllowed);\n",
    replace: "",
    test: "src/features/workspace/payslipBatch.test.tsx",
    mustFail: "locking forgets what was allowed",
  },
  {
    what: "The check lists the hub-owned date as a payroll column",
    file: "src/config/payrollFields.ts",
    find: "    if (!out.includes(key) && !RESERVED_EXTRA_KEYS.has(key) && !isHubOwnedKey(key)) out.push(key);",
    replace: "    if (!out.includes(key) && !RESERVED_EXTRA_KEYS.has(key)) out.push(key);",
    test: "src/features/workspace/appDataTemplatesMulti.test.ts",
    mustFail: "answers one row per company the user is an ADMIN of",
  },
  // ---------- Several companies in one Excel file (payroll-batch) ----------
  {
    what: "Excel of several companies: a company the user only views can be asked for",
    file: "src/features/workspace/payrollBatchData.ts",
    find: "      if (chosen.some((one) => one === null)) {",
    replace: "      if (false) {",
    test: "src/features/workspace/payrollBatch.test.tsx",
    mustFail: "refuses at once, without asking, a company where the user is only a member",
  },
  {
    what: "Excel of several companies: the question says 'and N more' instead of naming every company",
    file: "src/features/workspace/payrollBatchData.ts",
    find: "        of: listNames(names),",
    replace: "        of: listNames(names, 3),",
    test: "src/features/workspace/payrollBatch.test.tsx",
    mustFail: "names every company, however many",
  },
  {
    what: "Excel of several companies: locking the gate keeps what was allowed",
    file: "src/features/workspace/payrollBatchData.ts",
    find: "registerLockCleanup(forgetPayrollBatchAllowed);\n",
    replace: "",
    test: "src/features/workspace/payrollBatch.test.tsx",
    mustFail: "locking forgets what was allowed",
  },
  {
    what: "Excel of several companies: a load for a former admin is answered",
    file: "src/features/workspace/payrollBatchData.ts",
    find: '    if (!target) {\n      return refuse(\n        "forbidden",\n        "Only an admin of that company can export',
    replace: '    if (false) {\n      return refuse(\n        "forbidden",\n        "Only an admin of that company can export',
    test: "src/features/workspace/payrollBatch.test.tsx",
    mustFail: "is refused when the user is no longer an admin of that company",
  },
  {
    what: "Excel of several companies: the month of another period is read",
    file: "src/features/workspace/payrollBatchData.ts",
    find: "    fetchMonths(viewer, company.id, [`${period}-01`]),",
    replace: "    fetchMonths(viewer, company.id, [`${period}-02`]),",
    test: "src/features/workspace/payrollBatch.test.tsx",
    mustFail: "gives one company's month exactly as saved",
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
