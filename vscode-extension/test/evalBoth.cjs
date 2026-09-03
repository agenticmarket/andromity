const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Mock vscode module
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? a.fsPath : a).join('/') }),
    file: (p) => ({ fsPath: p })
  },
  window: {},
  workspace: {},
  commands: {},
  EventEmitter: class { event() {} fire() {} }
};

// Register mock for vscode
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

function testProvider(name, filePath, instantiator) {
  console.log(`\n========================================`);
  console.log(`Testing Webview JS in: ${name}`);
  console.log(`========================================`);

  try {
    const mod = require(filePath);
    const html = instantiator(mod);
    console.log(`Generated HTML length: ${html.length} chars`);

    // Extract all <script>...</script> tags
    const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
    let match;
    let idx = 0;
    let totalErrors = 0;

    while ((match = scriptRegex.exec(html)) !== null) {
      idx++;
      const scriptCode = match[1];
      try {
        new vm.Script(scriptCode, { filename: `${name}-script-${idx}.js` });
        console.log(`  Script #${idx}: [PASS] Valid JavaScript syntax. (Length: ${scriptCode.length} chars)`);
      } catch (e) {
        totalErrors++;
        console.error(`  Script #${idx}: [FAIL] SyntaxError: ${e.message}`);
        
        // Print the error line and context
        if (e.stack) {
          const lines = scriptCode.split('\n');
          const lineMatch = e.stack.match(/:(\d+)(?::(\d+))?/);
          if (lineMatch) {
            const errLine = parseInt(lineMatch[1], 10) - 1;
            console.error(`  Line ${errLine + 1}: ${lines[errLine]}`);
            if (errLine > 0) console.error(`  Before: ${lines[errLine - 1]}`);
            if (errLine < lines.length - 1) console.error(`  After:  ${lines[errLine + 1]}`);
          }
        }
      }
    }

    if (totalErrors === 0) {
      console.log(`=> ${name}: ALL SCRIPTS PASSED WITH 0 SYNTAX ERRORS!`);
    } else {
      console.error(`=> ${name}: ${totalErrors} SCRIPT SYNTAX ERROR(S) FOUND!`);
    }
  } catch (err) {
    console.error(`Error instantiating ${name}:`, err);
  }
}

// 1. ChatViewProvider
testProvider(
  'ChatViewProvider',
  '../dist-test/src/providers/ChatViewProvider.js',
  (mod) => {
    const provider = new mod.ChatViewProvider(
      { fsPath: 'd:/saas/agent/vscode-extension' },
      null
    );
    const mockWebview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
    };
    return provider._getHtmlForWebview(mockWebview);
  }
);

// 2. SettingsPanel
testProvider(
  'SettingsPanel',
  '../dist-test/src/panels/SettingsPanel.js',
  (mod) => {
    // Call private _getHtmlForWebview
    const panelProto = mod.SettingsPanel.prototype;
    const mockThis = {
      _extensionUri: { fsPath: 'd:/saas/agent/vscode-extension' },
      _panel: {
        webview: {
          cspSource: 'vscode-webview:',
          asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
        }
      },
      _initialTab: 'models'
    };
    return panelProto._getHtmlForWebview.call(mockThis);
  }
);

// 3. PlanEditorPanel
testProvider(
  'PlanEditorPanel',
  '../dist-test/src/panels/PlanEditorPanel.js',
  (mod) => {
    const panelProto = mod.PlanEditorPanel.prototype;
    const mockThis = {
      _extensionUri: { fsPath: 'd:/saas/agent/vscode-extension' },
      _panel: {
        webview: {
          cspSource: 'vscode-webview:',
          asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
        }
      },
      _currentPlan: { title: 'Test Plan', todos: [{ id: '1', description: 'Step 1' }] }
    };
    return panelProto._getHtmlForWebview.call(mockThis, mockThis._panel.webview);
  }
);

// 4. PlanViewProvider
testProvider(
  'PlanViewProvider',
  '../dist-test/src/providers/PlanViewProvider.js',
  (mod) => {
    const provider = new mod.PlanViewProvider(
      { fsPath: 'd:/saas/agent/vscode-extension' }
    );
    const mockWebview = {
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
    };
    return provider._getHtmlForWebview(mockWebview);
  }
);
