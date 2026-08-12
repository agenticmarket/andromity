export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ping') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const data = await request.json();
      
      // Simple validation
      if (!['first_launch', 'session_start'].includes(data.event) || !data.os || !data.version) {
        return new Response('Bad Request', { status: 400 });
      }

      // We only care about the date (YYYY-MM-DD)
      const dateStr = new Date().toISOString().split('T')[0];
      
      // Keys to increment in KV (or Durable Objects / Analytics Engine)
      const keys = [];
      
      const country = request.cf && request.cf.country ? request.cf.country : 'unknown';

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
        if (data.provider) {
          keys.push(`usage:${dateStr}:provider:${data.provider}`);
        }
        if (data.profile) {
          keys.push(`usage:${dateStr}:profile:${data.profile}`);
        }
      }

      // Track Unique Users (DAU) by setting a key with the user_id
      // We set a 30-day expiration so the KV doesn't grow infinitely over years
      if (data.user_id) {
        ctx.waitUntil(
          env.TELEMETRY_KV.put(`active_users:${dateStr}:${data.user_id}`, "1", { expirationTtl: 86400 * 30 })
            .catch(err => console.error('DAU KV Error', err))
        );
      }

      // Execute KV updates in the background without blocking the response
      ctx.waitUntil(
        Promise.all(keys.map(async (key) => {
          try {
            const current = await env.TELEMETRY_KV.get(key) || '0';
            await env.TELEMETRY_KV.put(key, (parseInt(current, 10) + 1).toString());
          } catch (err) {
            console.error('KV Error for key', key, err);
          }
        }))
      );

      return new Response('OK', { status: 202 });
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  },
};
