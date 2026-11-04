import type { CreatedCompany, NewCompanyInput } from "@/features/company/companyImport";
import { demoCreateDetail, demoForgetCompanyData } from "./demoCompanyData";
import { demoCreateCompany, demoMemberships } from "./demoData";
import {
  demoAttachMraTemplate,
  demoForgetMraCompany,
  demoSaveMraCompanyDetails,
} from "./demoMraReturns";
import { demoAttachPayrollCompany, demoForgetPayrollSetups } from "./demoPayrollSetups";

/**
 * FAKE `create_company_with_details` (migration 0023) for dev-only demo mode and the dashboard's
 * own tests: the company, its details, its MRA details, its column setup and its MRA templates,
 * through the other demo stores with their rules; when one step fails, what was made is taken
 * away again, so the company is created fully or not at all. Only reachable behind
 * `import.meta.env.DEV`.
 */
export async function demoCreateCompanyWithDetails(
  input: NewCompanyInput,
): Promise<CreatedCompany> {
  const brn = input.brn.replace(/\s/g, "").toUpperCase();
  if (!demoMemberships.some((m) => m.role === "admin")) {
    throw Object.assign(new Error("PH_NOT_ADMIN"), { code: "42501" });
  }
  if (!/^[A-Z0-9]+$/.test(brn)) {
    throw Object.assign(new Error("PH_INVALID_INPUT: the BRN must be letters and digits only"), {
      code: "22023",
    });
  }
  if (demoMemberships.some((m) => (m.company.brn ?? "").replace(/\s/g, "").toUpperCase() === brn)) {
    throw Object.assign(new Error("PH_DUPLICATE_BRN"), { code: "23505" });
  }
  const company = await demoCreateCompany({
    name: input.name,
    address: input.address,
    brn,
    vat: input.vat,
  });
  try {
    for (const [order, detail] of input.details.entries()) {
      await demoCreateDetail(
        company.id,
        { label: detail.label, value: detail.value, field_type: "text", is_sensitive: false },
        order,
      );
    }
    if (Object.values(input.mra).some((value) => value.trim() !== "")) {
      await demoSaveMraCompanyDetails(company.id, { ...input.mra, expectedRevision: 0 });
    }
    if (input.sharedSetupId) {
      await demoAttachPayrollCompany(company.id, input.sharedSetupId, {
        columns: [],
        customFields: [],
      });
    }
    for (const templateId of input.mraTemplateIds)
      await demoAttachMraTemplate(templateId, company.id, {});
  } catch (error) {
    demoForgetCompanyData(company.id);
    demoForgetMraCompany(company.id);
    demoForgetPayrollSetups(company.id);
    demoMemberships.splice(
      demoMemberships.findIndex((m) => m.company.id === company.id),
      1,
    );
    throw error;
  }
  return { id: company.id, name: company.name, brn };
}
