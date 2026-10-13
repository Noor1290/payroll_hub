// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_STAND_IN } from "@/test/storageStandIn";

/**
 * Runs migrations 0001 to 0012 in a real Postgres (PGlite) and uses 0012 the way the Data API
 * and the Storage service do: as the role "authenticated" (or "anon") with a user id in the
 * request claims. Storage itself is a stand-in (src/test/storageStandIn.ts): its two tables,
 * with row level security on the files.
 *
 * Fake data only.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const A = "00000000-0000-4000-8000-0000000000a1"; // admin of ABC and of NEW, viewer of XYZ
const V = "00000000-0000-4000-8000-0000000000a2"; // viewer of ABC
const O = "00000000-0000-4000-8000-0000000000a3"; // member of nothing
const B = "00000000-0000-4000-8000-0000000000a4"; // admin of XYZ only
const ABC = "10000000-0000-4000-8000-000000000001";
const XYZ = "10000000-0000-4000-8000-000000000002";
const NEW = "10000000-0000-4000-8000-000000000003";
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const T3 = "20000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const SETUP_TIMEOUT = 120_000;
const BODY = { boxes: [{ id: "b1", name: "Surname", x: 10, y: 20 }], employerFields: [] };

const SUPABASE_STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create role migration_owner nologin nosuperuser bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, migration_owner;
  grant references on auth.users to migration_owner;
  alter schema public owner to migration_owner;
  ${STORAGE_STAND_IN}
`;

const SEED = `
  insert into auth.users (id) values ('${A}'), ('${V}'), ('${O}'), ('${B}');
  insert into public.companies (id, name, brn) values
    ('${ABC}', 'ABC Co Ltd', 'C1'), ('${XYZ}', 'XYZ Trading Ltd', 'C2'), ('${NEW}', 'New Venture Ltd', 'C3');
  insert into public.company_members (company_id, user_id, role) values
    ('${ABC}', '${A}', 'admin'), ('${ABC}', '${V}', 'viewer'),
    ('${XYZ}', '${B}', 'admin'), ('${XYZ}', '${A}', 'viewer'),
    ('${NEW}', '${A}', 'admin');
`;

async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STAND_INS);
  for (const { sql } of migrations) {
    await db.exec(`set role migration_owner; ${sql}; reset role;`);
  }
  await db.exec(SEED);
  return db;
}

type Role = "authenticated" | "anon";
type Outcome<T> = { result: T; error: null } | { result: null; error: string };

async function as<T>(
  db: PGlite,
  role: Role,
  user: string | null,
  work: () => Promise<T>,
): Promise<Outcome<T>> {
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

function one<T>(
  db: PGlite,
  user: string | null,
  sql: string,
  params: unknown[] = [],
  role: Role = "authenticated",
) {
  return as(db, role, user, async () => {
    const { rows } = await db.query<{ result: T }>(sql, params);
    return rows[0]?.result as T;
  });
}

async function scalar<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ result: T }>(sql, params);
  return rows[0]!.result;
}

const filePath = (company: string, sha = SHA) => `${company}/${sha}.pdf`;

/** Uploads a file the way the Storage service does: one row, as the signed-in user. */
const upload = (db: PGlite, user: string | null, name: string, role: Role = "authenticated") =>
  as(db, role, user, () =>
    db.query("insert into storage.objects (bucket_id, name, owner) values ('pdf-forms', $1, $2)", [
      name,
      user,
    ]),
  );

interface Save {
  company?: string;
  id?: string;
  name?: string;
  body?: unknown;
  expected?: number;
  sha?: string;
  file?: string;
  bytes?: number;
  pages?: number;
}
interface Saved {
  template_id: string;
  name: string;
  revision: number;
}
const save = (db: PGlite, user: string | null, s: Save = {}, role: Role = "authenticated") =>
  one<Saved>(
    db,
    user,
    `select public.save_pdf_template($1::uuid, $2::uuid, $3, $4::jsonb, $5::int, $6, $7, $8::int, $9::int) as result`,
    [
      s.company ?? ABC,
      s.id ?? T1,
      s.name ?? "Statement of Emoluments",
      JSON.stringify(s.body ?? BODY),
      s.expected ?? 0,
      s.sha ?? SHA,
      s.file ?? "form.pdf",
      s.bytes ?? 983,
      s.pages ?? 1,
    ],
    role,
  );

