import { z } from "zod";
import { normaliseUrl, safeHref } from "@/features/links/linkModel";

export const FIELD_TYPES = ["text", "link", "email", "phone", "date", "number"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  link: "Web address",
  email: "Email address",
  phone: "Phone number",
  date: "Date",
  number: "Number",
};

/** Same limits as the database (migration 0005 and the companies table). */
export const DETAIL_LIMITS = { label: 80, value: 2000 } as const;
export const CORE_LIMITS = { name: 200, address: 500, vat: 50 } as const;

/** Checks a value against its type. Returns the value to store, or what is wrong with it. */
export function checkValue(
  type: FieldType,
  raw: string,
): { ok: true; value: string | null } | { ok: false; why: string } {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > DETAIL_LIMITS.value) {
    return { ok: false, why: `The value can be at most ${DETAIL_LIMITS.value} characters.` };
  }
  switch (type) {
    case "link": {
      const url = normaliseUrl(value);
      return url.ok ? { ok: true, value: url.url } : { ok: false, why: url.why };
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? { ok: true, value }
        : { ok: false, why: "Enter an email address like name@example.com." };
    case "phone":
      return /^\+?[\d\s().-]{3,30}$/.test(value) && /\d{3}/.test(value.replace(/\D/g, ""))
        ? { ok: true, value }
        : { ok: false, why: "Enter a phone number using digits, spaces and + ( ) - only." };
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const date = match ? new Date(`${value}T00:00:00Z`) : null;
      return date && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
        ? { ok: true, value }
        : { ok: false, why: "Enter a real date as YYYY-MM-DD." };
    }
    case "number":
      return /^-?\d+(\.\d+)?$/.test(value)
        ? { ok: true, value }
        : { ok: false, why: "Enter a number, using a dot for decimals." };
    case "text":
      return { ok: true, value };
  }
}

/** What the add/edit detail form accepts. */
export const detailFormSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "Enter a label.")
      .max(DETAIL_LIMITS.label, `The label can be at most ${DETAIL_LIMITS.label} characters.`),
    field_type: z.enum(FIELD_TYPES),
    value: z.string(),
    is_sensitive: z.boolean(),
  })
  .transform((input, ctx) => {
    const checked = checkValue(input.field_type, input.value);
    if (!checked.ok) {
      ctx.addIssue({ code: "custom", path: ["value"], message: checked.why });
      return z.NEVER;
    }
    return { ...input, value: checked.value };
  });
export type DetailInput = z.infer<typeof detailFormSchema>;
export type DetailField = "label" | "field_type" | "value" | "is_sensitive";

const optional = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} can be at most ${max} characters.`)
    .transform((value) => (value === "" ? null : value));

/** The core fields an admin may change. The BRN is deliberately not among them. */
export const coreFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter the company's name.")
    .max(CORE_LIMITS.name, `The name can be at most ${CORE_LIMITS.name} characters.`),
  address: optional(CORE_LIMITS.address, "The address"),
  vat: optional(CORE_LIMITS.vat, "The VAT value"),
});
export type CoreInput = z.infer<typeof coreFormSchema>;
export type CoreField = keyof CoreInput;

/**
 * Where a detail's value should lead when clicked, if anywhere. Only http(s), mailto and tel
 * links are ever produced, each built from a value that passed the same check as the form.
 */
export function detailHref(type: string, value: string | null): string | null {
  if (!value) return null;
  if (type === "link") return safeHref(value);
  if (type === "email") return checkValue("email", value).ok ? `mailto:${value.trim()}` : null;
  if (type === "phone") {
    return checkValue("phone", value).ok ? `tel:${value.replace(/[^\d+]/g, "")}` : null;
  }
  return null;
}
