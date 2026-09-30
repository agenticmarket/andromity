import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";

describe("Clickable File and Folder Pills in Assistant Responses", () => {
  // Test helper replicating detectPathType logic
  function detectPathType(
    text: string,
    workspaceFiles: Set<string> = new Set(),
    workspaceFolders: Set<string> = new Set(),
  ): { type: "file" | "folder"; path: string } | null {
    if (!text || typeof text !== "string") return null;
    const str = text.trim();
    if (
      !str ||
      str.length > 250 ||
      str.indexOf("\n") !== -1 ||
      str.indexOf("\r") !== -1
    )
      return null;
    if (str.indexOf("*") !== -1 || str.indexOf("?") !== -1) return null;
    if (/^\.[a-zA-Z0-9]+$/.test(str)) return null;
    if (/^[a-zA-Z0-9_-]+\s*\(.*?\)$/.test(str)) return null;
    if (/[;{}<>=!|&]/.test(str)) return null;
    if (str.startsWith("-") || str.startsWith("--")) return null;
    if (
      str.indexOf(" ") !== -1 &&
      !str.startsWith("/") &&
      !str.startsWith("./") &&
      !/^[a-zA-Z]:[\\/]/.test(str)
    ) {
      return null;
    }

    const clean = str.replace(/[?#].*$/, "");
    const lower = clean.toLowerCase();

    if (clean.endsWith("/") || clean.endsWith("\\")) {
      return { type: "folder", path: clean.replace(/[\\/]+$/, "") };
    }

    if (workspaceFolders && workspaceFolders.has(lower)) {
      return { type: "folder", path: clean };
    }

    if (workspaceFiles && workspaceFiles.has(lower)) {
      return { type: "file", path: clean };
    }

    const commonFolders = new Set([
      "_internal",
      "test",
      "tests",
      "walkthroughs",
      "media",
      "assets",
      "src",
      "bin",
      "dist",
      "build",
      "scripts",
      "docs",
      "components",
      "utils",
      "lib",
      "packages",
      "pages",
      "styles",
      "public",
      "views",
      "panels",
      "providers",
      "integrations",
    ]);
    if (commonFolders.has(lower)) {
      return { type: "folder", path: clean };
    }

    const fileExtRegex =
      /\.(tsx?|jsx?|mjs|cjs|py|pyw|html?|css|scss|sass|less|json|md|markdown|rs|go|c|cpp|h|hpp|java|kt|kts|sql|sh|bash|ps1|bat|cmd|yml|yaml|toml|ini|cfg|env|lock|svg|png|jpg|jpeg|gif|webp|ico|spec|dockerfile|gitignore)$/i;
    if (fileExtRegex.test(clean)) {
      return { type: "file", path: clean };
    }

    const genericExtMatch = clean.match(
      /^([a-zA-Z0-9_\-\.\/\\~]+)\.([a-zA-Z0-9]{1,6})(:\\d+)?$/,
    );
    if (
      genericExtMatch &&
      !clean.startsWith("http://") &&
      !clean.startsWith("https://")
    ) {
      const ext = genericExtMatch[2].toLowerCase();
      if (
        (!/^\d+$/.test(ext) &&
          ["com", "org", "net", "io", "dev", "app", "ai"].indexOf(ext) ===
            -1) ||
        clean.indexOf("/") !== -1 ||
        clean.indexOf("\\") !== -1
      ) {
        return { type: "file", path: clean };
      }
    }

    if (clean.indexOf("/") !== -1 || clean.indexOf("\\") !== -1) {
      const lastSeg = clean.split(/[\\/]/).pop() || "";
      if (lastSeg.indexOf(".") !== -1 && !lastSeg.startsWith(".")) {
        return { type: "file", path: clean };
      }
      return { type: "folder", path: clean };
    }

    return null;
  }

  function getFileIconBadge(fileName: string) {
    const ext = (fileName || "").split(".").pop()?.toLowerCase();
    if (!ext || ext?.length > 4) return { badge: ext, color: "#94a3b8" };
    else {
      switch (ext) {
        case "tsx":
        case "jsx":
          return { badge: "JSX", color: "#61dafb" };
        case "ts":
          return { badge: "TS", color: "#38bdf8" };
        case "js":
        case "mjs":
        case "cjs":
          return { badge: "JS", color: "#f7df1e" };
        case "py":
          return { badge: "PY", color: "#4ade80" };
        case "html":
        case "htm":
          return { badge: "HTML", color: "#fb923c" };
        case "css":
        case "scss":
        case "less":
          return { badge: "CSS", color: "#c084fc" };
        case "json":
          return { badge: "{}", color: "#facc15" };
        case "md":
        case "markdown":
          return { badge: "MD", color: "#93c5fd" };
        default:
          return { badge: ext, color: "#94a3b8" };
      }
    }
  }

  function renderFileOrFolderChip(
    detected: { type: "file" | "folder"; path: string },
    originalText: string,
  ) {
    const isDir = detected.type === "folder";
    const cleanPath = detected.path;

    if (isDir) {
      const folderSvg =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.85; flex-shrink:0;"><path d="M1.5 13.5v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"></path><path d="M1.5 7h13"></path></svg>';
      return (
        '<span class="md-file-pill is-dir" data-action="open-file" data-file-path="' +
        cleanPath +
        '" title="Click to reveal folder in Explorer sidebar (' +
        cleanPath +
        ')">' +
        '<span class="pill-icon folder-icon">' +
        folderSvg +
        "</span>" +
        '<span class="pill-name">' +
        (originalText || cleanPath) +
        "</span>" +
        "</span>"
      );
    }

    const badgeInfo = getFileIconBadge(cleanPath);
    return (
      '<span class="md-file-pill is-file" data-action="open-file" data-file-path="' +
      cleanPath +
      '" title="Click to open file in new tab (' +
      cleanPath +
      ')">' +
      '<span class="pill-badge" style="color:' +
      badgeInfo.color +
      ';">' +
      badgeInfo.badge +
      "</span>" +
      '<span class="pill-name">' +
      (originalText || cleanPath) +
      "</span>" +
      "</span>"
    );
  }

  it("should classify workspace folders and common folder names correctly", () => {
    const folders = [
      "_internal",
      "test",
      "walkthroughs",
      "media",
      "src",
      "src/providers",
      "components/",
    ];
    for (const f of folders) {
      const detected = detectPathType(f);
      assert.ok(detected !== null, `Expected ${f} to be detected as folder`);
      assert.equal(detected?.type, "folder", `Expected ${f} to be type folder`);
    }
  });

  it("should classify files with extensions correctly", () => {
    const files = [
      "esbuild.js",
      "extension.js",
      "marked.min.js",
      "src/ChatViewProvider.ts",
      "package.json",
      "index.html",
    ];
    for (const f of files) {
      const detected = detectPathType(f);
      assert.ok(detected !== null, `Expected ${f} to be detected as file`);
      assert.equal(detected?.type, "file", `Expected ${f} to be type file`);
    }
  });

  it("should NOT classify wildcards, pure extensions, and code statements as file pills", () => {
    const nonPills = [
      "*.test.ts",
      ".cjs",
      "litellm",
      "boto3",
      "const x = 1;",
      "npm run build",
      "--verbose",
      "foo()",
    ];
    for (const item of nonPills) {
      const detected = detectPathType(item);
      assert.equal(
        detected,
        null,
        `Expected ${item} NOT to be detected as file pill`,
      );
    }
  });

  it("should render folder pill with folder icon and reveal in sidebar title", () => {
    const detected = detectPathType("_internal");
    assert.ok(detected);
    const html = renderFileOrFolderChip(detected, "_internal");
    assert.ok(html.includes('class="md-file-pill is-dir"'));
    assert.ok(html.includes('data-action="open-file"'));
    assert.ok(html.includes('data-file-path="_internal"'));
    assert.ok(html.includes("reveal folder in Explorer sidebar"));
    assert.ok(html.includes("pill-icon folder-icon"));
  });

  it("should render file pill with language badge and open in new tab title", () => {
    const detected = detectPathType("esbuild.js");
    assert.ok(detected);
    const html = renderFileOrFolderChip(detected, "esbuild.js");
    assert.ok(html.includes('class="md-file-pill is-file"'));
    assert.ok(html.includes('data-action="open-file"'));
    assert.ok(html.includes('data-file-path="esbuild.js"'));
    assert.ok(html.includes("open file in new tab"));
    assert.ok(html.includes("pill-badge"));
    assert.ok(html.includes("JS"));
  });

  it("should seamlessly integrate into marked markdown parsing for assistant messages", () => {
    const customRenderer = {
      codespan(token: any) {
        const text =
          token && typeof token === "object" ? token.text : String(token || "");
        const detected = detectPathType(text);
        if (detected) {
          return renderFileOrFolderChip(detected, text);
        }
        return `<code>${text}</code>`;
      },
    };
    marked.use({ renderer: customRenderer as any, gfm: true });

    const markdownInput = [
      "Packaging & Build",
      "- `_internal` — a bundled PyInstaller Python runtime",
      "- `esbuild.js` — bundler config; output goes to `extension.js`",
      "- `test` — unit tests (`*.test.ts`) plus many `.cjs` integration scripts",
      "- `walkthroughs` — VS Code getting-started walkthrough content",
      "- `media` — icons, fonts, `marked.min.js`",
    ].join("\n");

    const html = marked.parse(markdownInput) as string;

    // Folders must have folder pills with open-file data-action
    assert.ok(html.includes('data-file-path="_internal"'));
    assert.ok(html.includes('class="md-file-pill is-dir"'));
    assert.ok(html.includes('data-file-path="test"'));
    assert.ok(html.includes('data-file-path="walkthroughs"'));
    assert.ok(html.includes('data-file-path="media"'));

    // Files must have file pills with open-file data-action
    assert.ok(html.includes('data-file-path="esbuild.js"'));
    assert.ok(html.includes('class="md-file-pill is-file"'));
    assert.ok(html.includes('data-file-path="extension.js"'));
    assert.ok(html.includes('data-file-path="marked.min.js"'));

    // Non-file/pattern code must remain regular <code>
    assert.ok(html.includes("<code>*.test.ts</code>"));
    assert.ok(html.includes("<code>.cjs</code>"));
  });
});
