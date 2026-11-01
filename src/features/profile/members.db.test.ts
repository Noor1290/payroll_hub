// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 0021 (the Members card) in a real Postgres (PGlite), used the way the Data API does:
 * as the role "authenticated" (or "anon") with a user id in the request claims, so these tests
 * hold when the app is bypassed. Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
const migration = (number: string) => migrations.find((m) => m.name.startsWith(number))!;

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // the only admin of XYZ
const C = "00000000-0000-4000-8000-0000000000a5"; // admin of ABC
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const SETUP_TIMEOUT = 120_000;

const SUPABASE_STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create role migration_owner nologin nosuperuser bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, migration_owner;
  grant references, select on auth.users to migration_owner;
  alter schema public owner to migration_owner;
  ${STORAGE_STAND_IN}
`;

const SEED = `
  truncate public.companies cascade;
  delete from auth.users;
  insert into auth.users (id, email) values
    ('${A}', 'a@example.com'), ('${V}', 'v@example.com'), ('${O}', 'Other@Example.com'),
    ('${B}', 'b@example.com'), ('${C}', 'c@example.com');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'), ('${ABC}', '${C}', 'admin'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer');
`;

type Role = "authenticated" | "anon";
type Outcome<T> = { result: T; error: null } | { result: null; error: string };

let db: PGlite;

async function as<T>(role: Role, user: string | null, work: () => Promise<T>): Promise<Outcome<T>> {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify(user ? { sub: user, role } : { role }),
  ]);
  try {
    return { result: await work(), error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { result: null, error: `${code} ${message}` };
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claims', '', false);");
  }
}

const rows = (user: string | null, sql: string, params: unknown[] = [], role: Role = "authenticated") =>
  as(role, user, async () => (await db.query<Record<string, unknown>>(sql, params)).rows);

const list = (user: string | null, company = ABC, role: Role = "authenticated") =>
  rows(user, "select * from public.list_company_members($1)", [company], role);
const add = (user: string | null, company: string, email: string, memberRole = "viewer") =>
  rows(user, "select public.add_company_member($1, $2, $3) as result", [company, email, memberRole]);
const setRole = (user: string | null, company: string, member: string, memberRole: string) =>
  rows(user, "select public.set_company_member_role($1, $2, $3) as result", [company, member, memberRole]);
const remove = (user: string | null, company: string, member: string) =>
  rows(user, "select public.remove_company_member($1, $2) as result", [company, member]);

const roleOf = async (company: string, member: string) =>
  (
    await db.query<{ role: string }>(
      "select role from public.company_members where company_id = $1 and user_id = $2",
      [company, member],
    )
  ).rows[0]?.role;
const records = async (company = ABC) =>
  (
    await db.query<Record<string, unknown>>(
      `select action, member_id, member_email, old_role, new_role, changed_by, changed_by_email
       from public.company_member_history where company_id = $1 order by id`,
      [company],
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) await db.exec(`set role migration_owner; ${sql}; reset role;`);
}, SETUP_TIMEOUT);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(SEED);
});

describe("0021: the migration", () => {
  it("answers one row, all true, and can be run again", async () => {
    const results = await db.exec(
      `set role migration_owner; ${migration("0021").sql}; reset role;`,
    );
    const row = results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!.rows[0];
    expect(Object.keys(row as object)).toHaveLength(9);
    expect(Object.values(row as object).every((value) => value === true)).toBe(true);
  });

  it("changes no member and no company", async () => {
    await db.exec(`set role migration_owner; ${migration("0021").sql}; reset role;`);
    expect(await roleOf(ABC, A)).toBe("admin");
    expect(await roleOf(XYZ, B)).toBe("admin");
  });
});

describe("0021: who may do anything", () => {
  it.each([
    ["a viewer of the company", V],
    ["a member of nothing", O],
    ["an admin of another company", B],
  ])("refuses %s, for all four, and changes nothing", async (_who, user) => {
    expect((await list(user)).error).toContain("PH_NOT_ADMIN");
    expect((await add(user, ABC, "other@example.com")).error).toContain("PH_NOT_ADMIN");
    expect((await setRole(user, ABC, V, "admin")).error).toContain("PH_NOT_ADMIN");
    expect((await remove(user, ABC, V)).error).toContain("PH_NOT_ADMIN");
    expect(await roleOf(ABC, V)).toBe("viewer");
    expect(await records()).toEqual([]);
  });

  it("says nothing about an email to someone who is not an admin: the same refusal either way", async () => {
    const known = await add(V, ABC, "other@example.com");
    const unknown = await add(V, ABC, "nobody@example.com");
    expect(known.error).toBe(unknown.error);
  });

  it("refuses anyone signed out, and an anonymous visitor cannot call them at all", async () => {
    expect((await list(null)).error).toContain("PH_NOT_SIGNED_IN");
    expect((await list(null, ABC, "anon")).error).toContain("42501");
  });

  it("nobody can change a member, or a record, directly", async () => {
    const insert = `insert into public.company_members (company_id, user_id, role)
                    values ('${ABC}', '${O}', 'admin')`;
    expect((await rows(A, insert)).error).toContain("42501");
    expect((await rows(A, `update public.company_members set role = 'admin'`)).error).toContain("42501");
    expect((await rows(A, `delete from public.company_members`)).error).toContain("42501");
    await add(A, ABC, "other@example.com");
    expect((await rows(A, `delete from public.company_member_history`)).error).toContain("42501");
    expect((await rows(A, `update public.company_member_history set member_email = ''`)).error).toContain("42501");
  });

  it("only that company's admins can read its records", async () => {
    await add(A, ABC, "other@example.com");
    const read = (user: string) => rows(user, "select * from public.company_member_history");
    expect((await read(A)).result).toHaveLength(1);
    expect((await read(C)).result).toHaveLength(1);
    expect((await read(V)).result).toEqual([]);
    expect((await read(B)).result).toEqual([]);
    expect((await read(O)).result).toEqual([]);
    expect(
      (await rows(null, "select * from public.company_member_history", [], "anon")).error,
    ).toContain("42501");
  });
});

describe("0021: the members", () => {
  it("lists the company's members with their emails, and only theirs", async () => {
    const { result } = await list(A);
    expect(result!.map((row) => [row.email, row.role])).toEqual([
      ["a@example.com", "admin"],
      ["c@example.com", "admin"],
      ["v@example.com", "viewer"],
    ]);
  });
});

describe("0021: adding", () => {
  it("adds an existing user, whatever the capitals and spaces, and records it", async () => {
    await add(A, ABC, "  OTHER@example.COM ", "viewer");
    expect(await roleOf(ABC, O)).toBe("viewer");
    expect(await records()).toEqual([
      {
        action: "added",
        member_id: O,
        member_email: "other@example.com",
        old_role: null,
        new_role: "viewer",
        changed_by: A,
        changed_by_email: "a@example.com",
      },
    ]);
  });

  it("can add an admin", async () => {
    await add(A, ABC, "other@example.com", "admin");
    expect(await roleOf(ABC, O)).toBe("admin");
  });

  it("says when an email has no account, and stores nothing", async () => {
    expect((await add(A, ABC, "nobody@example.com")).error).toContain("PH_NO_ACCOUNT");
    expect(await records()).toEqual([]);
  });

  it("refuses someone who is already a member, a wrong role and something not an email", async () => {
    expect((await add(A, ABC, "v@example.com")).error).toContain("PH_ALREADY_MEMBER");
    expect((await add(A, ABC, "other@example.com", "owner")).error).toContain("PH_INVALID_INPUT");
    expect((await add(A, ABC, "not an email")).error).toContain("PH_INVALID_INPUT");
    expect(await records()).toEqual([]);
  });

  it("adds to that company only", async () => {
    await add(A, ABC, "other@example.com");
    expect(await roleOf(XYZ, O)).toBeUndefined();
  });
});

describe("0021: changing a role", () => {
  it("changes a role and records old and new", async () => {
    await setRole(A, ABC, V, "admin");
    expect(await roleOf(ABC, V)).toBe("admin");
    expect(await records()).toMatchObject([
      { action: "role-changed", member_id: V, old_role: "viewer", new_role: "admin", changed_by: A },
    ]);
  });

  it("can make another admin a viewer", async () => {
    await setRole(A, ABC, C, "viewer");
    expect(await roleOf(ABC, C)).toBe("viewer");
  });

  it("the last admin can never be made a viewer", async () => {
    expect((await setRole(B, XYZ, B, "viewer")).error).toContain("PH_LAST_ADMIN");
    expect(await roleOf(XYZ, B)).toBe("admin");
    expect(await records(XYZ)).toEqual([]);
  });

  it("an admin cannot make themselves a viewer", async () => {
    expect((await setRole(A, ABC, A, "viewer")).error).toContain("PH_NOT_YOURSELF");
    expect(await roleOf(ABC, A)).toBe("admin");
  });

  it("refuses the same role, someone who is not a member, and a wrong role", async () => {
    expect((await setRole(A, ABC, V, "viewer")).error).toContain("PH_SAME_ROLE");
    expect((await setRole(A, ABC, O, "viewer")).error).toContain("PH_NOT_FOUND");
    expect((await setRole(A, ABC, V, "owner")).error).toContain("PH_INVALID_INPUT");
    expect(await records()).toEqual([]);
  });

  it("a viewer's role in one company is not touched by a change in another", async () => {
    await setRole(A, ABC, C, "viewer");
    expect(await roleOf(XYZ, A)).toBe("viewer");
  });
});

describe("0021: removing", () => {
  it("removes a member and records it", async () => {
    await remove(A, ABC, V);
    expect(await roleOf(ABC, V)).toBeUndefined();
    expect(await records()).toMatchObject([
      { action: "removed", member_id: V, member_email: "v@example.com", old_role: "viewer", changed_by: A },
    ]);
  });

  it("can remove another admin", async () => {
    await remove(A, ABC, C);
    expect(await roleOf(ABC, C)).toBeUndefined();
  });

  it("an admin cannot remove themselves", async () => {
    expect((await remove(A, ABC, A)).error).toContain("PH_NOT_YOURSELF");
    expect(await roleOf(ABC, A)).toBe("admin");
  });

  it("the last admin can never be removed", async () => {
    expect((await remove(B, XYZ, B)).error).toContain("PH_LAST_ADMIN");
    expect(await roleOf(XYZ, B)).toBe("admin");
  });

  it("two admins cannot remove each other down to none", async () => {
    await remove(A, ABC, C);
    expect((await remove(C, ABC, A)).error).toContain("PH_NOT_ADMIN");
    expect(await roleOf(ABC, A)).toBe("admin");
  });

  it("refuses someone who is not a member", async () => {
    expect((await remove(A, ABC, O)).error).toContain("PH_NOT_FOUND");
  });

  it("a record still reads the same after that account is deleted", async () => {
    await remove(A, ABC, V);
    await db.exec(`delete from auth.users where id = '${V}'`);
    expect(await records()).toMatchObject([{ member_id: null, member_email: "v@example.com" }]);
  });

  it("the records go with the company", async () => {
    await remove(A, ABC, V);
    await db.exec(`delete from public.companies where id = '${ABC}'`);
    expect(await records()).toEqual([]);
  });
});
