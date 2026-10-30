import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ingestTelemetry } from './ingest.js';
import { getD1Stats } from './worker.js';
import { featureSummaries } from './metricSummaries.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
        sqlite.exec('COMMIT'); return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
const fields = (overrides = {}) => ({ userId: 'user-12345678', sessionId: 'session-errors', client: 'vscode', os: 'windows',
  version: '0.2.25', country: 'GB', provider: 'openrouter', model: 'm', providerType: 'cloud', profile: 'builder',
  reasoningEffort: 'off', mcpToolsCount: 0, now: new Date().toISOString(), date: new Date().toISOString().slice(0, 10), ...overrides });
const stats = db => getD1Stats({ DB: db }, new URLSearchParams('timeRange=all'));
const feature = (db, name, overrides) => ingestTelemetry(db, { event: 'feature_use', feature_name: name }, fields(overrides));

test('each error counts once although it sends a category and a source event', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  for (const name of ['error_rate_limit', 'error_src_provider_429', 'error_network_error', 'error_src_network_conn'])
    await feature(db, name);
  await ingestTelemetry(db, { event: 'session_end', had_error: true }, fields());
  const result = await stats(db);
  assert.equal(result.error_stats.total_errors, 2);
  assert.equal(result.error_stats.error_sessions, 1);
  assert.deepEqual(result.error_stats.categories.map(c => c.category).sort(), ['error_network_error', 'error_rate_limit']);
  assert.deepEqual(result.error_stats.sources.map(s => [s.source, s.count, s.users]).sort(),
    [['network_conn', 1, 1], ['provider_429', 1, 1]]);
  const session = result.recent_sessions[0];
  assert.deepEqual([...session.error_categories].sort(), ['error_network_error', 'error_rate_limit']);
  assert.deepEqual([...session.error_sources].sort(), ['network_conn', 'provider_429']);
  db.sqlite.close();
});

test('old error event names from clients without source events are still errors', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  for (const name of ['error_auth', 'error_timeout', 'error_context_length', 'error_generic', 'error_ollama_offline'])
    await feature(db, name);
  const result = await stats(db);
  assert.equal(result.error_stats.total_errors, 5);
  assert.equal(result.error_stats.categories.length, 5);
  assert.deepEqual(result.error_stats.sources, []);
  assert.deepEqual(result.recent_sessions[0].error_sources, []);
  db.sqlite.close();
});

test('a source event whose category event was lost does not hide the failed session', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  await feature(db, 'error_src_provider_5xx');
  await ingestTelemetry(db, { event: 'session_end', had_error: true }, fields());
  const result = await stats(db);
  assert.equal(result.recent_sessions[0].had_error, 1);
  assert.equal(result.error_stats.error_sessions, 1, 'the failed session disappeared from the error totals');
  assert.equal(result.error_stats.total_errors, 1);
  db.sqlite.close();
});

test('names that merely resemble the source prefix stay error categories', () => {
  const summaries = featureSummaries([
    { feature_name: 'error_srcmap_missing', user_id: 'one', use_count: 1 },
    { feature_name: 'error_src_gateway_5xx', user_id: 'one', use_count: 2 },
    { feature_name: 'error_src_gateway_5xx', user_id: 'two', use_count: 1 },
  ]);
  assert.deepEqual(summaries.errorCategoriesRes.results.map(r => r.category), ['error_srcmap_missing']);
  assert.deepEqual(summaries.errorSourcesRes.results, [{ source: 'gateway_5xx', count: 3, users: 2 }]);
});
