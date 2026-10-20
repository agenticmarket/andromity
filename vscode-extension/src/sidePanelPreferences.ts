import type { SidePanelCardId, SidePanelPreferences } from "./sidePanelTypes.js";

/** Kept self-contained so the webview uses the same validation as the extension host. */
export function normalizeSidePanelPreferences(value: unknown): SidePanelPreferences {
  const ids: SidePanelCardId[] = ["context", "changes", "mcp", "env"];
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (entry: unknown): SidePanelCardId[] => {
    const result: SidePanelCardId[] = [];
    if (Array.isArray(entry)) {
      for (const id of entry) {
        if (ids.includes(id) && !result.includes(id)) result.push(id);
      }
    }
    return result;
  };
  const order = list(saved.order);
  return {
    order: [...order, ...ids.filter(id => !order.includes(id))],
    hidden: list(saved.hidden),
    collapsed: list(saved.collapsed),
    breakdown: saved.breakdown === true,
  };
}
