import { describe, expect, it } from "vitest";

/**
 * delete_company removes rows table by table, by name. A table added in a later migration that
 * references companies (directly, or through a table that does) must therefore be added to
 * it. These tests read the migration files to catch a forgotten one. They do not run SQL: the
 * function's behaviour is tested in a real Postgres in deleteCompany.db.test.ts.
 */
const files = import.meta.glob<string>("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, sql]) => ({
    name: path.split("/").pop()!,
    sql: sql.replace(/\r\n/g, "\n").replace(/--.*$/gm, ""),
  }));
const everything = migrations.map((migration) => migration.sql).join("\n");

/** Each table and the tables it references. */
const tables = new Map<string, string[]>();
for (const [, name, body] of everything.matchAll(
  /create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g,
)) {
  tables.set(
    name!,
    [...body!.matchAll(/references public\.(\w+)/g)].map((match) => match[1]!),
  );
}

/** Tables whose rows belong to a company, directly or through another table, children first. */
function ownedByCompany(): string[] {
  const owned: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, references] of tables) {
      if (owned.includes(name) || name === "companies") continue;
      if (references.some((to) => to === "companies" || owned.includes(to))) {
        owned.push(name);
        grew = true;
      }
    }
  }
  return owned;
}

/** The newest definition of the function: later migrations replace earlier ones. */
const latest = migrations.filter((m) => m.sql.includes("function public.delete_company(")).at(-1)!;
const body = latest.sql.slice(
  latest.sql.indexOf("function public.delete_company("),
  latest.sql.indexOf("$$;"),
);
const position = (table: string) => body.search(new RegExp(`delete from public\\.${table}\\b`));

describe("delete_company in the migrations", () => {
  it("is defined last in 0007", () => {
    expect(latest.name).toBe("0007_delete_company_any_runs.sql");
  });

  it("finds the tables that belong to a company", () => {
    expect(ownedByCompany().sort()).toEqual(
      expect.arrayContaining([
        "company_details",
        "company_links",
        "company_members",
        "employees",
        "payroll_entries",
        "payroll_runs",
      ]),
    );
    // Every reference to companies is inside a "create table" this test understood. If this
    // fails, a reference was added another way (alter table): teach the test about it.
    const direct = [...tables.values()].flat().filter((to) => to === "companies").length;
    expect(everything.match(/references public\.companies/g)).toHaveLength(direct);
  });

  it("deletes from every table that belongs to a company, then the company", () => {
    for (const table of ownedByCompany()) {
      expect(position(table), `delete_company does not delete from ${table}`).toBeGreaterThan(-1);
      expect(position(table), `${table} must go before the company`).toBeLessThan(
        position("companies"),
      );
    }
    expect(position("companies")).toBeGreaterThan(-1);
  });

  it("deletes a table before the tables it references", () => {
    for (const table of ownedByCompany()) {
      for (const parent of tables.get(table)!.filter((to) => tables.has(to))) {
        expect(position(table), `${table} must go before ${parent}`).toBeLessThan(position(parent));
      }
    }
  });

  it("no longer looks at whether runs are approved", () => {
    expect(body).not.toContain("PH_HAS_APPROVED_RUNS");
    expect(body).not.toContain("approved");
    expect(body).not.toContain("deleted_at");
  });

  it("still checks the caller and the typed name itself", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("PH_NOT_SIGNED_IN");
    expect(body).toContain("m.role = 'admin'");
    expect(body).toContain("p_confirm_name text");
    // Trimmed on both sides, and compared as it is: no lower() or ilike.
    expect(body).toContain("btrim(p_confirm_name) <> btrim(v_company.name)");
    expect(body).not.toMatch(/lower\(|ilike/i);
    // The name is checked before anything is deleted.
    expect(body.indexOf("PH_NAME_MISMATCH")).toBeLessThan(body.indexOf("delete from"));
  });

  it("keeps the function for signed-in users only, and adds no direct delete on companies", () => {
    expect(latest.sql).toContain(
      "revoke all on function public.delete_company(uuid, text) from public, anon;",
    );
    expect(latest.sql).toContain(
      "grant execute on function public.delete_company(uuid, text) to authenticated;",
    );
    expect(everything).not.toMatch(
      /grant[^;]*\bdelete\b[^;]*on public\.(companies|company_members)\b/,
    );
    expect(everything).not.toMatch(
      /create policy[^;]*on public\.(companies|company_members)\s+for (delete|insert|all)/,
    );
  });
});
