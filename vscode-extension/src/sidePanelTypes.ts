export type SidePanelCardId = "context" | "changes" | "mcp" | "env";

export interface SidePanelPreferences {
  order: SidePanelCardId[];
  hidden: SidePanelCardId[];
  collapsed: SidePanelCardId[];
  breakdown: boolean;
}
