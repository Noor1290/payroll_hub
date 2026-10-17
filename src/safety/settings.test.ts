import { describe, expect, it } from "vitest";
import { checkAnonKey, checkProjectUrl, parseDotEnv, parseTestCompanyIds } from "./settings.ts";

/** A JWT-shaped string with the given role claim (no real key, no signature). */
const fakeJwt = (role: string) => `header.${btoa(JSON.stringify({ iss: "supabase", role })).replace(/=+$/, "")}.signature`;

describe("parseDotEnv", () => {
  it("reads KEY=VALUE lines, skips comments and blank lines, removes one pair of quotes", () => {
    expect(parseDotEnv('# note\nA=1\n\nB = "two words"\nC=\'x\'\nD=a=b\nnot a pair\n')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "a=b",
    });
  });
});

describe("checkProjectUrl", () => {
  it("accepts an https supabase.co address and refuses anything else", () => {
    expect(checkProjectUrl("https://abcdefgh.supabase.co")).toBeNull();
    expect(checkProjectUrl(undefined)).toMatch(/missing/);
    expect(checkProjectUrl("http://abcdefgh.supabase.co")).toMatch(/https/);
    expect(checkProjectUrl("https://example.com")).toMatch(/supabase\.co/);
    expect(checkProjectUrl("not a url")).toMatch(/valid/);
  });
});

describe("checkAnonKey", () => {
  it("accepts the anon key and a publishable key", () => {
    expect(checkAnonKey(fakeJwt("anon"))).toBeNull();
    expect(checkAnonKey("sb_publishable_abc")).toBeNull();
  });

  it("refuses a service-role key or a secret key, without repeating it", () => {
    const service = fakeJwt("service_role");
    const problem = checkAnonKey(service);
    expect(problem).toMatch(/service_role.*Refusing/);
    expect(problem).not.toContain(service);
    expect(checkAnonKey("sb_secret_abc")).toMatch(/SECRET key/);
    expect(checkAnonKey("sb_secret_abc")).not.toContain("sb_secret_abc");
  });

  it("refuses a missing or unreadable key", () => {
    expect(checkAnonKey(undefined)).toMatch(/missing/);
    expect(checkAnonKey("nonsense")).toMatch(/format/);
  });
});

describe("parseTestCompanyIds", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("takes exactly two different company ids", () => {
    expect(parseTestCompanyIds(` ${a} , ${b.toUpperCase()} `)).toEqual({ ids: [a, b] });
  });

  it("refuses one id, three ids, the same id twice, or something that is not an id", () => {
    expect(parseTestCompanyIds(a)).toHaveProperty("problem");
    expect(parseTestCompanyIds(`${a},${b},${a}`)).toHaveProperty("problem");
    expect(parseTestCompanyIds(`${a},${a}`)).toHaveProperty("problem");
    expect(parseTestCompanyIds(`${a},TEST Co Ltd`)).toHaveProperty("problem");
    expect(parseTestCompanyIds(undefined)).toHaveProperty("problem");
  });
});
