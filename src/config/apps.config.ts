import { Calculator, FileText, ReceiptText, type LucideIcon } from "lucide-react";
import { DEMO_MODE } from "./env";
import { HOSTING } from "./origins";
import { DATE_OF_EMPLOYMENT, PAYROLL_FIELDS } from "./payrollFields";

/** Version of the dashboard <-> app message protocol (docs/INTEGRATION.md). */
export const PROTOCOL_VERSION = 1;

/** Who the dashboard is in message envelopes. */
export const DASHBOARD_ID = "dashboard";

export interface ExpectedField {
  /** Key the app expects in each row it receives. */
  key: string;
  label: string;
  type: "string" | "number" | "date" | "boolean";
  required: boolean;
  sensitive: boolean;
}

export interface AppConfig {
  id: string;
  name: string;
  description: string;
  /** Where the app lives. Keep the trailing slash. Empty while the app does not exist yet. */
  url: string;
  icon: LucideIcon;
  /** A CSS colour (token) used for this app's accents. */
  accentColor: string;
  status: "active" | "coming-soon";
  /** Data types this app can receive. */
  accepts: string[];
  /** Data types this app can send to the dashboard. */
  produces: string[];
  protocolVersion: number;
  /** The row shape this app wants when it receives data. */
  expectedFields: ExpectedField[];
}

export const PAYROLL_RESULT = "payroll-result";

/**
 * Apps that consume payroll results want the payroll app's own export format, key for key,
 * plus the one field the dashboard adds for employees who have it.
 */
const payrollExportFields: ExpectedField[] = [
  ...PAYROLL_FIELDS.map((field) => ({
    key: field.jsonKey,
    label: field.label,
    type: field.type,
    required: field.required,
    sensitive: field.sensitive,
  })),
  {
    key: DATE_OF_EMPLOYMENT,
    label: "Date of employment",
    type: "date",
    required: false,
    sensitive: false,
  },
];

/**
 * The app registry. Adding an app = adding one entry here; menus, tabs, health and transfer
 * destinations are all generated from it.
 */
export const APPS: readonly AppConfig[] = [
  {
    id: "payroll",
    name: "Payroll System",
    description: "Enter salaries, calculate everything, and export the results.",
    url: `${HOSTING.apps}/payroll_sys/`,
    icon: Calculator,
    accentColor: "var(--accent)",
    status: "active",
    accepts: [],
    produces: [PAYROLL_RESULT],
    protocolVersion: PROTOCOL_VERSION,
    expectedFields: [],
  },
  {
    id: "pdf-editor",
    name: "PDF Form Filler",
    description: "Fills the statement of emoluments PDF from payroll results.",
    url: `${HOSTING.apps}/pdf-form-filler/`,
    icon: FileText,
    accentColor: "var(--glow)",
    status: "active",
    accepts: [PAYROLL_RESULT],
    produces: [],
    protocolVersion: PROTOCOL_VERSION,
    expectedFields: payrollExportFields,
  },
  {
    id: "payslip",
    name: "Payslip Automation",
    description: "Generates payslips from payroll results.",
    url: `${HOSTING.apps}/payslip/`,
    icon: ReceiptText,
    accentColor: "var(--warn)",
    status: "active",
    accepts: [PAYROLL_RESULT],
    produces: [],
    protocolVersion: PROTOCOL_VERSION,
    expectedFields: payrollExportFields,
  },
];

export function getApp(id: string | null | undefined): AppConfig | undefined {
  return APPS.find((app) => app.id === id);
}

/**
 * The URL an app is actually loaded from. In dev demo mode the live apps are replaced by a
 * local mock (dev/mock-app.html), because the real apps' bridge only trusts the deployed
 * dashboard origin and would ignore a dashboard running on localhost.
 */
export function appUrl(app: AppConfig): string {
  if (app.status !== "active" || !app.url) return "";
  if (import.meta.env.DEV && DEMO_MODE) {
    return `${window.location.origin}${import.meta.env.BASE_URL}dev/mock-app.html?app=${app.id}`;
  }
  return app.url;
}

/** The exact origin messages to and from this app must use; null if the app has no URL. */
export function appOrigin(app: AppConfig): string | null {
  const url = appUrl(app);
  return url ? new URL(url).origin : null;
}

/** Apps that can receive a data type, optionally leaving one out (usually the sender). */
export function appsAccepting(dataType: string, exceptId?: string): AppConfig[] {
  return APPS.filter((app) => app.id !== exceptId && app.accepts.includes(dataType));
}

/**
 * True when this dashboard is not running on its deployed origin (e.g. `npm run dev`).
 * The live apps then cannot answer it, by design, so their bridge will look "not installed".
 */
export function isOffDeployedOrigin(): boolean {
  return !(import.meta.env.DEV && DEMO_MODE) && window.location.origin !== HOSTING.dashboard;
}
