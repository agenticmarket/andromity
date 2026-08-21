export default {
  async fetch(request, env, ctx) {
    // ── Layer 1: IP-based rate limiting (Cloudflare native) ──────────────────
    // 10 requests per 60 seconds per IP. Catches bots, scrapers, and DDoS
    // before any business logic runs.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success: ipOk } = await env.RATE_LIMITER.limit({ key: ip });
    if (!ipOk) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '60' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ping') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const data = await request.json();

      // Basic field validation
      if (!['first_launch', 'session_start'].includes(data.event) || !data.os || !data.version) {
        return new Response('Bad Request', { status: 400 });
      }

      const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const country = request.cf?.country ?? 'unknown';

      // ── Layer 2: Per-user-id deduplication (KV-based) ─────────────────────
      // Prevents a single user from inflating install/session counts.
      if (data.user_id) {
        if (data.event === 'first_launch') {
          // A real user installs once. If they reinstall the same day we still
          // accept it gracefully (return 200) but skip writing to counters so
          // the app doesn't error out. Max: 1 first_launch per user per day.
          const launchKey = `ratelimit:first_launch:${dateStr}:${data.user_id}`;
          const alreadyLaunched = await env.TELEMETRY_KV.get(launchKey);
          if (alreadyLaunched) {
            // Silently accept — do NOT error the client, just drop the duplicate
            return new Response('OK', { status: 202 });
          }
          // Mark this user_id as launched today (expires in 48 h to handle timezones)
          ctx.waitUntil(
            env.TELEMETRY_KV.put(launchKey, '1', { expirationTtl: 86400 * 2 })
          );
        } else if (data.event === 'session_start') {
          // Real users rarely exceed 20 sessions/day. Cap at 50 to be generous
          // while still blocking runaway loops or malicious flooding.
          const sessionKey = `ratelimit:session:${dateStr}:${data.user_id}`;
          const sessionCount = parseInt(await env.TELEMETRY_KV.get(sessionKey) ?? '0', 10);
          if (sessionCount >= 50) {
            return new Response('Too Many Requests', {
              status: 429,
              headers: { 'Retry-After': '3600' },
            });
          }
          // Increment session counter (expires at end of day + buffer)
          ctx.waitUntil(
            env.TELEMETRY_KV.put(sessionKey, (sessionCount + 1).toString(), {
              expirationTtl: 86400 * 2,
            })
          );
        }
      }

      // ── Build KV counter keys ──────────────────────────────────────────────
      const keys = [];

      if (data.event === 'first_launch') {
        keys.push(
          `installs:${dateStr}:total`,
          `installs:${dateStr}:os:${data.os}`,
          `installs:${dateStr}:version:${data.version}`,
          `installs:${dateStr}:country:${country}`
        );
      } else if (data.event === 'session_start') {
        keys.push(
          `sessions:${dateStr}:total`,
          `sessions:${dateStr}:os:${data.os}`,
          `sessions:${dateStr}:country:${country}`
        );
        if (data.provider) keys.push(`usage:${dateStr}:provider:${data.provider}`);
        if (data.profile)  keys.push(`usage:${dateStr}:profile:${data.profile}`);
      }

      // ── Track DAU ──────────────────────────────────────────────────────────
      // One key per (date, user_id) — expires in 30 days to keep KV lean.
      if (data.user_id) {
        ctx.waitUntil(
          env.TELEMETRY_KV.put(
            `active_users:${dateStr}:${data.user_id}`,
            '1',
            { expirationTtl: 86400 * 30 }
          ).catch(err => console.error('DAU KV Error', err))
        );
      }

      // ── Increment counters in the background (non-blocking) ────────────────
      ctx.waitUntil(
        Promise.all(
          keys.map(async (key) => {
            try {
              const current = await env.TELEMETRY_KV.get(key) ?? '0';
              await env.TELEMETRY_KV.put(key, (parseInt(current, 10) + 1).toString());
            } catch (err) {
              console.error('KV Error for key', key, err);
            }
          })
        )
      );

      return new Response('OK', { status: 202 });
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  },
};
