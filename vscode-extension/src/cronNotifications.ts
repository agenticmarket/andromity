export interface CronToast {
  level: "info" | "warning" | "error";
  text: string;
  actions: string[];
}

const DEFAULT_NOTIFY = "failures";

/** Decide the editor notification for a finished cron run, honouring the job's notify setting. */
export function cronRunToast(params: any): CronToast | null {
  const job = params?.job || {};
  const run = params?.run || {};
  const notify: string = job.notify || DEFAULT_NOTIFY;
  if (notify === "never") return null;

  const name = job.name || run.job_name || "Scheduled job";
  const status: string = run.status || "success";
  const seconds = run.duration_ms ? (run.duration_ms / 1000).toFixed(1) : "0";
  const reason = run.error ? ` ${run.error}` : "";
  const actions = run.session_id ? ["Open Session", "Open Cron Jobs"] : ["Open Cron Jobs"];

  switch (status) {
    case "success":
      return notify === "always" ? { level: "info", text: `Cron "${name}" completed in ${seconds}s.`, actions } : null;
    case "needs_attention":
      return { level: "warning", text: `Cron "${name}" needs attention.${reason}`, actions };
    case "timeout":
      return { level: "warning", text: `Cron "${name}" timed out.${reason}`, actions };
    case "skipped":
      return { level: "warning", text: `Cron "${name}" was skipped.${reason}`, actions };
    case "failed":
      return { level: "error", text: `Cron "${name}" failed.${reason || " Error during execution."}`, actions };
    default:
      return null;
  }
}

/** Daemon text when a message is sent into a scheduled run that is still going. */
export const SCHEDULED_RUN_BUSY = "scheduled run is still in progress";
export const SCHEDULED_RUN_BUSY_TEXT = "This scheduled run is still in progress. You can continue the chat when it finishes.";