const count = (db: PGlite, table: string, where = "true") =>
  scalar<number>(db, `select count(*)::int as result from ${table} where ${where}`);

describe("migration 0012: its own check", () => {
  it(
    "ends with one row in which every column is true, and can be run again",
    async () => {
      const db = await freshDatabase();
      const sql = migrations.find((m) => m.name.startsWith("0012"))!.sql;
      const results = await db.exec(`set role migration_owner; ${sql}; reset role;`);
      const row = results.filter((r) => r.rows.length === 1 && r.fields.length > 3).at(-1)!
        .rows[0] as Record<string, unknown>;
      expect(Object.keys(row).length).toBeGreaterThanOrEqual(14);
      for (const [column, value] of Object.entries(row)) expect(value, column).toBe(true);
      // Run twice: still exactly one bucket.
      expect(await count(db, "storage.buckets", "id = 'pdf-forms'")).toBe(1);
      await db.close();
    },
    SETUP_TIMEOUT,
  );

  it(
    "adds only: no earlier table, column or row is touched by the file",
    () => {
      const sql = migrations
        .find((m) => m.name.startsWith("0012"))!
        .sql.replace(/\r\n/g, "\n")
        .replace(/--.*$/gm, "");
      expect(sql).not.toMatch(/\bdrop\s+(table|column|schema|index|function|type)\b/i);
      expect(sql).not.toMatch(/\balter\s+table\s+public\.(?!pdf_templates|pdf_template_history)/i);
      // ("truncate" does appear, as a privilege name in the verification query.)
      expect(sql).not.toMatch(/\btruncate\s+(table\s+)?\w+\./i);
      // The only "create or replace" of something that existed before is delete_company.
      const replaced = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map(
        (m) => m[1],
      );
      expect(replaced.sort()).toEqual([
        "copy_pdf_template",
        "delete_company",
        "delete_pdf_template",
        "pdf_form_company",
        "restore_pdf_template",
        "save_pdf_template",
      ]);
      // Deletes and updates only inside functions, and only on the new tables or, in
      // delete_company, as in 0011.
      const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "");
      expect(outside).not.toMatch(/\b(delete\s+from|update)\s+public\./i);
    },
    SETUP_TIMEOUT,
  );
});

describe("the bucket's rules (stand-in for Storage)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("lets an admin add a file under their own company, and nobody else", async () => {
    expect((await upload(db, V, filePath(ABC))).error).toMatch(/row-level security/);
    expect((await upload(db, O, filePath(ABC))).error).toMatch(/row-level security/);
    expect((await upload(db, B, filePath(ABC))).error).toMatch(/row-level security/);
    expect((await upload(db, null, filePath(ABC), "anon")).error).toMatch(
      /permission denied|row-level security/,
    );
    expect((await upload(db, A, filePath(ABC))).error).toBeNull();
    // A viewer of XYZ cannot add there either.
    expect((await upload(db, A, filePath(XYZ))).error).toMatch(/row-level security/);
  });

  it("refuses any path that is not <company id>/<sha-256>.pdf", async () => {
    for (const name of [
      `${ABC}/notes.pdf`,
      `${ABC}/${SHA}.txt`,
      `${ABC}/sub/${SHA}.pdf`,
      `${SHA}.pdf`,
      `${ABC}/${SHA.toUpperCase()}.pdf`,
      `../${ABC}/${SHA}.pdf`,
    ]) {
      expect((await upload(db, A, name)).error, name).toMatch(/row-level security/);
    }
  });

  it("lets members of the company see its files, and nobody else", async () => {
    const seenBy = async (user: string) =>
      (
        await as(db, "authenticated", user, async () => {
          const { rows } = await db.query<{ name: string }>("select name from storage.objects");
          return rows.map((r) => r.name);
        })
      ).result;
    expect(await seenBy(A)).toEqual([filePath(ABC)]);
    expect(await seenBy(V)).toEqual([filePath(ABC)]);
    expect(await seenBy(B)).toEqual([]);
    expect(await seenBy(O)).toEqual([]);
  });

  it("has no way to change a stored file, and only an admin can remove one", async () => {
    const change = (user: string) =>
      as(db, "authenticated", user, async () => {
        const result = await db.query(
          "update storage.objects set name = $1 where name = $2 returning name",
          [filePath(ABC, SHA_2), filePath(ABC)],
        );
        return result.rows.length;
      });
    expect((await change(A)).result).toBe(0);
    const remove = (user: string) =>
      as(db, "authenticated", user, async () => {
        const result = await db.query(
          "delete from storage.objects where name = $1 returning name",
          [filePath(ABC)],
        );
        return result.rows.length;
      });
    expect((await remove(V)).result).toBe(0);
    expect((await remove(B)).result).toBe(0);
    expect(await count(db, "storage.objects")).toBe(1);
    expect((await remove(A)).result).toBe(1);
  });
});

