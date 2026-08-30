const fs = require('fs');
const vm = require('vm');
const path = require('path');

function checkFileScript(filePath) {
  console.log(`\n========================================`);
  console.log(`Checking script in: ${filePath}`);
  console.log(`========================================`);
  
  if (!fs.existsSync(filePath)) {
    console.error(`File does not exist: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  
  // Extract all <script>...</script> blocks
  const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  
  while ((match = scriptRegex.exec(content)) !== null) {
    count++;
    let scriptCode = match[1];
    
    // In TS template literals, webview JS has ${...} interpolations or \${...}
    // Replace ${...} and \${...} with valid dummy tokens so the JS parser can validate the code
    let testableCode = scriptCode
      .replace(/\\`([^`]*)\\`/g, '`$1`')
      .replace(/\\\${([^}]+)}/g, '"$1"')
      .replace(/\${([^}]+)}/g, '"$1"');
      
    try {
      new vm.Script(testableCode, { filename: path.basename(filePath) });
      console.log(`Script block #${count}: [PASS] Valid JavaScript syntax.`);
    } catch (e) {
      console.error(`Script block #${count}: [FAIL] Syntax Error:`, e.message);
      
      // Print line context around the error
      if (e.stack) {
        const stackLines = e.stack.split('\n');
        console.error(stackLines.slice(0, 8).join('\n'));
      }
    }
  }
  
  if (count === 0) {
    console.log(`No <script> blocks found in ${filePath}`);
  }
}

checkFileScript(path.join(__dirname, '../src/providers/ChatViewProvider.ts'));
checkFileScript(path.join(__dirname, '../src/panels/SettingsPanel.ts'));
if (fs.existsSync(path.join(__dirname, '../src/panels/PlanEditorPanel.ts'))) {
  checkFileScript(path.join(__dirname, '../src/panels/PlanEditorPanel.ts'));
}
