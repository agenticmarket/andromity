import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Cursor-Parity File Pills, Ambient Context Stripping & Ollama Tests", () => {
  // Extract and test the exact parseUserPromptDisplay logic running in chatClientScript
  function parseUserPromptDisplay(rawText: string) {
    if (!rawText || typeof rawText !== "string") {
      return { userText: "", files: [] as Array<{ name: string; path: string; line?: number; isAmbient?: boolean }> };
    }

    let text = rawText;
    const files: Array<{ name: string; path: string; line?: number; isAmbient?: boolean }> = [];
    const seenFiles = new Set<string>();

    function addFile(name: string, path: string, line?: number, isAmbient?: boolean) {
      const key = (path || name || "").toLowerCase();
      if (!key || seenFiles.has(key)) return;
      seenFiles.add(key);
      files.push({ name, path, line, isAmbient });
    }

    const ambientSepMatch = text.match(/\r?\n\s*---\s*\r?\n(?=\[(?:Active Document|Active Diagnostics|Selection in|Other Open Documents))/);
    let userPart = text;

    if (ambientSepMatch && typeof ambientSepMatch.index === "number") {
      userPart = text.slice(0, ambientSepMatch.index);
    }

    const attachedFileRegex = /\[Attached File:\s*([^\]\r\n]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = attachedFileRegex.exec(userPart)) !== null) {
      const fullPath = m[1].trim();
      const fName = fullPath.split(/[\/\\]/).pop() || fullPath;
      addFile(fName, fullPath);
    }
    userPart = userPart.replace(attachedFileRegex, "").trim();

    // Strip ambient tags without creating pills
    userPart = userPart.replace(/\[Active Document:[^\]\r\n]+\]/g, "").trim();
    userPart = userPart.replace(/\[(?:Other Open Documents|Active Diagnostics|Selection in)[^\]]*\]/gs, "").trim();

    return { userText: userPart, files };
  }

  const BINARY_FILE_EXTENSIONS = new Set([
    "exe", "dll", "bin", "so", "dylib", "zip", "tar", "gz", "7z", "rar", "iso",
    "dmg", "class", "pyc", "pyo", "o", "obj", "wasm", "db", "sqlite", "parquet"
  ]);

  function getFileIconBadge(fileName: string) {
    const ext = (fileName || "").split(".").pop()?.toLowerCase();
    switch (ext) {
      case "tsx":
      case "jsx":
        return { badge: "⚛", color: "#61dafb" };
      case "ts":
        return { badge: "TS", color: "#38bdf8" };
      case "js":
      case "mjs":
      case "cjs":
        return { badge: "JS", color: "#f7df1e" };
      case "py":
        return { badge: "🐍", color: "#4ade80" };
      case "html":
      case "htm":
        return { badge: "HTML", color: "#fb923c" };
      case "css":
      case "scss":
      case "less":
        return { badge: "#", color: "#c084fc" };
      case "json":
        return { badge: "{}", color: "#facc15" };
      case "md":
      case "markdown":
        return { badge: "📝", color: "#93c5fd" };
      case "rs":
        return { badge: "🦀", color: "#f97316" };
      case "go":
        return { badge: "GO", color: "#38bdf8" };
      default:
        return { badge: "📄", color: "#94a3b8" };
    }
  }

  function pickBestOllamaModel(models: string[]): string | null {
    if (!models || models.length === 0) return null;
    return (
      models.find((m) => /qwen|coder/i.test(m)) ||
      models.find((m) => /deepseek/i.test(m)) ||
      models.find((m) => /llama/i.test(m)) ||
      models[0]
    );
  }

  it("should cleanly strip ambient context without creating any ugly file pills for open files", () => {
    const rawInput = "great\n\n---\n[Active Document: game/index.html (Language: html), Line: 9]\n[Other Open Documents: .andromity/.gitignore]";
    const parsed = parseUserPromptDisplay(rawInput);

    assert.equal(parsed.userText, "great");
    assert.equal(parsed.files.length, 0, "Ambient open files must NOT create file pills on prompt");
  });

  it("should strip ambient diagnostics and selection blocks completely with 0 pills", () => {
    const rawInput = "fix this error\n\n---\n[Active Document: src/App.tsx, Line: 42]\n[Active Diagnostics in src/App.tsx (1 errors, 0 warnings):\n  - Line 42 [error]: Cannot find name 'foo'\n]\n[Selection in src/App.tsx (lines 40-42)]:\n```typescript\nconsole.log(foo);\n```\n[Other Open Documents: src/index.ts]";
    const parsed = parseUserPromptDisplay(rawInput);

    assert.equal(parsed.userText, "fix this error");
    assert.equal(parsed.files.length, 0, "Ambient diagnostics and selection must NOT create file pills");
  });

  it("should parse user-attached drag & dropped file pills cleanly", () => {
    const rawInput = "[Attached File: src/components/Header.tsx]\n[Attached File: src/styles/theme.css]\nrefactor these styles";
    const parsed = parseUserPromptDisplay(rawInput);

    assert.equal(parsed.userText, "refactor these styles");
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.files[0].name, "Header.tsx");
    assert.equal(parsed.files[0].path, "src/components/Header.tsx");
    assert.equal(parsed.files[1].name, "theme.css");
    assert.equal(parsed.files[1].path, "src/styles/theme.css");
  });

  it("should match clean prompt text across echo and prevent duplicate user message bubbles", () => {
    const promptDispatchedFromUI = "hi";
    const lastAppendedUserText = promptDispatchedFromUI.trim();

    const serverEchoedPrompt = "hi\n\n---\n[Active Document: game/index.html (Language: html), Line: 9]\n[Other Open Documents: .andromity/.gitignore]";
    const parsedEcho = parseUserPromptDisplay(serverEchoedPrompt);

    // Verify deduplication check evaluates to true (skips appending duplicate)
    const isDuplicate = lastAppendedUserText === parsedEcho.userText.trim();
    assert.equal(isDuplicate, true);
  });

  it("should block binary executable and archive files from being attached as context", () => {
    const dangerousFiles = ["payload.exe", "driver.dll", "blob.bin", "archive.zip", "compiled.pyc", "module.wasm"];
    for (const f of dangerousFiles) {
      const ext = f.split(".").pop()?.toLowerCase() || "";
      assert.equal(BINARY_FILE_EXTENSIONS.has(ext), true, `Expected ${f} to be blocked as binary`);
    }

    const safeFiles = ["App.tsx", "service.ts", "main.py", "index.html", "style.css", "schema.json", "Cargo.toml"];
    for (const f of safeFiles) {
      const ext = f.split(".").pop()?.toLowerCase() || "";
      assert.equal(BINARY_FILE_EXTENSIONS.has(ext), false, `Expected ${f} to be allowed`);
    }
  });

  it("should assign correct language badges and colors matching Cursor aesthetic", () => {
    assert.equal(getFileIconBadge("Component.tsx").badge, "⚛");
    assert.equal(getFileIconBadge("index.ts").badge, "TS");
    assert.equal(getFileIconBadge("script.py").badge, "🐍");
    assert.equal(getFileIconBadge("index.html").badge, "HTML");
    assert.equal(getFileIconBadge("data.json").badge, "{}");
    assert.equal(getFileIconBadge("README.md").badge, "📝");
  });

  it("should select the best coding model when auto-detecting Ollama models", () => {
    const models1 = ["llama3:latest", "qwen2.5-coder:7b", "mistral:latest"];
    assert.equal(pickBestOllamaModel(models1), "qwen2.5-coder:7b");

    const models2 = ["deepseek-r1:14b", "phi4:latest"];
    assert.equal(pickBestOllamaModel(models2), "deepseek-r1:14b");

    const models3 = ["custom-llm:latest"];
    assert.equal(pickBestOllamaModel(models3), "custom-llm:latest");

    assert.equal(pickBestOllamaModel([]), null);
  });
});
