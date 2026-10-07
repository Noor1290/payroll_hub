import { z } from "zod";

/**
 * The message protocol between the dashboard (hub) and the embedded apps.
 * Apps never talk to each other; everything goes through the dashboard.
 * The human-readable version of this file is docs/INTEGRATION.md; docs/bridge.js is the app side.
 *
 * Every message is an envelope: { type, from, to, version, id, payload }.
 * A reply reuses the `id` of the message it answers (pong -> ping, received -> send-data,
 * response-data -> request-data), which is how the two sides match them up.
 *
 * Still version 1. Everything added for the payslip app is optional and additive: `params` on
 * a request, `result` and `code` on an acknowledgement, `brn` and `role` in `meta`, more
 * refusal codes, `index` on a refused save (which payslip of a month was at fault), and an
 * answer that may have no rows for the data types listed in DATA_RULES.
 */

const MAX_ROWS = 10_000;

/** Why something was refused, for the app to act on. See docs/INTEGRATION.md for each one. */
export const REFUSAL_CODES = [
  "locked",
  "denied",
  "timeout",
  "unavailable",
  "stale",
  "no-change",
  "forbidden",
  "wrong-company",
  "invalid",
  "not-found",
  "too-large",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
const codeSchema = z.enum(REFUSAL_CODES);

/** Size of a value once written as JSON, in bytes: what actually crosses the bridge. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/**
 * Limits per data type, applied by the hub before a handler sees anything.
 *  - sendRows:    how many rows an app may send in one message
 *  - sendBytes:   how large that message's rows may be as JSON
 *  - answerRows:  how many rows the dashboard's answer to a request may have, smallest first
 * A data type that is not listed gets DEFAULT_RULES (the limits payroll results always had).
 */
export interface DataRules {
  sendRows: number;
  sendBytes: number | null;
  answerRows: readonly [min: number, max: number];
}
const DEFAULT_RULES: DataRules = { sendRows: MAX_ROWS, sendBytes: null, answerRows: [1, MAX_ROWS] };
export const DATA_RULES: Readonly<Record<string, DataRules>> = {
  "payroll-result": DEFAULT_RULES,
  // A save is one command: one row. An answer lists every version, and may be empty.
  "statutory-rates": { sendRows: 1, sendBytes: 4_096, answerRows: [0, 1_000] },
  // The body may be 150 KB (TEMPLATE_BODY_BYTES); the rest is the name and the ids around it.
  "payslip-template": { sendRows: 1, sendBytes: 160_000, answerRows: [0, 50] },
  // One command holding a whole month (ISSUE_MAX_PAYSLIPS payslips of PAYSLIP_BYTES each at
  // most). An answer has one row per employee.
  "payslip-issue": { sendRows: 1, sendBytes: 4_000_000, answerRows: [0, 5_000] },
};
export const rulesFor = (dataType: string): DataRules => DATA_RULES[dataType] ?? DEFAULT_RULES;

/** The largest template body the hub accepts, as JSON. The database's own limit is 256 KB. */
export const TEMPLATE_BODY_BYTES = 150_000;
/** How many payslips one save may issue. The database has the same limit. */
export const ISSUE_MAX_PAYSLIPS = 1_000;
/** The largest single payslip in a save, as JSON. */
export const PAYSLIP_BYTES = 16_000;
/** The largest `params` object on a request. */
export const PARAMS_BYTES = 2_048;

export interface Refusal {
  ok: false;
  error: string;
  code: RefusalCode;
  /**
   * Which payslip of a refused month was at fault: its position in the `payslips` list the app
   * sent, counted from 0. The app can name the employee from it; the dashboard never does.
   */
  index?: number;
}

/** Checks what an app sent against its data type's limits. Null when it is within them. */
export function checkSentData(payload: SendDataPayload): Refusal | null {
  const rules = rulesFor(payload.dataType);
  if (payload.rows.length > rules.sendRows) {
    return {
      ok: false,
      code: rules.sendRows === 1 ? "invalid" : "too-large",
      error:
        rules.sendRows === 1
          ? "Send exactly one row: one command per message."
          : `Too many rows (the limit is ${rules.sendRows}).`,
    };
  }
  if (rules.sendBytes !== null && jsonBytes(payload.rows) > rules.sendBytes) {
    return {
      ok: false,
      code: "too-large",
      error: "The data is larger than the dashboard accepts.",
    };
  }
  return null;
}

/** Checks a request's `params`. Null when they are acceptable. */
export function checkRequest(payload: RequestDataPayload): Refusal | null {
  if (payload.params !== undefined && jsonBytes(payload.params) > PARAMS_BYTES) {
    return { ok: false, code: "too-large", error: "The request's params are too large." };
  }
  return null;
}

/** Checks the dashboard's own answer before it is posted. Null when it may go. */
export function checkAnswer(payload: ResponseDataPayload): Refusal | null {
  if (!payload.ok) return null;
  const [min, max] = rulesFor(payload.dataType).answerRows;
  if (payload.rows.length < min) {
    return { ok: false, code: "not-found", error: "There is nothing to send." };
  }
  if (payload.rows.length > max) {
    return { ok: false, code: "too-large", error: "The answer is larger than the bridge allows." };
  }
  return null;
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const partySchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const dataTypeSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** A row is a plain JSON object. What its keys must be is decided by the data type, not here. */
const rowSchema = z.record(z.string(), z.unknown());

const metaSchema = z
  .object({
    /** Payroll month, "YYYY-MM". */
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    /** Short human label, e.g. a company name. Never payroll figures. */
    label: z.string().max(120).optional(),
    /** The BRN of the company the answer is about, so the app can check it got the right one. */
    brn: z.string().max(50).optional(),
    /**
     * The signed-in user's role in that company, so an app can show read-only from the start.
     * "member" is the database's "viewer". Only a hint: the database decides what is allowed.
     */
    role: z.enum(["admin", "member"]).optional(),
  })
  .optional();

export const sendDataPayloadSchema = z.object({
  dataType: dataTypeSchema,
  rows: z.array(rowSchema).min(1).max(MAX_ROWS),
  meta: metaSchema,
});
export type SendDataPayload = z.infer<typeof sendDataPayloadSchema>;

export const receivedPayloadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** What a save produced, e.g. the new revision number. Only on the dashboard's own replies. */
    result: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(300),
    code: codeSchema.optional(),
    /** Position (from 0) of the payslip at fault in a refused month. See Refusal. */
    index: z.number().int().min(0).optional(),
  }),
]);
export type ReceivedPayload = z.infer<typeof receivedPayloadSchema>;