describe("save_pdf_template", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDatabase();
    await upload(db, A, filePath(ABC));
    await upload(db, B, filePath(XYZ));
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("is for admins of that company only", async () => {
    expect((await save(db, V)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await save(db, O)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await save(db, B)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await save(db, A, { company: XYZ })).error).toMatch(/PH_NOT_ADMIN/);
    expect((await save(db, null, {}, "anon")).error).toMatch(/permission denied/);
    expect(await count(db, "public.pdf_templates")).toBe(0);
  });

  it("refuses a template whose file is not in the bucket for that company", async () => {
    expect((await save(db, A, { sha: SHA_2 })).error).toMatch(/PH_NO_FILE/);
    expect(await count(db, "public.pdf_templates")).toBe(0);
  });

  it("creates at revision 1 with the id the app chose, stores the body exactly, and keeps the revision", async () => {
    const saved = await save(db, A);
    expect(saved.error).toBeNull();
    expect(saved.result).toMatchObject({
      template_id: T1,
      name: "Statement of Emoluments",
      revision: 1,
    });
    expect(
      await scalar(db, "select body as result from public.pdf_templates where id = $1", [T1]),
    ).toEqual(BODY);
    expect(await count(db, "public.pdf_template_history", `template_id = '${T1}'`)).toBe(1);
  });

  it("stores the same save once when it is sent twice", async () => {
    // The second copy of a new template's save says "revision 0" again: refused, not doubled.
    expect((await save(db, A)).error).toMatch(/PH_STALE/);
    expect(await count(db, "public.pdf_templates")).toBe(1);
  });

  it("refuses a save that carries an old revision, and never overwrites", async () => {
    const changed = { boxes: [], employerFields: [{ id: "tan", label: "TAN", value: "T1" }] };
    expect((await save(db, A, { expected: 1, body: changed })).result).toMatchObject({
      revision: 2,
    });
    const stale = await save(db, A, { expected: 1, body: { boxes: ["someone else's old copy"] } });
    expect(stale.error).toMatch(/PH_STALE/);
    expect(
      await scalar(db, "select body as result from public.pdf_templates where id = $1", [T1]),
    ).toEqual(changed);
  });

  it("refuses bad input: name, body, size, hash, file name, pages", async () => {
    const bad: [Save, RegExp][] = [
      [{ name: "   " }, /PH_INVALID_INPUT/],
      [{ name: "x".repeat(81) }, /PH_INVALID_INPUT/],
      [{ body: [1, 2] }, /PH_INVALID_INPUT/],
      [{ body: { text: "x".repeat(263_000) } }, /PH_TOO_LARGE/],
      [{ sha: "ABC" }, /PH_INVALID_INPUT/],
      [{ file: "" }, /PH_INVALID_INPUT/],
      [{ bytes: 0 }, /PH_INVALID_INPUT/],
      [{ bytes: 5_242_881 }, /PH_INVALID_INPUT/],
      [{ pages: 0 }, /PH_INVALID_INPUT/],
      [{ expected: -1 }, /PH_INVALID_INPUT/],
    ];
    for (const [input, error] of bad) {
      expect(
        (await save(db, A, { id: T2, ...input })).error,
        JSON.stringify(input).slice(0, 60),
      ).toMatch(error);
    }
    expect(await count(db, "public.pdf_templates")).toBe(1);
  });

  it("keeps names unique in a company whatever the capitals, and lets another company use the name", async () => {
    expect((await save(db, A, { id: T2, name: "STATEMENT OF EMOLUMENTS" })).error).toMatch(
      /PH_DUPLICATE_NAME/,
    );
    expect((await save(db, B, { company: XYZ, id: T3 })).error).toBeNull();
  });

  it("does not let one company save over another company's template", async () => {
    const attempt = await save(db, A, { id: T3, expected: 1, name: "Taken over" });
    expect(attempt.error).toMatch(/PH_NOT_FOUND/);
    expect(
      await scalar(db, "select name as result from public.pdf_templates where id = $1", [T3]),
    ).toBe("Statement of Emoluments");
  });

  it("lets members read their company's templates and history, and nobody write directly", async () => {
    const seen = (user: string | null, role: Role = "authenticated") =>
      one<number>(db, user, "select count(*)::int as result from public.pdf_templates", [], role);
    expect((await seen(A)).result).toBe(2); // admin of ABC, viewer of XYZ
    expect((await seen(V)).result).toBe(1);
    expect((await seen(O)).result).toBe(0);
    expect((await seen(null, "anon")).error).toMatch(/permission denied/);
    expect(
      (await one<number>(db, V, "select count(*)::int as result from public.pdf_template_history"))
        .result,
    ).toBe(2);
    expect(
      (await one<number>(db, O, "select count(*)::int as result from public.pdf_template_history"))
        .result,
    ).toBe(0);

    for (const sql of [
      `insert into public.pdf_templates (company_id, name, body, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages) values ('${ABC}', 'x', '{}', 1, '${SHA}', 'f.pdf', 1, 1)`,
      `update public.pdf_templates set name = 'x'`,
      `delete from public.pdf_templates`,
      `delete from public.pdf_template_history`,
    ]) {
      expect(
        (await as(db, "authenticated", A, () => db.query(sql))).error,
        sql.slice(0, 40),
      ).toMatch(/permission denied/);
    }
  });

  it("stops at 50 templates in a company", async () => {
    await db.exec(`
      insert into public.pdf_templates (company_id, name, body, revision, pdf_sha256, pdf_file_name, pdf_bytes, pdf_pages)
      select '${NEW}', 'Form ' || n, '{}', 1, '${SHA}', 'f.pdf', 1, 1 from generate_series(1, 50) n;
      insert into storage.objects (bucket_id, name) values ('pdf-forms', '${filePath(NEW)}');
    `);
    expect((await save(db, A, { company: NEW, id: T2, name: "One too many" })).error).toMatch(
      /PH_LIMIT/,
    );
  });

  it("keeps at most the last 200 revisions of a template", async () => {
    let revision = 2;
    for (let i = 0; i < 205; i++) {
      const saved = await save(db, A, { expected: revision, body: { boxes: [], n: i } });
      expect(saved.error).toBeNull();
      revision = saved.result!.revision;
    }
    expect(revision).toBe(207);
    expect(await count(db, "public.pdf_template_history", `template_id = '${T1}'`)).toBe(200);
    expect(
      await scalar(
        db,
        `select min(revision)::int as result from public.pdf_template_history where template_id = '${T1}'`,
      ),
    ).toBe(8);
  });
});

