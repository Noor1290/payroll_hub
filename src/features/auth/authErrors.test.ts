import { describe, expect, it } from "vitest";
import { classifyAuthError } from "./authErrors";

describe("classifyAuthError", () => {
  it("recognises wrong credentials", () => {
    expect(classifyAuthError({ status: 400, code: "invalid_credentials" }).kind).toBe(
      "invalid-credentials",
    );
    expect(classifyAuthError({ status: 400, message: "Invalid login credentials" }).kind).toBe(
      "invalid-credentials",
    );
  });

  it("treats network failures as an unreachable (possibly paused) database", () => {
    expect(classifyAuthError(new TypeError("Failed to fetch")).kind).toBe("unreachable");
    expect(classifyAuthError({ name: "AuthRetryableFetchError", status: 0 }).kind).toBe(
      "unreachable",
    );
    expect(classifyAuthError({ status: 540 }).kind).toBe("unreachable");
    expect(classifyAuthError({ status: 503 }).kind).toBe("unreachable");
  });

  it("mentions the paused project so the user knows what to check", () => {
    expect(classifyAuthError({ status: 540 }).message).toMatch(/paused/i);
  });

  it("recognises rate limiting", () => {
    expect(classifyAuthError({ status: 429 }).kind).toBe("rate-limited");
  });

  it("falls back to unknown for anything else", () => {
    expect(classifyAuthError(null).kind).toBe("unknown");
    expect(classifyAuthError("boom").kind).toBe("unknown");
    expect(classifyAuthError({ status: 418 }).kind).toBe("unknown");
  });
});
