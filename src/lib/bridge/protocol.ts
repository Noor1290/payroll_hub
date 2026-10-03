import { z } from "zod";

/**
 * The message protocol between the dashboard (hub) and the embedded apps.
 * Apps never talk to each other; everything goes through the dashboard.
 * The human-readable version of this file is docs/INTEGRATION.md; docs/bridge.js is the app side.
 *
 * Every message is an envelope: { type, from, to, version, id, payload }.
 * A reply reuses the `id` of the message it answers (pong -> ping, received -> send-data,
 * response-data -> request-data), which is how the two sides match them up.
 */

const MAX_ROWS = 10_000;

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
  })
  .optional();

export const sendDataPayloadSchema = z.object({
  dataType: dataTypeSchema,
  rows: z.array(rowSchema).min(1).max(MAX_ROWS),
  meta: metaSchema,
});
export type SendDataPayload = z.infer<typeof sendDataPayloadSchema>;

export const receivedPayloadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().max(300) }),
]);
export type ReceivedPayload = z.infer<typeof receivedPayloadSchema>;

export const requestDataPayloadSchema = z.object({
  dataType: dataTypeSchema,
  /** Which month the app wants, "YYYY-MM". Omitted = the latest run. */
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
export type RequestDataPayload = z.infer<typeof requestDataPayloadSchema>;

export const responseDataPayloadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    dataType: dataTypeSchema,
    rows: z.array(rowSchema).min(1).max(MAX_ROWS),
    meta: metaSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(300),
    /** Why, for the app to act on: the dashboard is locked, the user said no, or nobody answered. */
    code: z.enum(["locked", "denied", "timeout", "unavailable"]).optional(),
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
