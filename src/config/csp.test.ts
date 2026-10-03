import { describe, expect, it } from "vitest";
import { APPS } from "./apps.config";
import { buildCsp } from "./csp";
import { HOSTING } from "./origins";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values];
    }),
  );

describe("buildCsp", () => {
  const policy = directives(
    buildCsp({ supabaseUrl: "https://example-project.supabase.co/rest/v1" }),
  );

  it("only runs the dashboard's own scripts: no inline scripts, no eval, no CDNs", () => {
    expect(policy["script-src"]).toEqual(["'self'"]);
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
  });

  it("only talks to itself and the Supabase project", () => {
    expect(policy["connect-src"]).toEqual(["'self'", "https://example-project.supabase.co"]);
  });

  it("only embeds the registered apps' origin", () => {
    expect(policy["frame-src"]).toEqual([HOSTING.apps]);
    for (const app of APPS.filter((a) => a.url)) {
      expect(policy["frame-src"]).toContain(new URL(app.url).origin);
    }
  });

  it("loads fonts and images from the site itself, with no third parties", () => {
    expect(policy["font-src"]).toEqual(["'self'"]);
    expect(policy["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(buildCsp({})).not.toMatch(/https?:\/\/(?!noor1290\.github\.io)/);
  });

  it("still builds a safe policy when the Supabase URL is missing or malformed", () => {
    expect(directives(buildCsp({}))["connect-src"]).toEqual(["'self'"]);
    expect(directives(buildCsp({ supabaseUrl: "not a url" }))["connect-src"]).toEqual(["'self'"]);
  });

  it("never uses a wildcard", () => {
    expect(buildCsp({ supabaseUrl: "https://example-project.supabase.co" })).not.toContain("*");
  });
});
