import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { useStore } from "@/lib/store";
import {
  fetchCompanyLists,
  saveCompanyLists,
  type AppList,
  type ListChange,
} from "@/lib/supabase/companyLists";
import { classifyDataError } from "@/lib/supabase/errors";
import { CompanyPicker, type PickerLoad } from "./CompanyPicker";
import { saveFailureText, savedText } from "./pickerText";
import { pickerRequest, reloadApp, setCompanyOpener } from "./companyListData";
import { choiceFrom, countsOf, type Choice, type PickerCompany } from "./pickerModel";

/**
 * Shows the company picker when an app asks for it (companyListData.ts), and saves it. After a
 * save, that app's frame starts again so it shows the new list. Renders nothing otherwise.
 */
export function CompanyPickerHost() {
  const request = useStore(pickerRequest);
  if (!request) return null;
  return <OpenPicker key={`${request.appId}`} appId={request.appId} lists={request.lists} />;
}

function OpenPicker({ appId, lists }: { appId: string; lists: readonly AppList[] }) {
  const { user } = useAuth();
  const { memberships } = useCompany();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const viewer = user ? { id: user.id, isDemo: user.isDemo } : null;

  const companies = useMemo<PickerCompany[]>(
    () =>
      memberships.map(({ company, role }) => ({
        id: company.id,
        name: company.name,
        brn: company.brn ?? "",
        admin: role === "admin",
      })),
    [memberships],
  );
  const ids = companies.map((one) => one.id);

  const query = useQuery({
    queryKey: ["company-lists", user?.id, ids],
    queryFn: () => fetchCompanyLists(viewer!, ids),
    enabled: viewer !== null,
    // Always read again when the picker opens: someone else may have changed a list.
    staleTime: 0,
    gcTime: 0,
  });

  const loaded = useMemo<Choice | null>(
    () => (query.data ? choiceFrom(query.data, lists) : null),
    [query.data, lists],
  );

  const load: PickerLoad = query.error
    ? {
        status: "failed",
        failure: classifyDataError(query.error),
        retry: () => void query.refetch(),
      }
    : loaded
      ? { status: "ready", companies, loaded }
      : { status: "loading" };

  const close = () => pickerRequest.set(null);

  // Signing out or switching user closes it (the session cleanup also does).
  useEffect(() => {
    if (!user) close();
  }, [user]);

  const save = async (changes: ListChange[], chosen: Choice) => {
    if (!viewer) return;
    setSaving(true);
    try {
      await saveCompanyLists(viewer, changes);
      toast.success(savedText(appId, lists, countsOf(chosen, companies, lists)));
      void queryClient.invalidateQueries({ queryKey: ["company-lists"] });
      close();
      reloadApp(appId);
    } catch (error) {
      toast.error(saveFailureText(error));
      setSaving(false);
    }
  };

  return (
    <CompanyPicker
      appId={appId}
      lists={lists}
      load={load}
      saving={saving}
      onClose={close}
      onSave={(changes, chosen) => void save(changes, chosen)}
    />
  );
}

/** Lets an app's `open-company` request select a company in the dashboard. Renders nothing. */
export function CompanyOpener() {
  const { select } = useCompany();
  useEffect(() => setCompanyOpener((companyId) => select(companyId)), [select]);
  return null;
}
