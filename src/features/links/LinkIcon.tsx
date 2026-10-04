import { DEFAULT_ICON, LINK_ICONS } from "./icons";

/** The bundled icon for a stored key. An unknown key gets the default icon. */
export function LinkIcon({ name, className }: { name: string | null; className?: string }) {
  const Icon = (LINK_ICONS[name ?? ""] ?? LINK_ICONS[DEFAULT_ICON]!).icon;
  return <Icon className={className} aria-hidden="true" />;
}
