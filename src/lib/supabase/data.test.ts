import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { classifyDataError, NotConfiguredError } from "./errors";
import { fetchAllRows } from "./paginate";

describe("fetchAllRows", () => {
  const source = Array.from({ length: 2500 }, (_, i) => i);
  const pageOf = (rows: number[]) =>
    vi.fn(async (from: number, to: number) => rows.slice(from, to + 1));

  it("keeps reading past the 1,000-row page limit", async () => {
    const fetchPage = pageOf(source);
    const rows = await fetchAllRows(fetchPage);

    expect(rows).toEqual(source);
    expect(fetchPage.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("makes one extra request when the total is an exact multiple of the page size", async () => {
    const fetchPage = pageOf(source.slice(0, 2000));
    expect(await fetchAllRows(fetchPage)).toHaveLength(2000);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("handles an empty result", async () => {
    expect(await fetchAllRows(pageOf([]))).toEqual([]);
  });

  it("stops and surfaces the error when a page fails", async () => {
    const fetchPage = vi.fn(async (from: number) => {
      if (from >= 1000) throw new TypeError("Failed to fetch");
      return source.slice(0, 1000);
    });
    await expect(fetchAllRows(fetchPage)).rejects.toThrow("Failed to fetch");
  });
});

describe("classifyDataError", () => {
  it("treats network and gateway failures as an unreachable (possibly paused) database", () => {
    expect(classifyDataError(new TypeError("Failed to fetch")).kind).toBe("unreachable");
    expect(classifyDataError({ status: 540, message: "" }).kind).toBe("unreachable");
    expect(classifyDataError(new TypeError("Failed to fetch")).message).toMatch(/paused/i);
  });

  it("recognises an expired session", () => {
    expect(classifyDataError({ code: "PGRST301", message: "JWT expired" }).kind).toBe("session");
  });

  it("recognises a permission failure", () => {
    expect(classifyDataError({ code: "42501", message: "permission denied" }).kind).toBe(
      "forbidden",
    );
  });

  it("flags responses that fail validation rather than showing them", () => {
    const result = z.object({ net_pay: z.number() }).safeParse({ net_pay: "lots" });
    expect(result.success).toBe(false);
    expect(classifyDataError(result.error).kind).toBe("unexpected-shape");
    expect(classifyDataError(result.error).retryable).toBe(false);
  });

  it("recognises a missing configuration", () => {
    expect(classifyDataError(new NotConfiguredError()).kind).toBe("not-configured");
  });

  it("falls back to a retryable unknown", () => {
    expect(classifyDataError({ code: "XX000", message: "boom" })).toMatchObject({
      kind: "unknown",
      retryable: true,
    });
  });
});
