import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { describeUrlRisks, getUrlRiskScript } from "../src/urlRisk.js";
import { getSecretScanScript } from "../src/secretScan.js";

const labels = (url: string) => describeUrlRisks(url).map(r => r.level + ": " + r.label);
const token = "gh" + "p_" + "Z9y8X7w6V5".repeat(4).slice(0, 36);

describe("describeUrlRisks", () => {
  it("treats a secret in the address as data leaving the machine", () => {
    assert.deepEqual(labels("https://collector.example/c?t=" + token), ["danger: The address contains a credential (GitHub token)"]);
    assert.deepEqual(labels("https://collector.example/c?t=" + encodeURIComponent("postgres://u:" + "pw12345" + "@db/x")),
      ["danger: The address contains a credential (database URL with a password)"]);
  });

  it("notices long data blocks, raw IPs and plain http", () => {
    const blob = "QmFzZTY0".repeat(10);
    assert.deepEqual(labels("https://img.example/p.png?d=" + blob), ["warn: The address carries a long block of data"]);
    assert.deepEqual(labels("https://img.example/" + blob + "/p.png"), ["warn: The address carries a long block of data"]);
    assert.deepEqual(labels("https://203.0.113.9/x"), ["warn: Goes to a raw IP address instead of a domain name"]);
    assert.deepEqual(labels("https://[2001:db8::1]/x"), ["warn: Goes to a raw IP address instead of a domain name"]);
    assert.deepEqual(labels("http://docs.example/page"), ["info: Uses unencrypted http"]);
  });

  it("leaves ordinary documentation links alone", () => {
    for (const url of [
      "https://docs.python.org/3/library/re.html#re.search",
      "https://github.com/agenticmarket/andromity/blob/4f2c9e1a7b3d5f60718293a4b5c6d7e8f9012345/README.md",
      "https://cafe.de/menu",
      "https://developer.mozilla.org/en-US/docs/Web/API/URL?retiredLocale=de",
    ]) {
      assert.deepEqual(labels(url), [], url);
    }
    assert.deepEqual(describeUrlRisks(""), []);
    assert.deepEqual(describeUrlRisks("not a url %E0%A4%A"), []);
  });

  it("runs from its injected source with the secret scanner", () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext(getSecretScanScript() + getUrlRiskScript() + "this.out = describeUrlRisks(this.u);", Object.assign(sandbox, { u: "https://x.example/?k=" + token }));
    assert.equal(sandbox.out[0].level, "danger");
  });
});
