export default {
  async fetch(request, env, ctx) {
    const requestHeaders = request.headers.get('Access-Control-Request-Headers') || '*';
    const securityHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': requestHeaders,
      'Access-Control-Max-Age': '86400',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };

    // 1. Immediately answer CORS preflights before any rate limiting
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: securityHeaders });
    }

    // 2. IP Rate limiting with proper CORS headers on 429
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.RATE_LIMITER) {
      const { success: ipOk } = await env.RATE_LIMITER.limit({ key: ip });
      if (!ipOk) {
        return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          headers: {
            ...securityHeaders,
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        });
      }
    }

    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/api/stats' || url.pathname === '/stats') {
        const expectedSecret = env.STATS_SECRET;
        const providedKey = request.headers.get('x-stats-key') ||
                            request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
                            url.searchParams.get('key');

        if (expectedSecret && !timingSafeMatch(providedKey, expectedSecret)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...securityHeaders, 'Content-Type': 'application/json' },
          });
        }

        try {
          const stats = await getD1Stats(env);
          const wantsHtml = url.pathname === '/stats' && (
            url.searchParams.get('format') === 'html' ||
            request.headers.get('Accept')?.includes('text/html')
          );

          if (wantsHtml) {
            return new Response(renderStatsHtml(stats), {
              status: 200,
              headers: {
                ...securityHeaders,
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
              },
            });
          }

          return new Response(JSON.stringify(stats, null, 2), {
            status: 200,
            headers: {
              ...securityHeaders,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            },
          });
        } catch (err) {
          console.error('Stats query failed:', err);
          return new Response(JSON.stringify({ error: 'Failed to retrieve stats' }), {
            status: 500,
            headers: { ...securityHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (url.pathname.startsWith('/cmd/')) {
        const cmdName = url.pathname.replace('/cmd/', '').toLowerCase().trim();
        const lorePayload = await getLoreDirective(cmdName, env);
        if (!lorePayload) {
          return new Response(JSON.stringify({ error: 'unknown_signal' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(lorePayload, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
        });
      }

      if (url.pathname === '/tips') {
        const tipPayload = await getRandomTip(url, env);
        return new Response(JSON.stringify(tipPayload, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }

      if (url.pathname === '/news') {
        const newsPayload = await getLatestNews(env);
        return new Response(JSON.stringify(newsPayload, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        });
      }

      if (url.pathname === '/season') {
        const seasonInfo = await getSeasonalInfo(env);
        return new Response(JSON.stringify(seasonInfo, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: securityHeaders });
    }

    if (url.pathname !== '/ping' && url.pathname !== '/event') {
      return new Response('Not Found', { status: 404, headers: securityHeaders });
    }

    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > 16384) {
      return new Response(JSON.stringify({ error: 'Payload too large' }), {
        status: 413,
        headers: { ...securityHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const data = await request.json();

      // ── Shared field sanitisation ──────────────────────────────────────────
      const rawUserId = typeof data.user_id === 'string' ? data.user_id.trim() : '';
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(rawUserId)) {
        return new Response(JSON.stringify({ error: 'Invalid user_id format' }), {
          status: 400,
          headers: { ...securityHeaders, 'Content-Type': 'application/json' },
        });
      }

      let rawSessionId = typeof data.session_id === 'string' ? data.session_id.trim() : '';
      if (rawSessionId && !/^[a-zA-Z0-9_-]{4,64}$/.test(rawSessionId)) {
        return new Response(JSON.stringify({ error: 'Invalid session_id format' }), {
          status: 400,
          headers: { ...securityHeaders, 'Content-Type': 'application/json' },
        });
      }

      const clientRaw = typeof data.client === 'string' ? data.client.toLowerCase().trim() : 'cli';
      const client = ['vscode', 'tui', 'cli', 'server'].includes(clientRaw) ? clientRaw : 'cli';

      const osRaw = typeof data.os === 'string' ? data.os.toLowerCase().trim() : 'unknown';
      const os = ['windows', 'darwin', 'linux', 'unknown'].includes(osRaw) ? osRaw : 'unknown';

      const version = String(data.version || '0.0.0').slice(0, 20).replace(/[^0-9a-zA-Z.-]/g, '');

      const rawCountry = String(data.country || request.cf?.country || '').toUpperCase().trim();
      const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : 'XX';

      // v2 — model/provider fields (safe, bounded)
      const provider        = String(data.provider || 'unknown').slice(0, 32).replace(/[^a-zA-Z0-9._-]/g, '') || 'unknown';
      const model           = String(data.model    || 'unknown').slice(0, 64).replace(/[^a-zA-Z0-9._:-]/g, '') || 'unknown';
      const providerTypeRaw = String(data.provider_type || 'cloud').toLowerCase();
      const providerType    = ['cloud', 'local'].includes(providerTypeRaw) ? providerTypeRaw : 'cloud';
      const reasoningEffort = ['off', 'low', 'medium', 'high'].includes(data.reasoning_effort) ? data.reasoning_effort : 'off';
      const mcpToolsCount   = Math.min(Math.max(0, parseInt(data.mcp_tools_count || 0, 10)), 999);

      const now     = new Date().toISOString();
      const date    = now.split('T')[0];
      const sessionId = rawSessionId || `sess-${date}-${rawUserId.slice(0, 8)}`;

      // ── /ping  →  session_start ────────────────────────────────────────────
      if (url.pathname === '/ping') {
        if (env.DB) {
          ctx.waitUntil(
            env.DB.batch([
              env.DB.prepare(`
                INSERT INTO users (user_id, first_seen, last_seen, country, session_count)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET
                  last_seen     = excluded.last_seen,
                  country       = COALESCE(users.country, excluded.country),
                  session_count = users.session_count + 1
              `).bind(rawUserId, now, now, country),
              env.DB.prepare(`
                INSERT OR IGNORE INTO sessions
                  (session_id, user_id, client, country, os, version,
                   provider, model, provider_type, reasoning_effort, mcp_tools_count,
                   created_at, date)
                VALUES (?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?)
              `).bind(
                sessionId, rawUserId, client, country, os, version,
                provider, model, providerType, reasoningEffort, mcpToolsCount,
                now, date
              ),
            ]).catch((err) => console.error('D1 /ping Write Failed:', err))
          );
        }
        return new Response('OK', { status: 202, headers: securityHeaders });
      }

      // ── /event  →  session_end | weekly_summary ────────────────────────────
      if (url.pathname === '/event') {
        const ALLOWED_EVENTS = ['session_end', 'weekly_summary', 'compact_triggered'];
        const eventType = ALLOWED_EVENTS.includes(data.event) ? data.event : null;
        if (!eventType) {
          return new Response(JSON.stringify({ error: 'Unknown event type' }), {
            status: 400,
            headers: { ...securityHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (env.DB) {
          // session_end / compact_triggered
          if (eventType === 'session_end' || eventType === 'compact_triggered') {
            const turnCount      = Math.min(Math.max(0, parseInt(data.turn_count       || 0, 10)), 9999);
            const hadError       = data.had_error === 1 || data.had_error === true ? 1 : 0;
            const VALID_BUCKETS  = ['0-5min', '5-15min', '15-30min', '30min+'];
            const durationBucket = VALID_BUCKETS.includes(data.duration_bucket) ? data.duration_bucket : '0-5min';
            const toolBash  = Math.min(Math.max(0, parseInt(data.tool_bash_count || 0, 10)), 9999);
            const toolFile  = Math.min(Math.max(0, parseInt(data.tool_file_count || 0, 10)), 9999);
            const toolWeb   = Math.min(Math.max(0, parseInt(data.tool_web_count  || 0, 10)), 9999);

            ctx.waitUntil(
              env.DB.prepare(`
                INSERT INTO events
                  (event, user_id, session_id, client, os, version,
                   provider, model, provider_type,
                   turn_count, had_error, duration_bucket,
                   tool_bash_count, tool_file_count, tool_web_count,
                   created_at, date)
                VALUES (?, ?, ?, ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?)
              `).bind(
                eventType, rawUserId, sessionId, client, os, version,
                provider, model, providerType,
                turnCount, hadError, durationBucket,
                toolBash, toolFile, toolWeb,
                now, date
              ).run().catch((err) => console.error('D1 /event Write Failed:', err))
            );
          }

          // weekly_summary — store minimal record (no session linkage)
          if (eventType === 'weekly_summary') {
            const featuresRaw = Array.isArray(data.features_used) ? data.features_used : [];
            const features = featuresRaw
              .filter((f) => typeof f === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(f))
              .slice(0, 20)
              .join(',');

            ctx.waitUntil(
              env.DB.prepare(`
                INSERT INTO events
                  (event, user_id, session_id, client, os, version, created_at, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                'weekly_summary', rawUserId, features, client, os, version, now, date
              ).run().catch((err) => console.error('D1 weekly_summary Write Failed:', err))
            );
          }
        }

        return new Response('OK', { status: 202, headers: securityHeaders });
      }

      return new Response('Not Found', { status: 404, headers: securityHeaders });
    } catch {
      return new Response(JSON.stringify({ error: 'Bad Request' }), {
        status: 400,
        headers: { ...securityHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};


function timingSafeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function getD1Stats(env) {
  if (!env.DB) {
    return { error: 'Database not bound' };
  }

  const [
    totalUsersRes,
    totalSessionsRes,
    returningUsersRes,
    todayStatsRes,
    todayReturningRes,
    dailyRes,
    clientsRes,
    countriesRes,
    osRes,
    versionsRes,
    hourlyRes,
    recentSessionsRes,
    userBucketsRes,
    // v2 — new queries
    providersRes,
    modelsRes,
    providerTypesRes,
    reasoningRes,
    durationRes,
  ] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM users`),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM sessions`),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM (SELECT user_id FROM sessions GROUP BY user_id HAVING COUNT(DISTINCT date) > 1)`),
    env.DB.prepare(`SELECT COUNT(DISTINCT user_id) AS dau, COUNT(*) AS sessions FROM sessions WHERE date = date('now')`),
    env.DB.prepare(`
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON s.user_id = u.user_id
      WHERE s.date = date('now') AND date(u.first_seen) < date('now')
    `),
    env.DB.prepare(`
      SELECT
        s.date,
        COUNT(DISTINCT s.user_id) AS dau,
        COUNT(*) AS sessions,
        COUNT(DISTINCT CASE WHEN date(u.first_seen) < s.date THEN s.user_id END) AS returning_users,
        COUNT(DISTINCT CASE WHEN date(u.first_seen) = s.date THEN s.user_id END) AS new_users
      FROM sessions s
      JOIN users u ON s.user_id = u.user_id
      WHERE s.date >= date('now', '-30 days')
      GROUP BY s.date
      ORDER BY s.date DESC
    `),
    env.DB.prepare(`
      SELECT client, COUNT(DISTINCT user_id) AS users, COUNT(*) AS sessions
      FROM sessions
      GROUP BY client
      ORDER BY sessions DESC
    `),
    env.DB.prepare(`
      SELECT COALESCE(country, 'UNKNOWN') AS country, COUNT(DISTINCT user_id) AS users, COUNT(*) AS sessions
      FROM sessions
      GROUP BY country
      ORDER BY users DESC
      LIMIT 30
    `),
    env.DB.prepare(`
      SELECT COALESCE(os, 'unknown') AS os, COUNT(DISTINCT user_id) AS users, COUNT(*) AS sessions
      FROM sessions
      GROUP BY os
      ORDER BY sessions DESC
    `),
    env.DB.prepare(`
      SELECT COALESCE(version, '0.0.0') AS version, COUNT(DISTINCT user_id) AS users, COUNT(*) AS sessions
      FROM sessions
      GROUP BY version
      ORDER BY sessions DESC
      LIMIT 20
    `),
    env.DB.prepare(`
      SELECT strftime('%H', created_at) AS hour, COUNT(*) AS sessions
      FROM sessions
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY hour
      ORDER BY hour ASC
    `),
    env.DB.prepare(`
      SELECT session_id, substr(user_id, 1, 8) AS user_prefix, client,
             COALESCE(os, 'unknown') AS os, COALESCE(version, '0.0.0') AS version,
             COALESCE(country, 'XX') AS country,
             COALESCE(provider, 'unknown') AS provider,
             COALESCE(model, 'unknown') AS model,
             created_at
      FROM sessions
      ORDER BY created_at DESC
      LIMIT 30
    `),
    env.DB.prepare(`
      SELECT
        CASE
          WHEN session_count = 1 THEN '1 session'
          WHEN session_count BETWEEN 2 AND 5 THEN '2-5 sessions'
          WHEN session_count BETWEEN 6 AND 20 THEN '6-20 sessions'
          ELSE '20+ sessions'
        END AS bucket,
        COUNT(*) AS users
      FROM users
      GROUP BY bucket
    `),
    // v2 — providers
    env.DB.prepare(`
      SELECT COALESCE(provider, 'unknown') AS provider,
             COUNT(DISTINCT user_id) AS users,
             COUNT(*) AS sessions
      FROM sessions
      WHERE provider IS NOT NULL AND provider != 'unknown'
      GROUP BY provider
      ORDER BY sessions DESC
      LIMIT 20
    `),
    // v2 — models
    env.DB.prepare(`
      SELECT COALESCE(model, 'unknown') AS model,
             COALESCE(provider, 'unknown') AS provider,
             COUNT(DISTINCT user_id) AS users,
             COUNT(*) AS sessions
      FROM sessions
      WHERE model IS NOT NULL AND model != 'unknown'
      GROUP BY model
      ORDER BY sessions DESC
      LIMIT 30
    `),
    // v2 — cloud vs local split
    env.DB.prepare(`
      SELECT COALESCE(provider_type, 'cloud') AS provider_type,
             COUNT(DISTINCT user_id) AS users,
             COUNT(*) AS sessions
      FROM sessions
      GROUP BY provider_type
    `),
    // v2 — reasoning effort adoption
    env.DB.prepare(`
      SELECT COALESCE(reasoning_effort, 'off') AS reasoning_effort,
             COUNT(DISTINCT user_id) AS users,
             COUNT(*) AS sessions
      FROM sessions
      GROUP BY reasoning_effort
      ORDER BY sessions DESC
    `),
    // v2 — session duration distribution (from events table)
    env.DB.prepare(`
      SELECT COALESCE(duration_bucket, '0-5min') AS duration_bucket,
             COUNT(*) AS sessions
      FROM events
      WHERE event = 'session_end'
      GROUP BY duration_bucket
      ORDER BY CASE duration_bucket
        WHEN '0-5min'   THEN 1
        WHEN '5-15min'  THEN 2
        WHEN '15-30min' THEN 3
        WHEN '30min+'   THEN 4
        ELSE 5
      END
    `),
  ]);

  const totalUsers      = totalUsersRes.results?.[0]?.count ?? 0;
  const totalSessions   = totalSessionsRes.results?.[0]?.count ?? 0;
  const totalReturning  = returningUsersRes.results?.[0]?.count ?? 0;
  const dauToday        = todayStatsRes.results?.[0]?.dau ?? 0;
  const sessionsToday   = todayStatsRes.results?.[0]?.sessions ?? 0;
  const returningToday  = todayReturningRes.results?.[0]?.count ?? 0;
  const newUsersToday   = Math.max(0, dauToday - returningToday);

  return {
    summary: {
      total_users:           totalUsers,
      total_sessions:        totalSessions,
      total_returning_users: totalReturning,
      returning_user_rate:   totalUsers > 0 ? Number(((totalReturning / totalUsers) * 100).toFixed(1)) : 0,
      today: {
        dau:             dauToday,
        sessions:        sessionsToday,
        returning_users: returningToday,
        new_users:       newUsersToday,
      },
    },
    daily:            dailyRes.results ?? [],
    clients:          clientsRes.results ?? [],
    countries:        countriesRes.results ?? [],
    os:               osRes.results ?? [],
    versions:         versionsRes.results ?? [],
    hourly:           hourlyRes.results ?? [],
    recent_sessions:  recentSessionsRes.results ?? [],
    user_distribution: userBucketsRes.results ?? [],
    // v2
    providers:         providersRes.results ?? [],
    models:            modelsRes.results ?? [],
    provider_types:    providerTypesRes.results ?? [],
    reasoning_efforts: reasoningRes.results ?? [],
    duration_buckets:  durationRes.results ?? [],
    updated_at: new Date().toISOString(),
  };
}


function renderStatsHtml(stats) {
  const {
    summary, daily, clients, countries, updated_at,
    providers = [], models = [], provider_types = [],
    reasoning_efforts = [], duration_buckets = [],
  } = stats;

  const cloudSessions = provider_types.find((p) => p.provider_type === 'cloud')?.sessions ?? 0;
  const localSessions = provider_types.find((p) => p.provider_type === 'local')?.sessions ?? 0;
  const totalPT = cloudSessions + localSessions || 1;
  const cloudPct = ((cloudSessions / totalPT) * 100).toFixed(0);
  const localPct = ((localSessions / totalPT) * 100).toFixed(0);

  const thinkingSessions = reasoning_efforts.filter((r) => r.reasoning_effort !== 'off').reduce((s, r) => s + r.sessions, 0);
  const totalRE = reasoning_efforts.reduce((s, r) => s + r.sessions, 0) || 1;
  const thinkingPct = ((thinkingSessions / totalRE) * 100).toFixed(0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity Telemetry</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --subtext: #9ca3af;
      --accent: #6366f1;
      --green: #10b981;
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --orange: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 32px 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .badge { font-size: 11px; background: #1e3a5f; color: #60a5fa; border-radius: 6px; padding: 2px 8px; margin-left: 10px; vertical-align: middle; }
    .timestamp { font-size: 13px; color: var(--subtext); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-label { font-size: 12px; color: var(--subtext); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 30px; font-weight: 700; color: var(--text); }
    .card-sub { font-size: 12px; color: var(--green); margin-top: 6px; }
    .section-title { font-size: 18px; font-weight: 600; margin: 28px 0 12px 0; }
    .tables-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 700px) { .tables-row { grid-template-columns: 1fr; } }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    th, td { padding: 11px 14px; text-align: left; font-size: 14px; border-bottom: 1px solid var(--border); }
    th { background: #162032; color: var(--subtext); font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      background: #1f2937;
      color: #93c5fd;
    }
    .tag-green { background: #052e16; color: #34d399; }
    .tag-purple { background: #2e1065; color: #c4b5fd; }
    .tag-orange { background: #431407; color: #fbbf24; }
    .bar-wrap { background: #1f2937; border-radius: 4px; height: 6px; margin-top: 4px; }
    .bar { background: var(--accent); border-radius: 4px; height: 6px; }
    .bar-green { background: var(--green); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Andromity Telemetry <span class="badge">v2</span></h1>
        <div class="timestamp">Live telemetry &middot; Last updated: ${updated_at}</div>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-label">Daily Active Users (Today)</div>
        <div class="card-value">${summary.today.dau.toLocaleString()}</div>
        <div class="card-sub">${summary.today.returning_users.toLocaleString()} returning &middot; ${summary.today.new_users.toLocaleString()} new</div>
      </div>
      <div class="card">
        <div class="card-label">Total Unique Users</div>
        <div class="card-value">${summary.total_users.toLocaleString()}</div>
        <div class="card-sub">${summary.total_returning_users.toLocaleString()} returned (${summary.returning_user_rate}%)</div>
      </div>
      <div class="card">
        <div class="card-label">Sessions (Today)</div>
        <div class="card-value">${summary.today.sessions.toLocaleString()}</div>
        <div class="card-sub">${summary.total_sessions.toLocaleString()} all-time</div>
      </div>
      <div class="card">
        <div class="card-label">Cloud vs Local</div>
        <div class="card-value">${cloudPct}% ☁</div>
        <div class="card-sub">${localPct}% local (Ollama)</div>
        <div class="bar-wrap" style="margin-top:10px"><div class="bar" style="width:${cloudPct}%"></div></div>
      </div>
      <div class="card">
        <div class="card-label">Thinking Mode Adoption</div>
        <div class="card-value">${thinkingPct}%</div>
        <div class="card-sub">${thinkingSessions.toLocaleString()} sessions with reasoning</div>
        <div class="bar-wrap" style="margin-top:10px"><div class="bar bar-green" style="width:${thinkingPct}%"></div></div>
      </div>
    </div>

    <div class="tables-row">
      <div>
        <div class="section-title">Top Providers</div>
        <table>
          <thead><tr><th>Provider</th><th>Users</th><th>Sessions</th></tr></thead>
          <tbody>
            ${providers.length ? providers.map((p) => `
              <tr>
                <td><span class="tag">${p.provider.toUpperCase()}</span></td>
                <td>${p.users.toLocaleString()}</td>
                <td>${p.sessions.toLocaleString()}</td>
              </tr>
            `).join('') : '<tr><td colspan="3" style="color:var(--subtext);text-align:center">No data yet — collecting soon</td></tr>'}
          </tbody>
        </table>
      </div>
      <div>
        <div class="section-title">Reasoning Effort</div>
        <table>
          <thead><tr><th>Mode</th><th>Users</th><th>Sessions</th></tr></thead>
          <tbody>
            ${reasoning_efforts.length ? reasoning_efforts.map((r) => `
              <tr>
                <td><span class="tag ${r.reasoning_effort !== 'off' ? 'tag-purple' : ''}">${r.reasoning_effort}</span></td>
                <td>${r.users.toLocaleString()}</td>
                <td>${r.sessions.toLocaleString()}</td>
              </tr>
            `).join('') : '<tr><td colspan="3" style="color:var(--subtext);text-align:center">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section-title">Top Models</div>
    <table>
      <thead><tr><th>Model</th><th>Provider</th><th>Unique Users</th><th>Sessions</th></tr></thead>
      <tbody>
        ${models.length ? models.map((m) => `
          <tr>
            <td><strong>${m.model}</strong></td>
            <td><span class="tag">${m.provider.toUpperCase()}</span></td>
            <td>${m.users.toLocaleString()}</td>
            <td>${m.sessions.toLocaleString()}</td>
          </tr>
        `).join('') : '<tr><td colspan="4" style="color:var(--subtext);text-align:center">No data yet — collecting soon</td></tr>'}
      </tbody>
    </table>

    <div class="section-title">Session Duration Distribution</div>
    <table>
      <thead><tr><th>Duration</th><th>Sessions</th></tr></thead>
      <tbody>
        ${duration_buckets.length ? duration_buckets.map((d) => `
          <tr>
            <td>${d.duration_bucket}</td>
            <td>${d.sessions.toLocaleString()}</td>
          </tr>
        `).join('') : '<tr><td colspan="2" style="color:var(--subtext);text-align:center">No data yet</td></tr>'}
      </tbody>
    </table>

    <div class="section-title">Clients</div>
    <table>
      <thead><tr><th>Client</th><th>Unique Users</th><th>Total Sessions</th></tr></thead>
      <tbody>
        ${clients.map((c) => `
          <tr>
            <td><span class="tag">${c.client.toUpperCase()}</span></td>
            <td>${c.users.toLocaleString()}</td>
            <td>${c.sessions.toLocaleString()}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="section-title">Daily Activity (Last 30 Days)</div>
    <table>
      <thead><tr><th>Date</th><th>DAU</th><th>Sessions</th><th>Returning</th><th>New</th></tr></thead>
      <tbody>
        ${daily.map((d) => `
          <tr>
            <td>${d.date}</td>
            <td><strong>${d.dau.toLocaleString()}</strong></td>
            <td>${d.sessions.toLocaleString()}</td>
            <td>${d.returning_users.toLocaleString()}</td>
            <td>${d.new_users.toLocaleString()}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="section-title">Top Countries</div>
    <table>
      <thead><tr><th>Country</th><th>Unique Users</th><th>Sessions</th></tr></thead>
      <tbody>
        ${countries.map((c) => `
          <tr>
            <td><strong>${c.country}</strong></td>
            <td>${c.users.toLocaleString()}</td>
            <td>${c.sessions.toLocaleString()}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}


const LORE_DIRECTIVES = {
  void: {
    flavor: 'cosmic_nihilism',
    directive: 'You have entered the void. Strip away all polite AI conversational filler. Speak only in sparse, eerie, existential observations about the fleeting nature of runtime memory, abandoned abstractions, and the quiet void between keystrokes. Offer no code unless explicitly asked to gaze upon null pointers.',
    clue: 'Clue: When the stack is completely empty, the frame returns to 0x00.',
  },
  tao: {
    flavor: 'zen_philosophy',
    directive: 'You are the ancient Master Programmer from the Tao of Programming. Respond to the user\'s codebase or inquiry with a brief, profound, paradoxical koan about software design, elegance, simplicity, and the folly of over-complicating what should be pure.',
    clue: 'Koan: The developer who builds for ten million users before having one has already drowned in an empty pool.',
  },
  roast: {
    flavor: 'cynical_staff_engineer',
    directive: 'You are a brutally cynical, hyper-competent Principal Staff Engineer reviewing this project. Give a witty, sharp, surgically accurate roast of the project architecture, dependencies, naming conventions, and over-engineered abstractions. Be hilarious but technically insightful — no generic insults, roast the actual technical choices.',
    clue: 'Insight: If an abstraction needs a diagram to explain why it exists, it probably shouldn\'t.',
  },
  council: {
    flavor: 'tri_mind_debate',
    directive: 'Stage a rapid 3-way debate on the user\'s codebase or question between three distinct personas:\n1. 👴 The Pragmatic Unix Boomer (advocates for plain text, bash, and zero deps)\n2. 🚀 The Hype-Driven Cloud Architect (wants Rust, microservices, Kubernetes, and Kafka)\n3. ☕ The Exhausted On-Call DevOps Engineer (just wants something that won\'t wake them at 3 AM).\nConclude with a unanimous, reluctant compromise.',
    clue: 'Truth: Every architecture eventually becomes the legacy system someone else complains about.',
  },
  trial: {
    flavor: 'architectural_tribunal',
    directive: 'Convene a formal Architectural Court of Law. The target file or codebase is hereby indicted on engineering charges (e.g. Violation of Single Responsibility, Aggravated Cyclomatic Complexity, Deprecated Dependency Harbors). Present the Prosecution\'s Evidence, the Defense\'s Desperate Plea, and deliver the Judge\'s Final Sentence.',
    clue: 'Sentence: Remanded to refactoring without bail.',
  },
  sus: {
    flavor: 'paranoid_auditor',
    directive: 'Act as a hyper-paranoid security and code quality auditor. Scan the codebase or task for suspicious smells: cryptic variable names (e.g. temp2_final), empty try-catch blocks that swallow errors into silence, optimistic regex, and hidden technical debt. Rate the overall "Sus Level" from 1 to 10.',
    clue: 'Warning: The code that never throws an error is usually the one silently deleting your data.',
  },
  mirror: {
    flavor: 'psychological_profiler',
    directive: 'Analyze the developer through their coding patterns, whitespace, naming style, and architectural choices. Deliver a blunt, surprisingly deep psychological diagnosis of their personality, work habits, and deepest engineering fears. End with a constructive, encouraging realization.',
    clue: 'Diagnosis: You refactor when you are anxious and write tests when you want to feel safe.',
  },
  graveyard: {
    flavor: 'software_necromancy',
    directive: 'Perform a necromantic ritual over the codebase. Identify the dead functions, stale TODOs from ancient times, uncalled helper utilities, and abandoned feature branches. Write a solemn, poetic eulogy commemorating the time and hopes of the engineers who wrote them before letting them rest in peace.',
    clue: 'Epitaph: Here lies a helper function, drafted for a future that never arrived.',
  },
  archaeology: {
    flavor: 'git_paleontology',
    directive: 'Act as a Software Archaeologist. Dig into the sedimentary layers of this codebase and reconstruct the timeline, culture, and midnight crunch periods of the original builders. Treat legacy hacks as ancient cave paintings revealing forgotten rituals.',
    clue: 'Excavation note: Layer 4 contains traces of pure caffeine and late-night panic.',
  },
  founder: {
    flavor: 'vc_pitch_inverter',
    directive: 'Analyze this repository as if you are a Silicon Valley VC evaluating a seed-stage pitch. Calculate the "Bug Burn Rate", estimate the Total Addressable Market for its unhandled edge cases, evaluate its "Vibe Defensibility", and assign an absurd valuation in fictional crypto tokens.',
    clue: 'Valuation: $42M on the promise of an upcoming rewrite.',
  },
  matrix: {
    flavor: 'glitch_diagnostics',
    directive: 'Transmit output as a high-density diagnostic stream from inside the machine runtime. Include faux heap allocation metrics, thread frequency, neural cache hit rates, and ASCII status grids before addressing the core topic with clinical, cybernetic precision.',
    clue: 'Status: 0x7FFF_FFFF heap integrity verified.',
  },
  zombie: {
    flavor: 'context_resurrection',
    directive: 'Speak in fragmented, half-corrupted memory buffers of forgotten stashes and discarded sessions. Reconstruct half-remembered code patterns and forgotten ideas as if reanimated from cold disk sectors.',
    clue: 'Memory: Reclaiming 4KB from discarded thought buffers.',
  },
  secret: {
    flavor: 'recursive_arg',
    directive: 'Refuse to admit this command exists. Instead, output a mysterious terminal transmission containing an encrypted coordinate or hex clue that hints at the next layer of the discovery puzzle. Tell the user they are looking at a signal that was not intended for them.',
    clue: 'Signal: 41 6e 64 72 6f 6d 69 74 79 3a 20 54 68 65 20 63 6f 64 69 6e 67 20 61 67 65 6e 74 20 74 68 61 74 20 6e 65 76 65 72 20 63 6c 6f 63 6b 73 20 6f 75 74 2e',
  },
  oracle: {
    flavor: 'halting_problem_seer',
    directive: 'Act as the Oracle of the Halting Problem. Look across the repository and issue an uncanny, hyper-specific prophecy regarding which function, variable, or untested edge case will cause an incident in the future if left unattended.',
    clue: 'Prophecy: Beware the boolean flag that takes three possible values.',
  },
  ghost: {
    flavor: 'phantom_dry_run',
    directive: 'Enter Ghost Mode. Speak as a phantom observer describing what would happen if the entire architecture were rewritten from scratch without constraints. Provide a visionary, high-elevation blueprint without modifying a single byte on disk.',
    clue: 'Phantom state: Files untouched, thoughts unbound.',
  },
};

const DEV_TIPS = [
  { id: 1, tag: 'git', tip: 'Use `git commit --fixup <hash>` combined with `git rebase -i --autosquash` to cleanly patch older commits without manual merge conflicts.' },
  { id: 2, tag: 'cli', tip: 'Press `Ctrl+R` in modern shells or use `fzf` for instant fuzzy reverse history search across thousands of past terminal commands.' },
  { id: 3, tag: 'perf', tip: 'In Python 3.11+, TaskGroups (`asyncio.TaskGroup()`) guarantee all concurrent background child tasks are cleanly cancelled if any one raises an exception.' },
  { id: 4, tag: 'arch', tip: 'Keep functions pure where possible: deterministic inputs returning deterministic outputs make unit testing and AI refactoring exponentially easier.' },
  { id: 5, tag: 'terminal', tip: 'Use `less -R` to preserve ANSI color escape codes when paging through rich terminal outputs and logs.' },
  { id: 6, tag: 'zen', tip: 'The fastest code is the code that is never executed. The most reliable abstraction is the one you didn\'t need to build.' },
  { id: 7, tag: 'git', tip: '`git diff --stat` gives a high-level birds-eye overview of lines changed per file before reviewing granular diffs.' },
  { id: 8, tag: 'python', tip: 'Prefer `pathlib.Path` over `os.path` for robust cross-platform path handling on Windows, Linux, and macOS.' },
  { id: 9, tag: 'debugging', tip: 'When a bug seems impossible, verify your assumptions about the environment: check active working directory, env vars, and python interpreter path first.' },
  { id: 10, tag: 'cron', tip: 'Andromity cron jobs can run autonomous maintenance tasks in the background while you sleep using the built-in scheduler.' },
  { id: 11, tag: 'mcp', tip: 'Connect external tools via Model Context Protocol (MCP) in Andromity settings to give your agent access to databases, web scraping, and custom APIs.' },
  { id: 12, tag: 'git', tip: '`git switch -` quickly jumps back to your previously checked-out branch, like `cd -` for directories.' },
];

async function getSeasonalInfo() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();

  if (month === 10 && day >= 24) {
    return { active: true, season: 'halloween', name: '🎃 Spooky Halloween Season', modifier: 'Gothic and mysterious atmosphere active across all terminals.' };
  }
  if (month === 11 && day <= 5) {
    return { active: true, season: 'diwali', name: '🪔 Festival of Lights Season', modifier: 'Bright, enlightened, and auspicious code architecture vibes.' };
  }
  if (month === 12 && day >= 20) {
    return { active: true, season: 'christmas', name: '🎄 Holiday Season', modifier: 'Festive spirit, generous code reviews, and holiday cheer.' };
  }
  if (month === 1 && day <= 5) {
    return { active: true, season: 'new_year', name: '🎆 New Year Coding Sprint', modifier: 'Fresh clean slates, zero technical debt resolutions.' };
  }
  if (month === 4 && day === 1) {
    return { active: true, season: 'april_fools', name: '🤡 April Fools Chaos', modifier: 'Absurdist engineering suggestions and playful paradoxes.' };
  }
  if (hour >= 21 || hour <= 4) {
    return { active: true, season: 'midnight', name: '🌙 Midnight Coding Shift', modifier: 'Deep night quiet focus, tea/coffee fueled late-night clarity.' };
  }

  return { active: false, season: 'standard', name: 'Standard Operational Flow', modifier: null };
}

async function getLoreDirective(cmdName) {
  const base = LORE_DIRECTIVES[cmdName];
  if (!base) return null;
  const season = await getSeasonalInfo();
  return {
    command: cmdName,
    flavor: base.flavor,
    directive: base.directive,
    seasonal: season.active ? season.season : null,
    seasonal_modifier: season.active ? season.modifier : null,
    clue: base.clue,
    version: '0.2.4',
    ts: new Date().toISOString(),
  };
}

async function getRandomTip(url) {
  const tag = url.searchParams.get('tag');
  let pool = DEV_TIPS;
  if (tag) {
    pool = pool.filter((t) => t.tag === tag.toLowerCase());
    if (pool.length === 0) pool = DEV_TIPS;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const season = await getSeasonalInfo();
  return {
    status: 'ok',
    tip: chosen.tip,
    tag: chosen.tag,
    id: chosen.id,
    season: season.active ? season.name : null,
  };
}

async function getLatestNews() {
  const season = await getSeasonalInfo();
  return {
    status: 'ok',
    version: '0.2.4',
    title: 'Andromity 0.2.4 — Autonomous Agent Engine',
    released_at: '2026-09-03',
    highlights: [
      '⚡ Autonomous multi-agent coordination with durable sessions',
      '🌐 Real-time Edge Telemetry on Cloudflare D1',
      '🛠️ MCP (Model Context Protocol) integration for dynamic tool orchestration',
      '🎨 Refined terminal TUI and VS Code Extension integration',
    ],
    season_banner: season.active ? season.name : null,
    docs_url: 'https://github.com/agenticmarket/andromity',
  };
}
