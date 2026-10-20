/** Data for the chat's wide-mode side panel and the MCP icon in the bottom bar. */

export interface McpServerSummary {
  name: string;
  status: string;
  tools: number;
  remote: boolean;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface ChangesSummary {
  branch: string | null;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface SidePanelData {
  mcp?: McpServerSummary[];
  changes?: ChangesSummary | null;
}

interface RpcLike {
  call<T>(method: string, params: any, timeoutMs?: number): Promise<T>;
}

export type SidePanelPart = "mcp" | "changes";

/** At most this many files are listed; the totals still count every file. */
export const MAX_LISTED_FILES = 12;

export async function loadSidePanelData(rpc: RpcLike, projectPath: string, parts: SidePanelPart[]): Promise<SidePanelData> {
  const data: SidePanelData = {};
  const tasks: Promise<void>[] = [];
  if (parts.includes("mcp")) {
    tasks.push(rpc.call<any[]>("mcp.list", { project_path: projectPath }, 10000).then((servers) => {
      data.mcp = (Array.isArray(servers) ? servers : []).map((s) => ({
        name: String(s?.name || ""),
        status: s?.disabled ? "disabled" : String(s?.status || "unknown"),
        tools: Number(s?.tools_count) || 0,
        remote: Boolean(s?.remote),
      })).filter((s) => s.name);
    }).catch(() => { data.mcp = []; }));
  }
  if (parts.includes("changes")) {
    tasks.push(Promise.all([
      rpc.call<any>("git.status", { project_path: projectPath }),
      rpc.call<any>("git.diff_numstat", { project_path: projectPath }).catch(() => ({ files: {} })),
    ]).then(([status, numstat]) => {
      if (!status?.is_git) {
        data.changes = null;
        return;
      }
      const counts: Record<string, { additions?: number; deletions?: number; binary?: boolean }> = numstat?.files || {};
      const listed: { path: string; status: string }[] = Array.isArray(status.files) && status.files.length
        ? status.files
        : [...(status.modified_files || []).map((p: string) => ({ path: p, status: "M" })),
           ...(status.untracked_files || []).map((p: string) => ({ path: p, status: "U" }))];
      let additions = 0;
      let deletions = 0;
      const files = listed.map((f) => {
        const c = counts[f.path];
        const add = c && !c.binary ? Number(c.additions) || 0 : null;
        const del = c && !c.binary ? Number(c.deletions) || 0 : null;
        additions += add || 0;
        deletions += del || 0;
        return { path: f.path, status: f.status, additions: add, deletions: del };
      });
      files.sort((a, b) => ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0)));
      data.changes = { branch: status.branch || null, files, additions, deletions };
    }).catch(() => { data.changes = null; }));
  }
  await Promise.all(tasks);
  return data;
}

/** Tooltip for the bottom-bar MCP icon. */
export function mcpTooltip(servers: McpServerSummary[] | undefined): string {
  if (!servers || !servers.length) return "MCP servers: none set up. Open MCP settings";
  const running = servers.filter((s) => s.status === "running").length;
  const attention = servers.filter((s) => s.status === "needs_auth" || s.status === "error").length;
  const parts = [`${running} of ${servers.length} running`];
  if (attention) parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
  return `MCP servers: ${parts.join(", ")}. Open MCP settings`;
}
