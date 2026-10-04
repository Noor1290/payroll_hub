import {
  AppWindow,
  ArrowLeftRight,
  Building2,
  History,
  LayoutDashboard,
  Link2,
  Lock,
  ScrollText,
  Settings,
  Table2,
  Upload,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line describing the screen, searchable in the command palette. */
  description: string;
  /** Shown only to admins of the selected company. The screen itself checks again. */
  adminOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    to: "/",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Headline figures, recent runs and live app status.",
  },
  {
    to: "/import",
    label: "Import",
    icon: Upload,
    description: "Drop payroll JSON files, check them, and save them as a run.",
  },
  {
    to: "/explorer",
    label: "Data explorer",
    icon: Table2,
    description: "Browse a run's employees and figures in a grid.",
  },
  {
    to: "/transfer",
    label: "Transfer",
    icon: ArrowLeftRight,
    description: "Pick rows and columns, map them, and send them to an app.",
  },
  {
    to: "/workspace",
    label: "Workspace",
    icon: AppWindow,
    description: "The connected apps, side by side in tabs.",
  },
  {
    to: "/log",
    label: "Transfer log",
    icon: ScrollText,
    description: "What was sent where during this session.",
  },
  {
    to: "/links",
    label: "Links",
    icon: Link2,
    description: "The selected company's useful websites, as cards.",
  },
  {
    to: "/profile",
    label: "Company profile",
    icon: Building2,
    description: "The selected company's name, BRN, address and other details.",
  },
  {
    to: "/history",
    label: "History",
    icon: History,
    description: "Every payroll run for the selected company.",
  },
  {
    to: "/database",
    label: "Database",
    icon: Lock,
    description: "A read-only look at the raw tables. Admins only.",
    adminOnly: true,
  },
  {
    to: "/settings",
    label: "Settings",
    icon: Settings,
    description: "Theme, lock and sign-out times, saved mappings and the app list.",
  },
];

/** The navigation a user should see: admin-only items are left out for everyone else. */
export function navItemsFor(isAdmin: boolean): readonly NavItem[] {
  return isAdmin ? NAV_ITEMS : NAV_ITEMS.filter((item) => !item.adminOnly);
}

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent);
export const PALETTE_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";
