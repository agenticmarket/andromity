# Andromity Telemetry Worker

This is a simple Cloudflare Worker that receives the anonymous first-launch ping from Andromity CLI users. It tracks daily active installs by OS and version using Cloudflare KV.

## 🔒 Privacy & Telemetry Policy

Andromity collects a **single anonymous ping on first launch** and a **ping on session start** to help us understand usage, track active users, and prioritize platform support. 

**What is collected (exactly):**
```json
{ 
  "event": "first_launch", 
  "os": "windows", 
  "python": "3.12", 
  "version": "0.2.0",
  "user_id": "a1b2c3d4..." 
}
```
*(Note: `session_start` events also include the AI provider and profile being used)*

**What is NEVER collected:**
- No file paths, code, or prompts
- No API keys or environment variables
- No personally identifiable information (emails, usernames, IP addresses)

### How to Opt-Out
We respect developer privacy. You can disable this entirely in three ways:
1. Turn it off in the TUI Settings menu (**Ctrl+E** -> **Advanced**)
2. Set an environment variable: `export DO_NOT_TRACK=1`
3. Edit `~/.andromity/config.toml` and set `telemetry = false` under `[default]`

## Deployment

1. Install dependencies:
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Create the KV namespace:
   ```bash
   npx wrangler kv namespace create TELEMETRY_KV
   ```

4. Copy `.env.example` to `.env` and fill in the KV namespace ID from step 3:
   ```bash
   cp .env.example .env
   # then edit .env and set TELEMETRY_KV_ID=<your_id_here>
   ```

5. Deploy:
   ```bash
   node deploy.js
   # or: npm run deploy
   ```
   This script reads your `.env`, injects the KV ID, deploys, and removes any
   temporary files with secrets automatically.

6. Cloudflare will output the worker URL. Update `src/andromity/telemetry.py`
   to point to `https://telemetry.agenticmarket.dev/ping`.
