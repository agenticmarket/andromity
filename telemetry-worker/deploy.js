#!/usr/bin/env node
/**
 * deploy.js — Securely deploys the telemetry worker without exposing secrets.
 *
 * How it works:
 *  1. Reads TELEMETRY_KV_ID and optional STATS_SECRET from .env (gitignored — never committed)
 *  2. Generates a temporary wrangler.deploy.toml with the real values injected
 *  3. Runs: wrangler deploy --config wrangler.deploy.toml
 *  4. Deletes the temp file immediately after deploy (success or failure)
 *
 * Usage:
 *   node deploy.js        (or: npm run deploy)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 1. Load .env ─────────────────────────────────────────────────────────────
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

const kvId = env['TELEMETRY_KV_ID'];
if (!kvId || kvId === 'your_kv_namespace_id_here') {
  console.error(
    '\n❌  TELEMETRY_KV_ID is not set in .env.\n' +
    '    Run: npx wrangler kv namespace create TELEMETRY_KV\n' +
    '    Then paste the returned ID into your .env file.\n'
  );
  process.exit(1);
}

// ── 2. Read wrangler.toml and inject the real KV ID & vars ───────────────────
const tomlTemplate = fs.readFileSync(
  path.join(__dirname, 'wrangler.toml'),
  'utf8'
);
let tomlResolved = tomlTemplate.replace(/\$\{TELEMETRY_KV_ID\}/g, kvId);

if (env['STATS_SECRET']) {
  tomlResolved += `\n\n[vars]\nSTATS_SECRET = "${env['STATS_SECRET']}"\n`;
}

const tempConfig = path.join(__dirname, 'wrangler.deploy.toml');
fs.writeFileSync(tempConfig, tomlResolved, 'utf8');
console.log('✅  Config resolved securely from .env. Deploying...\n');

// ── 3. Deploy using the resolved config ──────────────────────────────────────
let exitCode = 0;
try {
  execSync(`npx wrangler deploy --config wrangler.deploy.toml`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  exitCode = err.status ?? 1;
} finally {
  // ── 4. Always delete the temp config (even if deploy failed) ─────────────
  fs.unlinkSync(tempConfig);
  console.log('\n🗑️   Temporary deploy config removed.');
}

process.exit(exitCode);
