const fs = require('fs');
const vm = require('vm');

const ext = fs.readFileSync('dist/extension.js', 'utf8');

// Find _getHtmlForWebview implementation
// In dist/extension.js, look for _getHtmlForWebview
const funcMatch = ext.match(/_getHtmlForWebview\(webview\)\s*\{([\s\S]*?)\n  \}/);
if (!funcMatch) {
  console.error("Could not find _getHtmlForWebview");
  process.exit(1);
}

// Execute _getHtmlForWebview in a mock context
const mockThis = {
  _extensionUri: { fsPath: 'd:/saas/agent/vscode-extension' },
  _currentSessionId: 'sess-1',
  _currentModel: 'anthropic/claude-3.7-sonnet',
  _currentProvider: 'openrouter',
  _currentMode: 'safe',
  _currentProfile: 'builder',
  _currentReasoning: 'medium',
  _formatModelDisplayName: (m) => m,
};
const mockWebview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => 'vscode-resource://' + u,
};
const mockVscode = {
  Uri: { joinPath: (...p) => p.join('/') }
};

// Create a function body
const fn = new Function('vscode', 'vscode6', 'webview', `
  function getNonce() { return "test-nonce-1234"; }
  ${funcMatch[1]}
`);

const html = fn.call(mockThis, mockVscode, mockVscode, mockWebview);
console.log("HTML generated, length:", html.length);

// Extract <script>...</script>
const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error("No script match in HTML");
  process.exit(1);
}

const scriptCode = scriptMatch[1];
try {
  new vm.Script(scriptCode);
  console.log("SUCCESS: Script parsed with 0 syntax errors!");
} catch (e) {
  console.error("SYNTAX ERROR IN WEBVIEW SCRIPT:", e);
}
