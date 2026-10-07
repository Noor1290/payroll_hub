/**
 * Test only. A stand-in for the Supabase client that records every query and answers each one
 * from a function the test supplies. Use it with:
 *
 *   vi.mock("@/lib/supabase/client", async () => ({
 *     supabase: (await import("@/test/fakeClient")).fake.client,
 *   }));
 */
export type Call = [method: string, ...args: unknown[]];
export interface Answer {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

const state = {
  /** One list of calls per query, e.g. [["from","employees"],["select","id"],["eq","id","x"]]. */
  queries: [] as Call[][],
  answer: ((): Answer => ({ data: [], error: null })) as (calls: Call[]) => Answer,
};

const builder = (own: Call[]): Record<string, unknown> =>
  new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === "then") {
          return (resolve: (value: unknown) => void) =>
            resolve({ data: null, error: null, ...state.answer(own) });
        }
        return (...args: unknown[]) => {
          own.push([property, ...args]);
          return builder(own);
        };
      },
    },
  );

const start = (first: Call) => {
  const own: Call[] = [first];
  state.queries.push(own);
  return builder(own);
};

export const fake = {
  state,
  client: {
    from: (name: string) => start(["from", name]),
    rpc: (name: string, args: unknown) => start(["rpc", name, args]),
  },
  /** Forget earlier queries and set how the next ones are answered. */
  reset(answer: (calls: Call[]) => Answer = () => ({ data: [], error: null })) {
    state.queries.length = 0;
    state.answer = answer;
  },
  /** The arguments of the first call to `method` in a query, or undefined. */
  arg(calls: Call[], method: string, index = 0): unknown {
    return calls.find(([name]) => name === method)?.[index + 1];
  },
};
