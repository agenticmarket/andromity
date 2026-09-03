#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '.env');
if (!fs.existsSync(envFile)) {
  console.error(
    '\n❌  .env file not found.\n' +
    '    Copy .env.example → .env and fill in your values.\n'
  );
  process.exit(1);
}

const env = {};
fs.readFileSync(envFile, 'utf8')
  .split('\n')
  .forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = val;
  });

const d1Id = env['TELEMETRY_D1_ID'];
if (!d1Id || d1Id === 'your_d1_database_id_here') {
  console.error(
    '\n❌  TELEMETRY_D1_ID is not set in .env.\n' +
    '    Run: npx wrangler d1 create andromity-telemetry\n' +
    '    Then paste the database_id into your .env file.\n'
  );
  process.exit(1);
}

const tomlTemplate = fs.readFileSync(path.join(__dirname, 'wrangler.toml'), 'utf8');
let tomlResolved = tomlTemplate.replace(/\$\{TELEMETRY_D1_ID\}/g, d1Id);

if (env['STATS_SECRET']) {
  tomlResolved += `\n\n[vars]\nSTATS_SECRET = "${env['STATS_SECRET']}"\n`;
}

const tempConfig = path.join(__dirname, 'wrangler.deploy.toml');
fs.writeFileSync(tempConfig, tomlResolved, 'utf8');
console.log('✅  Config resolved securely from .env. Deploying...\n');

let exitCode = 0;
try {
  execSync(`npx wrangler deploy --config wrangler.deploy.toml`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  exitCode = err.status ?? 1;
} finally {
  if (fs.existsSync(tempConfig)) {
    fs.unlinkSync(tempConfig);
  }
}

process.exit(exitCode);
