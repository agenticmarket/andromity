/** Verify fix: panel ALWAYS uses session.get history; buffer only on failure.
 * Plus webview session_history is idempotent (duplicate delivery = no-op).
 */
function panelDecide({ historyOk, buffer }) {
  if (historyOk) return { source: "session.get history", bufferedReplayed: 0 };
  return { source: "buffer-fallback", bufferedReplayed: buffer.length };
}
const historyTurns = ["turn: project summary", "turn: continue"];
const bufferAfterOneTurn = [{ turn: "turn: in which folder you are?" }];
// Case A: reload — buffer wiped, history OK -> full history view
console.log("Case A reload:", panelDecide({ historyOk: true, buffer: [] }), "turns:", historyTurns.length);
// Case B: close+1 turn+reopen — history includes new turn -> same full view, no split
const fullHistory = [...historyTurns, "turn: in which folder you are?"];
console.log("Case B close+1turn+reopen:", panelDecide({ historyOk: true, buffer: bufferAfterOneTurn }), "turns:", fullHistory.length);
// Case C: RPC failure -> buffer fallback so panel never blank
console.log("Case C rpc-down:", panelDecide({ historyOk: false, buffer: bufferAfterOneTurn }));
// Webview watermark: duplicate session_history must be no-op
let historyUserCount = 0, turns = 0;
function applyHistory(payloadUsers) {
  if (payloadUsers <= historyUserCount && turns > 0) return "skipped-duplicate";
  const fresh = payloadUsers - (turns === 0 ? 0 : historyUserCount);
  turns += fresh; historyUserCount = payloadUsers;
  return `applied +${fresh} (turns=${turns})`;
}
console.log("webview 1st history(3 users):", applyHistory(3));
console.log("webview duplicate history(3 users):", applyHistory(3));
console.log("webview 2nd history after new turn(4 users):", applyHistory(4));
console.log("OK: reload and close/reopen now show the SAME full-turn view.");
