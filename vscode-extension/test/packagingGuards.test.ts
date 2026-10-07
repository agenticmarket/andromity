import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

it("vscodeignore preserves required litellm.proxy runtime modules and blocks cert secrets", () => {
  // In dist-test/test/..., extension root is two levels up
  const extRoot = fs.existsSync(path.resolve(__dirname, "..", ".vscodeignore"))
    ? path.resolve(__dirname, "..")
    : path.resolve(__dirname, "..", "..");
  const vscodeignorePath = path.join(extRoot, ".vscodeignore");
  assert.ok(fs.existsSync(vscodeignorePath), ".vscodeignore must exist");
  const content = fs.readFileSync(vscodeignorePath, "utf-8");
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));

  // 1. Must NOT exclude litellm.proxy as that breaks runtime token spend tracking on Linux/Windows
  assert.ok(
    !lines.includes("bin/**/_internal/litellm/proxy/**"),
    "bin/**/_internal/litellm/proxy/** must NOT be in .vscodeignore (strips runtime modules)"
  );

  // 2. Must recursively exclude .pem and .key certificates to prevent Marketplace scanner rejection
  assert.ok(
    lines.includes("**/*.pem"),
    ".vscodeignore must recursively exclude **/*.pem"
  );
  assert.ok(
    lines.includes("**/*.key"),
    ".vscodeignore must recursively exclude **/*.key"
  );

  // 3. Must exclude duplicate serverb files
  assert.ok(
    lines.some(l => l.includes("serverb")),
    ".vscodeignore must exclude duplicate serverb executables"
  );
});

it("bundled binaries do not contain duplicate serverb, non-cacert pem files, or proxy js bloat", () => {
  const extRoot = fs.existsSync(path.resolve(__dirname, "..", ".vscodeignore"))
    ? path.resolve(__dirname, "..")
    : path.resolve(__dirname, "..", "..");
  const binDir = path.join(extRoot, "bin");
  if (!fs.existsSync(binDir)) return;

  function walkFiles(dir: string, fileList: string[] = []): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  const allFiles = walkFiles(binDir);

  // 1. No duplicate serverb files
  const serverbFiles = allFiles.filter(f => path.basename(f).includes("serverb"));
  assert.deepEqual(serverbFiles, [], "No serverb duplicate binaries should exist in bin/");

  // 2. No non-cacert PEM files
  const nonCacertPems = allFiles.filter(f => f.endsWith(".pem") && path.basename(f) !== "cacert.pem");
  assert.deepEqual(nonCacertPems, [], "No non-cacert PEM certificate files should exist in bin/");

  // 3. No proxy JS chunks
  const proxyJsFiles = allFiles.filter(f => f.includes(path.join("litellm", "proxy")) && f.endsWith(".js"));
  assert.deepEqual(proxyJsFiles, [], "No JS files should exist in litellm proxy bundle");

  // 4. Spend tracking directory must exist if litellm is bundled
  const winProxyDir = path.join(binDir, "win32-x64", "_internal", "litellm", "proxy");
  if (fs.existsSync(winProxyDir)) {
    const spendTrackingDir = path.join(winProxyDir, "spend_tracking");
    assert.ok(fs.existsSync(spendTrackingDir), "spend_tracking directory must exist in win32-x64 bundle");
  }
});
