import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m",
  currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });

function between(start: string, end: string): string {
  const from = script.indexOf(start);
  const to = script.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return script.slice(from, to);
}

describe("@ mention palette", () => {
  it("offers to browse skills instead of listing skills that don't exist", () => {
    const palette = { style: { display: "none" } };
    const list = { innerHTML: "" };
    const context = vm.createContext({
      mentionPalette: palette, mentionPaletteList: list, hideSlashPalette() {},
      currentMentionMatches: ["stale"], activeMentionIdx: 3,
    });
    vm.runInContext(between("    function showMentionEmptyState()", "    function hideMentionPalette()") +
      "\nshowMentionEmptyState(); this.matches = currentMentionMatches;", context);
    assert.equal(palette.style.display, "flex");
    assert.match(list.innerHTML, /No skills installed yet/);
    assert.match(list.innerHTML, /data-action="open-skills-settings"/);
    assert.doesNotMatch(list.innerHTML, /select-mention-skill/);
    assert.equal(context.matches.length, 0, "Enter must not pick a placeholder");
  });

  it("has no built-in placeholder skills", () => {
    for (const fake of ["'browser'", "'terminal'", "'editor'", "'git'"]) {
      assert.ok(!script.includes("{ name: " + fake), `${fake} should not be offered as a skill`);
    }
  });
});
