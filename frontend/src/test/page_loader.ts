import type { ComponentType } from "react";

interface ViteImportMeta {
  glob?: (pattern: string, options?: { eager?: boolean }) => Record<string, { default?: ComponentType; [key: string]: unknown }>;
}

/**
 * Dynamically resolves a page component if implemented.
 * Allows progressive testability across M1, M2, M3, M4, and M5 without compile-time module missing errors.
 */
export function getPageModule(pageName: "DatabasePage" | "AspenPage" | "EmsPage"): ComponentType | null {
  const meta = import.meta as unknown as ViteImportMeta;
  if (!meta.glob) return null;
  try {
    const pages = meta.glob("../pages/*.tsx", { eager: true });
    const direct = pages[`../pages/${pageName}.tsx`];
    if (direct?.default) return direct.default;
    if (direct?.[pageName]) return direct[pageName] as ComponentType;
  } catch {
    return null;
  }
  return null;
}
