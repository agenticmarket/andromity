const fs = require('fs');
const vm = require('vm');
const Module = require('module');

// Mock vscode module
const origRequire = Module.prototype.require;
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? (a.fsPath || a.path) : a).join('/') }),
    file: (p) => ({ fsPath: p })
  },
  window: {},
  workspace: {},
  commands: {},
  EventEmitter: class { event() {} fire() {} }
};
Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

const mod = require('../dist/providers/ChatViewProvider.js');
const provider = new mod.ChatViewProvider({ fsPath: 'd:/saas/agent/vscode-extension' }, null);
const mockWebview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
};
const html = provider._getHtmlForWebview(mockWebview);
console.log("HTML generated, length:", html.length);

// Extract non-empty <script>...</script>
const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1])
  .filter(s => s.trim().length > 0);

if (scriptMatches.length === 0) {
  console.error("No script match in HTML");
  process.exit(1);
}

for (let i = 0; i < scriptMatches.length; i++) {
  const scriptCode = scriptMatches[i];
  try {
    new vm.Script(scriptCode);
    console.log(`Script #${i + 1}: SUCCESS parsed with 0 syntax errors! (length: ${scriptCode.length})`);
  } catch (e) {
    console.error(`SYNTAX ERROR IN WEBVIEW SCRIPT #${i + 1}:`, e);
    process.exit(1);
  }
}

