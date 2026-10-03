import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MINUTES, DEMO_MODE, parseEnv } from "./env";

const URL = "https://example-project.supabase.co";
const KEY = "fake-public-anon-key-for-tests-only";

describe("parseEnv", () => {
  it("returns a Supabase config when both values are present", () => {
    const env = parseEnv({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_ANON_KEY: KEY });
    expect(env.supabase).toEqual({ url: URL, anonKey: KEY });
    expect(env.problems).toEqual([]);
    expect(env.idleTimeoutMinutes).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
  });

  it("treats blank values as missing and says which", () => {
    const env = parseEnv({ VITE_SUPABASE_URL: "  ", VITE_SUPABASE_ANON_KEY: "" });
    expect(env.supabase).toBeNull();
    expect(env.problems).toEqual([
      "VITE_SUPABASE_URL is not set.",
      "VITE_SUPABASE_ANON_KEY is not set.",
    ]);
  });

  it("rejects a malformed URL without throwing", () => {
    const env = parseEnv({ VITE_SUPABASE_URL: "not a url", VITE_SUPABASE_ANON_KEY: KEY });
    expect(env.supabase).toBeNull();
    expect(env.problems).toEqual(["VITE_SUPABASE_URL is not valid."]);
  });

  it("reads the idle timeout, allowing 0 to disable it", () => {
    expect(parseEnv({ VITE_IDLE_TIMEOUT_MINUTES: "30" }).idleTimeoutMinutes).toBe(30);
    expect(parseEnv({ VITE_IDLE_TIMEOUT_MINUTES: "0" }).idleTimeoutMinutes).toBe(0);
    expect(parseEnv({ VITE_IDLE_TIMEOUT_MINUTES: "" }).idleTimeoutMinutes).toBe(
      DEFAULT_IDLE_TIMEOUT_MINUTES,
    );
  });
});

describe("DEMO_MODE", () => {
  it("is off unless explicitly enabled", () => {
    expect(DEMO_MODE).toBe(false);
  });
});
