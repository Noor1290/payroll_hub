import { useId } from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/misc";
import {
  companyLine,
  isEmployeeTickable,
  monthName,
  notInFileLine,
  type EmployeePreview,
  type EmployeesPreview as Preview,
} from "./employeeImport";

// The "Employees" part of the import preview (EMPLOYEES_IMPORT_PLAN.md, Stage 2): one block per
// company, with the month its employees go into and what each row will do. Ticks are kept by the
// dialog, by row number.

const SELECT_CLASS =
  "h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-inner-glow hover:border-line-strong disabled:opacity-50 sm:w-56";
const CHECKBOX_CLASS =
  "size-4 cursor-pointer rounded accent-(--accent) disabled:cursor-not-allowed";

const BADGE: Record<
  EmployeePreview["status"],
  { tone: "accent" | "neutral" | "warn" | "danger"; text: string }
> = {
  new: { tone: "accent", text: "New" },
  update: { tone: "warn", text: "Update" },
  same: { tone: "neutral", text: "No changes" },
  problem: { tone: "danger", text: "Problem" },
};

function rowNote(item: EmployeePreview): { tone: "muted" | "warn" | "danger"; text: string }[] {
  const notes: { tone: "muted" | "warn" | "danger"; text: string }[] = [];
  for (const problem of item.problems) notes.push({ tone: "danger", text: problem });
  if (item.warning) notes.push({ tone: "warn", text: item.warning });
  if (item.status === "new" && item.changes.length > 0) {
    notes.push({
      tone: "muted",
      text: item.changes.map((c) => `${c.heading} ${c.after}`).join(" · "),
    });
  }
  if (item.status === "update") {
    notes.push({
      tone: "muted",
      text: `Changes: ${item.changes.map((c) => `${c.heading}: ${c.before} → ${c.after}`).join("; ")}`,
    });
  }
  return notes;
}

export function EmployeesPreview({
  preview,
  ticked,
  onTick,
  startPeriod,
  startMonths,
  onStart,
  disabled,
}: {
  preview: Preview;
  ticked: (item: EmployeePreview) => boolean;
  onTick: (line: number, value: boolean) => void;
  startPeriod: string;
  startMonths: string[];
  onStart: (period: string) => void;
  disabled: boolean;
}) {
  const startId = useId();
  const needsStart = preview.companies.some((company) => company.newMonth);
  return (
    <section className="space-y-3" aria-labelledby={`${startId}-title`}>
      <h3 id={`${startId}-title`} className="text-sm font-semibold text-fg">
        Employees
      </h3>
      {needsStart && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={startId} className="text-sm text-fg">
            Companies with no saved month start in:
          </label>
          <select
            id={startId}
            className={SELECT_CLASS}
            value={startPeriod}
            disabled={disabled}
            onChange={(event) => onStart(event.target.value)}
          >
            {startMonths.map((period) => (
              <option key={period} value={period}>
                {monthName(period)}
              </option>
            ))}
          </select>
        </div>
      )}
      {preview.notices.map((notice) => (
        <p key={notice} className="flex items-start gap-2 text-xs text-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      ))}
      <div className="max-h-[46vh] overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-elevated text-xs text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="w-10 px-3 py-2">
                <span className="sr-only">Add or update</span>
              </th>
              <th scope="col" className="w-12 px-2 py-2">
                Row
              </th>
              <th scope="col" className="px-2 py-2">
                Employee
              </th>
              <th scope="col" className="px-2 py-2">
                What happens
              </th>
            </tr>
          </thead>
          {preview.companies.map((company) => {
            const away = notInFileLine(company);
            return (
              <tbody key={company.brn || "(no BRN)"}>
                <tr className="border-b border-line bg-surface">
                  <th scope="rowgroup" colSpan={4} className="px-3 py-2 text-left">
                    <span
                      className={`block text-sm font-medium ${company.problem ? "text-danger" : "text-fg"}`}
                    >
                      {companyLine(company)}
                    </span>
                    {away && <span className="block text-xs font-normal text-muted">{away}</span>}
                  </th>
                </tr>
                {company.rows.map((item) => {
                  const badge = item.warning
                    ? { tone: "warn" as const, text: "Warning" }
                    : BADGE[item.status];
                  return (
                    <tr
                      key={item.row.line}
                      className="border-b border-line align-top last:border-b-0"
                    >
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          className={CHECKBOX_CLASS}
                          aria-label={`${item.status === "update" ? "Update" : "Add"} row ${item.row.line}${item.label ? `, ${item.label}` : ""}`}
                          checked={ticked(item)}
                          disabled={disabled || !isEmployeeTickable(item)}
                          onChange={(event) => onTick(item.row.line, event.target.checked)}
                        />
                      </td>
                      <td className="tabular px-2 py-2.5 text-muted">{item.row.line}</td>
                      <td className="px-2 py-2.5 font-medium text-fg">
                        {item.label || "(no name)"}
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone={badge.tone}>{badge.text}</Badge>
                        {rowNote(item).map((note) => (
                          <p
                            key={note.text}
                            className={`mt-1 text-xs ${note.tone === "danger" ? "text-danger" : note.tone === "warn" ? "text-warn" : "text-muted"}`}
                          >
                            {note.text}
                          </p>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}
