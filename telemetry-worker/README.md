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
  "version": "0.1.1",
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

1. Install wrangler:
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Create the KV namespace:
   ```bash
   wrangler kv:namespace create TELEMETRY_KV
   ```

4. Create a `.env` file inside this folder with the ID from step 3:
   ```
   TELEMETRY_KV_ID="<your_id_here>"
   ```

5. Deploy the worker:
   ```bash
   wrangler deploy
   ```

6. Once deployed, Cloudflare will give you a URL (e.g., `https://andromity-telemetry.<your-username>.workers.dev`). 
   Update `src/andromity/telemetry.py` to point to this URL instead of the default one.
