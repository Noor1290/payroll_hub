import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Membership } from "@/lib/supabase/schemas";
import { canAddCompany } from "./company-context";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/client", () => ({ supabase: { rpc } }));

const { classifyCreateCompanyError, COMPANY_LIMITS, createCompany, fieldErrors, newCompanySchema } =
  await import("./createCompany");

const VIEWER = { id: "00000000-0000-4000-8000-0000000000a1", isDemo: false };
const ROW = {
  id: "10000000-0000-4000-8000-000000000009",
  name: "New Venture Ltd",
  address: "Port Louis",
  brn: "C7654321",
  vat: "15%",
  created_at: "2026-10-03T10:00:00+00:00",
};

const parse = (input: Record<string, string>) =>
  newCompanySchema.safeParse({ name: "", address: "", brn: "", vat: "", ...input });
const errorsOf = (input: Record<string, string>) => {
  const result = parse(input);
  return result.success ? {} : fieldErrors(result.error);
};

beforeEach(() => rpc.mockReset());

describe("who may add a company", () => {
  const membership = (role: Membership["role"]): Membership => ({
    role,
    company: { id: role, name: role, address: null, brn: null, vat: null },
  });

  it("is anyone who is already an admin of at least one company", () => {
    expect(canAddCompany([membership("viewer"), membership("admin")])).toBe(true);
    expect(canAddCompany([membership("admin")])).toBe(true);
  });

  it("is not a viewer, and not someone with no company", () => {
    expect(canAddCompany([membership("viewer")])).toBe(false);
    expect(canAddCompany([])).toBe(false);
  });
});

describe("newCompanySchema", () => {
  it("trims every field and turns empty optional fields into null", () => {
    const result = parse({
      name: "  New Venture Ltd ",
      brn: " C7654321 ",
      address: "   ",
      vat: "",
    });
    expect(result.success && result.data).toEqual({
      name: "New Venture Ltd",
      brn: "C7654321",
      address: null,
      vat: null,
    });
  });

  it("keeps optional fields when given", () => {
    const result = parse({ name: "A", brn: "B", address: " Port Louis ", vat: " 15% " });
    expect(result.success && result.data).toMatchObject({ address: "Port Louis", vat: "15%" });
  });

  it("requires a name and a BRN, including when they are only spaces", () => {
    expect(errorsOf({})).toEqual({ name: "Enter the company's name.", brn: "Enter the BRN." });
    expect(errorsOf({ name: "   ", brn: "\t" })).toEqual({
      name: "Enter the company's name.",
      brn: "Enter the BRN.",
    });
    expect(errorsOf({ name: "ABC Co Ltd" })).toEqual({ brn: "Enter the BRN." });
  });

  it("enforces the same length limits as the database function", () => {
    expect(COMPANY_LIMITS).toEqual({ name: 200, address: 500, brn: 50, vat: 50 });
    const ok = parse({
      name: "n".repeat(200),
      brn: "b".repeat(50),
      address: "a".repeat(500),
      vat: "v".repeat(50),
    });
    expect(ok.success).toBe(true);

    expect(
      errorsOf({
        name: "n".repeat(201),
        brn: "b".repeat(51),
        address: "a".repeat(501),
        vat: "v".repeat(51),
      }),
    ).toEqual({
      name: "The name can be at most 200 characters.",
      brn: "The BRN can be at most 50 characters.",
      address: "The address can be at most 500 characters.",
      vat: "The VAT value can be at most 50 characters.",
    });
  });

  it("measures length after trimming", () => {
    expect(parse({ name: `  ${"n".repeat(200)}  `, brn: "C1" }).success).toBe(true);
  });

  it("rejects anything that is not text", () => {
    expect(newCompanySchema.safeParse({ name: 5, address: null, brn: {}, vat: [] }).success).toBe(
      false,
    );
  });
});

describe("createCompany", () => {
  const input = { name: "New Venture Ltd", address: null, brn: "C7654321", vat: "15%" };

  it("calls the create_company function with the four values, and nothing else", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    const company = await createCompany(VIEWER, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_company", {
      p_name: "New Venture Ltd",
      p_address: null,
      p_brn: "C7654321",
      p_vat: "15%",
    });
    expect(company).toEqual({
      id: ROW.id,
      name: "New Venture Ltd",
      address: "Port Louis",
      brn: "C7654321",
      vat: "15%",
    });
  });

  it("passes a database error on", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "PH_DUPLICATE_BRN" } });
    await expect(createCompany(VIEWER, input)).rejects.toMatchObject({
      message: "PH_DUPLICATE_BRN",
    });
  });

  it("refuses a response that isn't a company", async () => {
    rpc.mockResolvedValue({ data: { id: "nope" }, error: null });
    await expect(createCompany(VIEWER, input)).rejects.toBeInstanceOf(ZodError);
  });
});

describe("classifyCreateCompanyError", () => {
  it("explains a duplicate BRN and points at the BRN field", () => {
    for (const error of [
      { code: "23505", message: "PH_DUPLICATE_BRN" },
      {
        code: "23505",
        message: 'duplicate key value violates unique constraint "companies_brn_key"',
      },
    ]) {
      expect(classifyCreateCompanyError(error)).toMatchObject({
        title: "A company with this BRN already exists",
        field: "brn",
        retryable: false,
      });
    }
  });

  it("explains that only existing admins may add companies", () => {
    for (const message of ["PH_NOT_ADMIN", "PH_NOT_SIGNED_IN"]) {
      const failure = classifyCreateCompanyError({ code: "42501", message });
      expect(failure.title).toBe("You're not allowed to add companies");
      expect(failure.message).toMatch(/already an admin/);
    }
  });

  it("says which migration to run when the function is missing", () => {
    for (const error of [
      {
        code: "PGRST202",
        message: "Could not find the function public.create_company in the schema cache",
      },
      { code: "42883", message: "function public.create_company does not exist" },
    ]) {
      const failure = classifyCreateCompanyError(error);
      expect(failure.title).toBe("Adding companies isn't set up in the database yet");
      expect(failure.message).toContain("0003_create_company.sql");
    }
  });

  it("explains an unreachable or paused database, and offers a retry", () => {
    const failure = classifyCreateCompanyError(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toMatch(/paused/i);
    expect(failure.retryable).toBe(true);
  });

  it("explains an ended session", () => {
    expect(classifyCreateCompanyError({ code: "PGRST301", message: "JWT expired" }).kind).toBe(
      "session",
    );
  });

  it("shows the database's own reason for rejected input", () => {
    expect(
      classifyCreateCompanyError({
        code: "22023",
        message: "PH_INVALID_INPUT: the BRN is required",
      }).message,
    ).toBe("The BRN is required. Nothing was created.");
  });

  it("always says that nothing was created", () => {
    for (const error of [
      { code: "23505", message: "PH_DUPLICATE_BRN" },
      { code: "42501", message: "PH_NOT_ADMIN" },
      { code: "PGRST202", message: "" },
      new TypeError("Failed to fetch"),
      { code: "XX000", message: "boom" },
      null,
    ]) {
      expect(classifyCreateCompanyError(error).message).toMatch(/Nothing was created\.$/);
    }
  });
});
