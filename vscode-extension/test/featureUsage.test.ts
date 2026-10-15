import { it } from "node:test";
import assert from "node:assert/strict";
import { featureName, recordFeatureUse, setFeatureUsageGate } from "../src/telemetry/featureUsage.js";

function fakeClient() {
  const sent: any[] = [];
  return { sent, call: async (method: string, params: any): Promise<any> => { sent.push({ method, params }); return {}; } };
}

it("normalises feature names to what the worker accepts and the daemon never scrubs", () => {
  assert.equal(featureName("cmd_" + "generateCommitMessage"), "cmd_generatecommitmessage");
  assert.equal(featureName("settings_tab_API Keys!"), "settings_tab_api_keys");
  assert.equal(featureName("slash_/review"), "slash_review");
  const long = featureName("x".repeat(40));
  assert.ok(long.length <= 31, long);
  assert.equal(featureName("__"), "");
});

it("sends only the name and session, honours the opt-out gate and counts once per session when asked", () => {
  const client = fakeClient();
  setFeatureUsageGate(() => true);
  recordFeatureUse("turn_rail_used", { client, sessionId: "s1", oncePerSession: true });
  recordFeatureUse("turn_rail_used", { client, sessionId: "s1", oncePerSession: true });
  recordFeatureUse("turn_rail_used", { client, sessionId: "s2", oncePerSession: true });
  recordFeatureUse("code_copied", { client, sessionId: "s1" });
  recordFeatureUse("code_copied", { client, sessionId: "s1" });
  assert.deepEqual(client.sent.map(c => [c.method, c.params.feature, c.params.session_id]), [
    ["telemetry.recordFeature", "turn_rail_used", "s1"],
    ["telemetry.recordFeature", "turn_rail_used", "s2"],
    ["telemetry.recordFeature", "code_copied", "s1"],
    ["telemetry.recordFeature", "code_copied", "s1"],
  ]);
  assert.deepEqual(Object.keys(client.sent[0].params).sort(), ["feature", "session_id"]);

  setFeatureUsageGate(() => false);
  recordFeatureUse("cmd_openchat", { client });
  assert.equal(client.sent.length, 4, "nothing is sent when telemetry is off");
  setFeatureUsageGate(() => true);
});
