import { describe, expect, it } from "vitest";
import { fakeAddress, judgeSignup } from "./signupCheck.ts";

describe("judgeSignup", () => {
  it("passes only when Supabase says sign-ups are off", () => {
    expect(judgeSignup({ error: { code: "signup_disabled", message: "Signups not allowed for this instance" } }).status).toBe(
      "PASS",
    );
    expect(judgeSignup({ error: { message: "Signups not allowed for this instance" } }).status).toBe("PASS");
    expect(judgeSignup({ error: { code: "anonymous_provider_disabled", message: "Anonymous sign-ins are disabled" } }).status).toBe(
      "PASS",
    );
  });

  it("fails when an account comes back", () => {
    const verdict = judgeSignup({ userId: "3f0c...", error: null });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.result).toMatch(/Delete it/);
  });

  it("is unclear when refused for another reason, which does not prove sign-ups are off", () => {
    expect(judgeSignup({ error: { code: "email_address_invalid", message: "Email address is invalid" } }).status).toBe("UNCLEAR");
    expect(judgeSignup({ error: { code: "over_email_send_rate_limit", message: "rate limit" } }).status).toBe("UNCLEAR");
    expect(judgeSignup({}).status).toBe("UNCLEAR");
  });
});

describe("fakeAddress", () => {
  it("is on example.com, a domain reserved for examples", () => {
    expect(fakeAddress(1, "ab12")).toBe("safety-check-1-ab12@example.com");
  });
});
