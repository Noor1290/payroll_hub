import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import withFigures from "../../samples/ABC Co Ltd-pdf-fill-2026-09.json?raw";
import withoutFigures from "../../samples/ABC Co Ltd-pdf-fill-2026-10.json?raw";
import { parsePayrollRows } from "@/features/import/parsePayroll";
import { PayrollTable } from "./PayrollTable";

afterEach(cleanup);

// FAKE values only.
function renderGrid(sample: string) {
  render(<PayrollTable rows={parsePayrollRows(JSON.parse(sample)).rows} caption="Sample" />);
  const table = screen.getByRole("table", { name: "Sample" });
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((header) => header.querySelector("button")?.textContent ?? "");
  /** The cells of one column, top to bottom, as text. */
  const column = (label: string) =>
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[headers.indexOf(label)]!.textContent);
  return { headers, column };
}

describe('PayrollTable: "Employee CSG" and "Employee NSF"', () => {
  it("shows each as one known column, masked until revealed, and not as an extra field", () => {
    const { headers, column } = renderGrid(withFigures);
    expect(headers.filter((label) => label === "Employee CSG")).toHaveLength(1);
    expect(headers.filter((label) => label === "Employee NSF")).toHaveLength(1);
    expect(headers.join("|")).not.toMatch(/employee_csg|employee_nsf/);
    expect(headers).toContain("Bonus (extra)");

    expect(new Set(column("Employee CSG"))).toEqual(new Set(["••••••"]));
    fireEvent.click(screen.getByRole("button", { name: "Reveal Employee CSG" }));
    // Sorted by surname: DOE comes first.
    expect(column("Employee CSG")[0]).toBe("Rs 279.53");
  });

  it("shows nothing, not Rs 0.00, for a run that does not have the figures", () => {
    const { column } = renderGrid(withoutFigures);
    fireEvent.click(screen.getByRole("button", { name: "Reveal Employee CSG" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal Employee NSF" }));
    expect(new Set(column("Employee CSG"))).toEqual(new Set([""]));
    expect(new Set(column("Employee NSF"))).toEqual(new Set([""]));
  });
});

describe("PayrollTable: date of employment", () => {
  const saved = parsePayrollRows(JSON.parse(withoutFigures)).rows.map((row, index) => ({
    ...row,
    employee_id: `30000000-0000-4000-8000-00000000000${index}`,
    date_of_employment: index === 0 ? "2019-03-04" : null,
  }));

  it("is not a column of an import preview, or of a database without the column", () => {
    const { headers } = renderGrid(withoutFigures);
    expect(headers).not.toContain("Date of employment");
  });

  it("shows the date or 'Not set', with no edit button for someone who may not change it", () => {
    render(<PayrollTable rows={saved} caption="Saved" />);
    const table = screen.getByRole("table", { name: "Saved" });
    expect(within(table).getByText("2019-03-04")).toBeTruthy();
    expect(within(table).getAllByText("Not set")).toHaveLength(saved.length - 1);
    expect(screen.queryByRole("button", { name: /date of employment of/ })).toBeNull();
  });

  it("gives an admin an edit button per employee, which reports that employee's row", () => {
    const edited: string[] = [];
    render(
      <PayrollTable rows={saved} caption="Saved" onEditDate={(row) => edited.push(row.surname)} />,
    );
    expect(screen.getAllByRole("button", { name: /date of employment of/ })).toHaveLength(
      saved.length,
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Change the date of employment of ${saved[0]!.surname}` }),
    );
    expect(edited).toEqual([saved[0]!.surname]);
  });
});
