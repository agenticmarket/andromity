# Andromity Telemetry Worker

The Cloudflare Worker behind `telemetry.agenticmarket.dev`. It receives Andromity's usage telemetry and stores it in Cloudflare D1.

**What is collected, what is never collected, and how to turn it off:** see [TELEMETRY.md](../TELEMETRY.md).

## Deployment

1. Install dependencies and sign in to Cloudflare:
   ```bash
   npm install
   npx wrangler login
   ```

2. Create the D1 database and apply the schema:
   ```bash
   npx wrangler d1 create andromity-telemetry
   npx wrangler d1 execute andromity-telemetry --remote --file=schema.sql
   ```

3. Copy `.env.example` to `.env` and set `TELEMETRY_D1_ID` (and optionally `STATS_SECRET`).

4. Deploy:
   ```bash
   npm run deploy
   ```
   `deploy.js` deploys the worker and, when `STATS_SECRET` is set in `.env`, stores it as an encrypted Worker secret.

5. Set the administrative secret separately; it is never read from `.env`:
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```

## Tests

```bash
npm test
```