export const requestDataPayloadSchema = z.object({
  dataType: dataTypeSchema,
  /** Which month the app wants, "YYYY-MM". Omitted = the latest run. */
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  /** What exactly is wanted. Its shape depends on the data type and is checked by its handler. */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RequestDataPayload = z.infer<typeof requestDataPayloadSchema>;

export const responseDataPayloadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    dataType: dataTypeSchema,
    // May be empty for some data types; the hub checks the minimum per type (checkAnswer).
    rows: z.array(rowSchema).max(MAX_ROWS),
    meta: metaSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(300),
    /** Why, for the app to act on. */
    code: codeSchema.optional(),
  }),
]);
export type ResponseDataPayload = z.infer<typeof responseDataPayloadSchema>;

/** ready / ping / pong carry nothing the dashboard relies on. */
const emptyPayloadSchema = z.looseObject({}).optional();

const base = { from: partySchema, to: partySchema, version: z.number().int(), id: idSchema };

/** Everything an app is allowed to send to the dashboard. */
export const incomingMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("ready"), payload: emptyPayloadSchema }),
  z.object({ ...base, type: z.literal("ping"), payload: emptyPayloadSchema }),
  z.object({ ...base, type: z.literal("pong"), payload: emptyPayloadSchema }),
  z.object({ ...base, type: z.literal("send-data"), payload: sendDataPayloadSchema }),
  z.object({ ...base, type: z.literal("received"), payload: receivedPayloadSchema }),
  z.object({ ...base, type: z.literal("request-data"), payload: requestDataPayloadSchema }),
]);
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;

/** Everything the dashboard sends to an app. */
export type OutgoingMessage =
  | { type: "ping"; payload: Record<string, never> }
  | { type: "pong"; payload: Record<string, never> }
  | { type: "send-data"; payload: SendDataPayload }
  | { type: "received"; payload: ReceivedPayload }
  | { type: "response-data"; payload: ResponseDataPayload };

export interface Envelope {
  type: OutgoingMessage["type"];
  from: string;
  to: string;
  version: number;
  id: string;
  payload: unknown;
}
