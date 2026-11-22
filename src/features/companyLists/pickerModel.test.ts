import { describe, expect, it } from "vitest";
import {
  changesBetween,
  choiceFrom,
  countsOf,
  hueOf,
  initialsOf,
  isSelected,
  setAll,
  shownCompanies,
  toggleCompany,
  toggleList,
  type PickerCompany,
} from "./pickerModel";

/** The picker's choice, before anything is saved. FAKE companies only. */
const A = "a";
const B = "b";
const C = "c";
const companies: PickerCompany[] = [
  { id: A, name: "ABC Co Ltd", brn: "C1234567", admin: true },
  { id: B, name: "Blue Lagoon Ltd", brn: "C7654321", admin: true },
  { id: C, name: "Coral Trading Ltd", brn: "C0000001", admin: false },
];

describe("the picker's choice", () => {
  it("starts as loaded, keeping only this app's lists", () => {
    const choice = choiceFrom(
      [
        { company_id: A, list: "payslips" },
        { company_id: B, list: "csg" },
      ],
      ["payslips"],
    );
    expect(isSelected(choice, A)).toBe(true);
    expect(isSelected(choice, B)).toBe(false);
  });

  it("a card switches every list on, then every list off", () => {
    const lists = ["csg", "prgf"] as const;
    let choice = toggleCompany(new Map(), A, lists);
    expect(countsOf(choice, companies, lists)).toMatchObject({ csg: 1, prgf: 1 });
    choice = toggleList(choice, A, "prgf");
    expect(countsOf(choice, companies, lists)).toMatchObject({ csg: 1, prgf: 0 });
    choice = toggleCompany(choice, A, lists);
    expect(isSelected(choice, A)).toBe(false);
  });

  it("saves only what changed, and never for a company the user is not an admin of", () => {
    const loaded = choiceFrom([{ company_id: A, list: "payslips" }], ["payslips"]);
    let chosen = setAll(loaded, companies, ["payslips"], true);
    expect(isSelected(chosen, C)).toBe(false);
    expect(changesBetween(loaded, chosen, companies, ["payslips"])).toEqual([
      { companyId: B, list: "payslips", on: true },
    ]);
    chosen = setAll(chosen, companies, ["payslips"], false);
    expect(changesBetween(loaded, chosen, companies, ["payslips"])).toEqual([
      { companyId: A, list: "payslips", on: false },
    ]);
    expect(changesBetween(loaded, loaded, companies, ["payslips"])).toEqual([]);
  });

  it("filters by name or BRN, and by the chips", () => {
    const choice = choiceFrom([{ company_id: B, list: "payroll" }], ["payroll"]);
    expect(shownCompanies(companies, choice, "lagoon", "all").map((one) => one.id)).toEqual([B]);
    expect(shownCompanies(companies, choice, "c000", "all").map((one) => one.id)).toEqual([C]);
    expect(shownCompanies(companies, choice, "", "selected").map((one) => one.id)).toEqual([B]);
    expect(shownCompanies(companies, choice, "", "not-selected").map((one) => one.id)).toEqual([
      A,
      C,
    ]);
  });
});

describe("the company circle", () => {
  it("shows two letters, leaving out Co, Ltd and the like", () => {
    expect(initialsOf("ABC Co Ltd")).toBe("AB");
    expect(initialsOf("Blue Lagoon Ltd")).toBe("BL");
    expect(initialsOf("The Coral (Mauritius) Ltd")).toBe("CM");
    expect(initialsOf("Ltd")).toBe("LT");
  });

  it("keeps the same colour for the same company", () => {
    expect(hueOf("C1234567")).toBe(hueOf("C1234567"));
    expect(new Set(companies.map((one) => hueOf(one.brn))).size).toBeGreaterThan(1);
  });
});
