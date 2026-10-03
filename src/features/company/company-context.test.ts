import { describe, expect, it } from "vitest";
import type { Membership } from "@/lib/supabase/schemas";
import { pickCompany } from "./company-context";

const membership = (id: string, role: Membership["role"]): Membership => ({
  role,
  company: { id, name: `Company ${id}`, address: null, brn: null, vat: null },
});

describe("pickCompany", () => {
  const memberships = [membership("a", "viewer"), membership("b", "admin")];

  it("uses the remembered company and its role when the user still belongs to it", () => {
    expect(pickCompany(memberships, "b")).toBe(memberships[1]);
    expect(pickCompany(memberships, "b")?.role).toBe("admin");
  });

  it("falls back to the first company when nothing is remembered", () => {
    expect(pickCompany(memberships, null)).toBe(memberships[0]);
  });

  it("ignores a remembered company the user no longer belongs to", () => {
    expect(pickCompany(memberships, "revoked")).toBe(memberships[0]);
  });

  it("returns null for a user with no companies", () => {
    expect(pickCompany([], "a")).toBeNull();
  });
});
