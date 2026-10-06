const allowed = ['country','client','os','version','provider','model','timeRange',
  'excludeCountry','excludeClient','excludeOS','excludeVersion','excludeProvider','excludeModel'];
const flights = new WeakMap();
const snapshotLifetimeSeconds = 600;

export function normalizeStatsParams(params) {
  const normalized = new URLSearchParams();
  for (const name of allowed) {
    const value = params.get(name);
    if (value && !(name === 'timeRange' && value === 'all')) normalized.set(name, value);
  }
  return normalized;
}

export async function cachedStats(env, params, compute) {
  const normalized = normalizeStatsParams(params);
  const key = 'stats-v8:' + new Date().toISOString().slice(0,10) + ':' + normalized.toString();
  let pending = flights.get(env.DB);
  if (!pending) { pending = new Map(); flights.set(env.DB, pending); }
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const now = Math.floor(Date.now()/1000);
    const [cached] = await env.DB.batch([env.DB.prepare(
      'SELECT payload FROM telemetry_stats_cache WHERE cache_key=? AND expires_at>?'
    ).bind(key, now)]);
    if (cached.results?.[0]) {
      const snapshot = JSON.parse(cached.results[0].payload);
      return { ...snapshot, snapshot_query_cost: snapshot.query_cost,
        query_cost: { rows_read: cached.meta?.rows_read || 0, statements: 1 },
        cache: { hit: true, max_age_seconds: snapshotLifetimeSeconds } };
    }
    const result = await compute(env, normalized);
    if (result.error) return result;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM telemetry_stats_cache WHERE expires_at<=?').bind(now),
      env.DB.prepare(
      `INSERT INTO telemetry_stats_cache(cache_key,payload,expires_at) VALUES (?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`
    ).bind(key, JSON.stringify(result), now+snapshotLifetimeSeconds)]);
    return { ...result, cache: { hit: false, max_age_seconds: snapshotLifetimeSeconds } };
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