describe("restore, copy and delete", () => {
  let db: PGlite;
  const restore = (user: string, revision: number, expected: number, company = ABC) =>
    one<Saved & { restored_from: number }>(
      db,
      user,
      "select public.restore_pdf_template($1::uuid, $2::uuid, $3::int, $4::int) as result",
      [company, T1, revision, expected],
    );
  const copy = (user: string, to: string, newId: string, name = "Copied form", from = ABC) =>
    one<Saved>(
      db,
      user,
      "select public.copy_pdf_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5) as result",
      [from, T1, to, newId, name],
    );
  const remove = (user: string, expected: number, id = T1, company = ABC) =>
    one<{ file_still_used: boolean; pdf_sha256: string }>(
      db,
      user,
      "select public.delete_pdf_template($1::uuid, $2::uuid, $3::int) as result",
      [company, id, expected],
    );

  beforeAll(async () => {
    db = await freshDatabase();
    await upload(db, A, filePath(ABC));
    await save(db, A); // revision 1
    await save(db, A, { expected: 1, name: "Renamed form", body: { boxes: [], changed: true } }); // 2
  }, SETUP_TIMEOUT);
  afterAll(() => db.close());

  it("restore makes an earlier revision the newest one, for an admin who saw the latest", async () => {
    expect((await restore(V, 1, 2)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await restore(A, 1, 1)).error).toMatch(/PH_STALE/);
    expect((await restore(A, 9, 2)).error).toMatch(/PH_NOT_FOUND/);
    const restored = await restore(A, 1, 2);
    expect(restored.result).toMatchObject({
      revision: 3,
      restored_from: 1,
      name: "Statement of Emoluments",
    });
    expect(
      await scalar(db, "select body as result from public.pdf_templates where id = $1", [T1]),
    ).toEqual(BODY);
    // Nothing was lost: revision 2 is still kept.
    expect(await count(db, "public.pdf_template_history", `template_id = '${T1}'`)).toBe(3);
  });

  it("copy needs membership where it comes from, admin where it goes, and the file there", async () => {
    // B is not a member of ABC; V is not an admin of anything; A is only a viewer of XYZ.
    await upload(db, B, filePath(XYZ));
    expect((await copy(B, XYZ, T2)).error).toMatch(/PH_NOT_FOUND/);
    expect((await copy(V, NEW, T2)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await copy(A, XYZ, T2)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await copy(A, ABC, T2)).error).toMatch(/PH_INVALID_INPUT/);
    // The file has to be in the other company's folder first.
    expect((await copy(A, NEW, T2)).error).toMatch(/PH_NO_FILE/);
    await upload(db, A, filePath(NEW));
    const copied = await copy(A, NEW, T2);
    expect(copied.result).toMatchObject({ template_id: T2, name: "Copied form", revision: 1 });
    expect(
      await scalar(db, "select body as result from public.pdf_templates where id = $1", [T2]),
    ).toEqual(BODY);
    expect(
      await scalar(db, "select company_id as result from public.pdf_templates where id = $1", [T2]),
    ).toBe(NEW);
    // The same copy sent twice stores once; the original is untouched.
    expect((await copy(A, NEW, T2)).error).toMatch(/PH_STALE/);
    expect((await copy(A, NEW, T3)).error).toMatch(/PH_DUPLICATE_NAME/);
    expect(await count(db, "public.pdf_templates", `company_id = '${ABC}'`)).toBe(1);
  });

  it("delete removes the template and its history, and says whether the file is still used", async () => {
    expect((await remove(V, 3)).error).toMatch(/PH_NOT_ADMIN/);
    expect((await remove(A, 2)).error).toMatch(/PH_STALE/);
    expect((await remove(A, 1, T2, ABC)).error).toMatch(/PH_NOT_FOUND/);
    // A second template of ABC on the same file.
    expect((await save(db, A, { id: T3, name: "Second form" })).error).toBeNull();
    expect((await remove(A, 3)).result).toMatchObject({ file_still_used: true, pdf_sha256: SHA });
    expect(await count(db, "public.pdf_template_history", `template_id = '${T1}'`)).toBe(0);
    expect((await remove(A, 1, T3)).result).toMatchObject({ file_still_used: false });
    expect(await count(db, "public.pdf_templates", `company_id = '${ABC}'`)).toBe(0);
    // The copy in the other company is not affected.
    expect(await count(db, "public.pdf_templates", `company_id = '${NEW}'`)).toBe(1);
  });
});

describe("delete_company after 0012", () => {
  it(
    "removes the company's PDF templates and their history, counts them, and spares the other company's",
    async () => {
      const db = await freshDatabase();
      await upload(db, A, filePath(ABC));
      await upload(db, B, filePath(XYZ));
      await save(db, A);
      await save(db, A, { expected: 1 });
      await save(db, B, { company: XYZ, id: T3 });

      const deleted = await one<Record<string, unknown>>(
        db,
        A,
        "select public.delete_company($1::uuid, $2) as result",
        [ABC, "ABC Co Ltd"],
      );
      expect(deleted.error).toBeNull();
      expect(deleted.result).toMatchObject({ pdf_templates: 1, pdf_template_history: 2 });
      expect(await count(db, "public.pdf_templates")).toBe(1);
      expect(await count(db, "public.pdf_template_history")).toBe(1);
      expect(await count(db, "public.companies", `id = '${ABC}'`)).toBe(0);
      await db.close();
    },
    SETUP_TIMEOUT,
  );
});
