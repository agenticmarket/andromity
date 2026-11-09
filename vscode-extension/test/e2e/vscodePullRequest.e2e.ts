// End to end in the REAL VS Code (DESIGN 8 "End to end, real VS Code"). Not part of `npm run test:build`
// (the file name doesn't end in .test.ts, so scripts/run-tests.cjs never picks it up): it opens a VS Code window.
//
// Run it with:
//   npx tsc -p ./tsconfig.test.json
//   node --test dist-test/test/e2e/vscodePullRequest.e2e.js
// Optional: ANDROMITY_E2E_CODE=<path to Code.exe> (default: the per-user install on Windows).
//
// What it does: makes a temp repository whose origin says https://github.com/test/orders.git but is redirected to a
// local bare repository (url.<bare>.insteadOf), with git refusing every network protocol (GIT_ALLOW_PROTOCOL=file)
// and the user's git config ignored. It then starts the installed VS Code with a throwaway --user-data-dir and
// --extensions-dir, --disable-workspace-trust, the temp repository as the folder, and
// --extensionTestsPath=vscodePullRequest.runner.js, which drives the product flow through VscodeGitPort on the real
// vscode.git API. A hard timeout kills only the process tree this test started.
//
// --extensionDevelopmentPath points at a tiny generated extension, NOT at vscode-extension/: the Andromity extension
// activates on startup and starts its Python engine, which (per the project's own notes) can run on the wrong Python
// and rewrite the user's real %APPDATA%\andromity config. The product modules under test are loaded straight from
// dist-test by the runner, so the real vscode.git + VscodeGitPort path is exercised without starting the engine.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeSandbox } from "../helpers/prRealGit.js";

const CODE = process.env.ANDROMITY_E2E_CODE || path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
const TIMEOUT_MS = 240_000;

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

it("Create pull request flow on the real vscode.git in the installed VS Code", { timeout: TIMEOUT_MS + 30_000 }, async (t) => {
  if (!fs.existsSync(CODE)) {
    t.skip(`VS Code not found at ${CODE}`);
    return;
  }
  const sb = makeSandbox("orders");
  const userData = path.join(sb.dir, "vscode-user");
  const extensionsDir = path.join(sb.dir, "vscode-extensions");
  const stubExtension = path.join(sb.dir, "stub-extension");
  const resultFile = path.join(sb.dir, "result.json");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.mkdirSync(extensionsDir);
  fs.mkdirSync(stubExtension);
  fs.writeFileSync(path.join(stubExtension, "package.json"), JSON.stringify({
    name: "andromity-pr-e2e-host", publisher: "local-test", version: "0.0.0", engines: { vscode: "^1.85.0" }, activationEvents: [],
  }));
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "git.enabled": true, "git.autofetch": false, "git.autoRepositoryDetection": true, "git.openRepositoryInParentFolders": "never",
    "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none", "github.gitAuthentication": false, "git.terminalAuthentication": false,
  }));
  const runner = path.join(__dirname, "vscodePullRequest.runner.js");
  const env: NodeJS.ProcessEnv = { ...sb.env, ANDROMITY_PR_E2E: JSON.stringify({ dir: sb.dir, bare: sb.bare, work: sb.work, name: sb.name, remoteUrl: sb.remoteUrl, resultFile }) };
  for (const key of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(key)) delete env[key];
  env.HOME = process.env.HOME;
  env.USERPROFILE = process.env.USERPROFILE;

  const args = [
    `--extensionDevelopmentPath=${stubExtension}`, `--extensionTestsPath=${runner}`, `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`, "--disable-workspace-trust", "--disable-extensions", "--skip-welcome", "--skip-release-notes",
    "--disable-telemetry", "--new-window", sb.work,
  ];
  const child = spawn(CODE, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exit = await new Promise<number | string>((resolve) => {
    const timer = setTimeout(() => { killTree(child.pid); resolve("timeout"); }, TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
    child.on("error", (e) => { clearTimeout(timer); resolve(`spawn error: ${e.message}`); });
  });
  killTree(child.pid);
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
  console.log(JSON.stringify({ exit, vscodeVersion: result?.vscodeVersion, outcomes: result?.outcomes }, null, 2));
  if (!result) console.log(output.slice(-4000));
  await new Promise((r) => setTimeout(r, 1500));
  sb.cleanup();
  assert.ok(result, `the runner wrote no result (exit ${exit})`);
  const failed = result.outcomes.filter((o: any) => !o.ok).map((o: any) => `${o.name}: ${JSON.stringify(o.details)}`);
  assert.deepEqual(failed, [], "scenarios that failed in the real VS Code");
});
