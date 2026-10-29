import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCompany } from "@/features/company/company-context";
import { setProfileOpener } from "./openProfile";

/**
 * Lets an app's request show a company's Company profile (openProfile.ts). Another company is
 * selected first, the usual way: the user is asked if an app holds unsaved changes, and the apps
 * reload. Renders nothing.
 */
export function ProfileOpener() {
  const { current, select } = useCompany();
  const navigate = useNavigate();
  const currentId = current?.company.id ?? null;

  useEffect(
    () =>
      setProfileOpener((companyId) => {
        if (companyId === currentId) navigate("/profile");
        else select(companyId, { afterwards: () => navigate("/profile") });
      }),
    [currentId, select, navigate],
  );
  return null;
}
