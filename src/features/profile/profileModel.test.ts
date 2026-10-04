import { describe, expect, it } from "vitest";
import { checkValue, coreFormSchema, detailFormSchema, detailHref } from "./profileModel";

describe("checkValue", () => {
  it("trims, and stores an empty value as null", () => {
    expect(checkValue("text", "  hello  ")).toEqual({ ok: true, value: "hello" });
    expect(checkValue("number", "   ")).toEqual({ ok: true, value: null });
  });

  it("checks each kind of value", () => {
    expect(checkValue("email", "payroll@example.com").ok).toBe(true);
    expect(checkValue("email", "payroll at example").ok).toBe(false);
    expect(checkValue("phone", "+230 5555 0100").ok).toBe(true);
    expect(checkValue("phone", "call me").ok).toBe(false);
    expect(checkValue("date", "2026-06-30").ok).toBe(true);
    expect(checkValue("date", "2026-02-30").ok).toBe(false);
    expect(checkValue("date", "30/06/2026").ok).toBe(false);
    expect(checkValue("number", "-12.5").ok).toBe(true);
    expect(checkValue("number", "12,5").ok).toBe(false);
  });

  it("accepts only http and https for a web address, and tidies it", () => {
    expect(checkValue("link", "https://EXAMPLE.org/")).toEqual({
      ok: true,
      value: "https://example.org",
    });
    expect(checkValue("link", "javascript:alert(1)").ok).toBe(false);
    expect(checkValue("link", "data:text/html,hi").ok).toBe(false);
  });

  it("refuses a value that is too long", () => {
    expect(checkValue("text", "x".repeat(2001)).ok).toBe(false);
  });
});

describe("the detail form", () => {
  it("needs a label of at most 80 characters, trimmed", () => {
    const base = { field_type: "text", value: "x", is_sensitive: false };
    expect(detailFormSchema.safeParse({ ...base, label: "   " }).success).toBe(false);
    expect(detailFormSchema.safeParse({ ...base, label: "x".repeat(81) }).success).toBe(false);
    expect(detailFormSchema.parse({ ...base, label: "  Tax office " }).label).toBe("Tax office");
  });

  it("reports a bad value against the value field", () => {
    const result = detailFormSchema.safeParse({
      label: "Site",
      field_type: "link",
      value: "javascript:alert(1)",
      is_sensitive: false,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["value"]);
  });
});

describe("the core fields form", () => {
  it("requires a name, trims everything, and turns blanks into null", () => {
    expect(coreFormSchema.safeParse({ name: "  ", address: "", vat: "" }).success).toBe(false);
    expect(coreFormSchema.parse({ name: " ABC Co Ltd ", address: "  ", vat: " 15% " })).toEqual({
      name: "ABC Co Ltd",
      address: null,
      vat: "15%",
    });
  });

  it("enforces the length limits", () => {
    expect(coreFormSchema.safeParse({ name: "x".repeat(201), address: "", vat: "" }).success).toBe(
      false,
    );
    expect(coreFormSchema.safeParse({ name: "x", address: "x".repeat(501), vat: "" }).success).toBe(
      false,
    );
  });

  it("never carries a BRN, even if one is passed in", () => {
    const parsed = coreFormSchema.parse({ name: "ABC", address: "", vat: "", brn: "C9999999" });
    expect("brn" in parsed).toBe(false);
  });
});

describe("detailHref", () => {
  it("only ever produces http(s), mailto and tel links", () => {
    expect(detailHref("link", "https://example.org/x")).toBe("https://example.org/x");
    expect(detailHref("link", "javascript:alert(1)")).toBeNull();
    expect(detailHref("link", "data:text/html,hi")).toBeNull();
    expect(detailHref("email", "payroll@example.com")).toBe("mailto:payroll@example.com");
    expect(detailHref("email", "javascript:alert(1)")).toBeNull();
    expect(detailHref("phone", "+230 5555 0100")).toBe("tel:+23055550100");
    expect(detailHref("text", "https://example.org")).toBeNull();
    expect(detailHref("link", null)).toBeNull();
  });
});
