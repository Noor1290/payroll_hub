import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/features/auth/auth-context";
import { fetchLinks } from "@/lib/supabase/companyData";

export const linksKey = (companyId: string, userId: string | undefined) =>
  ["company-links", companyId, userId] as const;

/**
 * A company's links. Always treated as stale, so the list is read again whenever the browser
 * tab regains focus: a link someone else added shows up without a reload.
 */
export function useCompanyLinks(companyId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: linksKey(companyId ?? "", user?.id),
    queryFn: () => fetchLinks({ id: user!.id, isDemo: user!.isDemo }, companyId!),
    enabled: enabled && user !== null && companyId !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
