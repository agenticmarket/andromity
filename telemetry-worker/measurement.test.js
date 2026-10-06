import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ingestTelemetry } from './ingest.js';
import { getD1Stats } from './worker.js';
import worker from './worker.js';
import { featureSummaries, sessionSummaries } from './metricSummaries.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url),'utf8'));
  const queries=[];
  return { sqlite, queries, prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
    async batch(statements) {
      queries.push(...statements.map(s=>s.sql));
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
        sqlite.exec('COMMIT'); return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
const fields = (overrides={}) => ({ userId:'user-12345678',sessionId:'session-test',client:'vscode',os:'windows',version:'0.2.14',
  country:'IN',provider:'ollama',model:'local-model',providerType:'local',profile:'builder',reasoningEffort:'off',mcpToolsCount:0,
  now:new Date().toISOString(),date:new Date().toISOString().slice(0,10),...overrides });
const stats = db => getD1Stats({DB:db},new URLSearchParams('timeRange=all'));

test('repeated delivery is atomic and creates one feature event',async()=>{
  const db=database(); const data={event:'feature_use',feature_name:'waterfall_manual',event_id:'event-123456789012345'};
  await ingestTelemetry(db,data,fields()); await ingestTelemetry(db,data,fields());
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM feature_events').get().n,1);
  assert.equal((await stats(db)).window_activity.mau,1);
  db.sqlite.close();
});

test('warm refresh reads only one shared cache row and all normalizes to the same key',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  const first=await getD1Stats({DB:db});
  assert.equal(first.cache.hit,false);
  db.queries.length=0;
  const warm=await stats(db);
  assert.equal(warm.cache.hit,true);
  assert.equal(warm.window_activity.mau,1);
  assert.equal(db.queries.length,1);
  assert.match(db.queries[0],/^SELECT payload FROM telemetry_stats_cache/);
  db.sqlite.close();
});

test('ingestion keeps snapshots warm, expiration refreshes, and simultaneous misses coalesce',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  const first=await Promise.all([stats(db),stats(db),stats(db)]);
  assert.equal(first.length,3);
  assert.equal(db.queries.filter(sql=>sql.startsWith('INSERT INTO telemetry_stats_cache')).length,1);
  await ingestTelemetry(db,{event:'session_start'},fields({userId:'user-next-12345',sessionId:'session-next'}));
  assert.equal((await stats(db)).cache.hit,true);
  db.sqlite.prepare('UPDATE telemetry_stats_cache SET expires_at=0').run();
  const refreshed=await stats(db);
  assert.equal(refreshed.cache.hit,false);
  assert.equal(refreshed.window_activity.mau,2);
  db.sqlite.close();
});

test('historical backfill preserves daily activity and same-day model cohorts',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  await ingestTelemetry(db,{event:'session_end'},fields({model:'second-model'}));
  db.sqlite.exec('DELETE FROM activity_facts');
  db.sqlite.exec(readFileSync(new URL('./read-optimization.sql',import.meta.url),'utf8'));
  const result=await getD1Stats({DB:db},new URLSearchParams('model=second-model'));
  assert.equal(result.window_activity.mau,1);
  assert.equal(result.summary.total_sessions,1);
  db.sqlite.close();
});

test('one feature scan preserves overlapping unique users and repeated invocations',()=>{
  const summaries=featureSummaries([
    {feature_name:'cron_user_run_manual',user_id:'one',use_count:2},
    {feature_name:'cron_user_run_auto',user_id:'one',use_count:3},
    {feature_name:'cron_created',user_id:'two',use_count:1},
    {feature_name:'mascot_petted',user_id:'one',use_count:2},
    {feature_name:'mascot_tossed',user_id:'one',use_count:1},
    {feature_name:'waterfall_manual',user_id:'one',use_count:3},
    {feature_name:'waterfall_manual',user_id:'two',use_count:1},
    {feature_name:'waterfall_auto',user_id:'two',use_count:10},
    {feature_name:'settings_tab_mcp',user_id:'one',use_count:2},
  ]);
  assert.equal(summaries.cronStatsRes.results[0].active_cron_users,2);
  assert.equal(summaries.cronStatsRes.results[0].user_auto_runs,3);
  assert.equal(summaries.mascotStatsRes.results[0].engaged_users,1);
  assert.equal(summaries.waterfallFrequencyRes.results.reduce((n,r)=>n+r.invocations,0),4);
  assert.deepEqual(summaries.settingsTabsRes.results,[{tab:'mcp',users:1,visits:2}]);
});

test('one session scan preserves distinct users and original bucket rules',()=>{
  const base={client:'vscode',os:'windows',country:'IN',provider:'ollama',model:'model',created_at:new Date().toISOString()};
  const summaries=sessionSummaries([
    {...base,user_id:'one',turn_count:0}, {...base,user_id:'one',turn_count:3},
    {...base,user_id:'two',turn_count:1},
  ]);
  assert.deepEqual(summaries.clientsRes.results,[{client:'vscode',users:2,sessions:3}]);
  assert.equal(summaries.modelsRes.results[0].users,2);
  assert.deepEqual(summaries.turnDistRes.results.map(r=>r.sessions),[1,1,1]);
});

test('unfiltered reads use indexed raw tables instead of materializing event views',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  await stats(db);
  const recent=db.queries.find(sql=>sql.includes('WITH recent AS'));
  assert.ok(recent);
  assert.equal(recent.includes('scoped_events'),false);
  assert.equal(recent.includes('all_activity'),false);
  const error=db.queries.find(sql=>sql.includes('AS affected_users'));
  assert.ok(error.includes('FROM feature_events'));
  assert.equal(error.includes('FROM scoped_features'),false);
  db.sqlite.close();
});

test('grouped legacy error checks preserve event totals without per-turn feature scans',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  for (let i=0;i<20;i++) await ingestTelemetry(db,{event:'session_end',had_error:true},fields());
  const result=await stats(db);
  assert.equal(result.error_stats.total_errors,20);
  assert.equal(result.error_stats.error_sessions,1);
  assert.equal(result.error_stats.affected_users,1);
  await ingestTelemetry(db,{event:'feature_use',feature_name:'error_generic'},fields());
  db.sqlite.exec('DELETE FROM telemetry_stats_cache');
  assert.equal((await stats(db)).error_stats.total_errors,1);
  db.sqlite.close();
});
test('session end joins do not multiply sessions or work categories',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  for (const turns of [1,2]) await ingestTelemetry(db,{event:'session_end',turn_count:turns,tool_file_count:turns},fields());
  const result=await stats(db);
  assert.equal(result.recent_sessions.length,1);
  assert.equal(result.recent_sessions[0].turn_count,2);
  assert.equal(result.work_intent.reduce((n,r)=>n+r.sessions,0),1);
  assert.equal(result.summary.total_returning_users,0);
  db.sqlite.close();
});
test('full-window MAU exceeds the recent-session limit and resumed sessions count today',async()=>{
  const db=database();
  for(let i=0;i<105;i++) await ingestTelemetry(db,{event:'session_start'},fields({userId:'user-number-'+i,sessionId:'session-number-'+i}));
  db.sqlite.prepare("UPDATE sessions SET date='2020-01-01',created_at='2020-01-01T00:00:00Z'").run();
  const result=await stats(db);
  assert.equal(result.window_activity.mau,105);
  assert.equal(result.recent_sessions.length,100);
  assert.equal(result.summary.today.dau,105);
  db.sqlite.close();
});
test('combined cohort filters execute exact intersections with bound parameters',async()=>{
  const db=database();
  await ingestTelemetry(db,{event:'session_start'},fields());
  await ingestTelemetry(db,{event:'session_start'},fields({userId:'user-other-123',sessionId:'session-other',country:'US',provider:'anthropic'}));
  const result=await getD1Stats({DB:db},new URLSearchParams('country=IN&provider=ollama&version=0.2.14'));
  assert.equal(result.summary.total_users,1); assert.equal(result.window_activity.mau,1);
  assert.equal(result.recent_sessions.length,1);
  const empty=await getD1Stats({DB:db},new URLSearchParams({provider:"ollama' OR 1=1 --"}));
  assert.equal(empty.summary.total_users,0);
  db.sqlite.close();
});
test('finished-before-start and retried task events preserve one outcome',async()=>{
  const db=database(); const run_id='run-1234567890123456';
  await ingestTelemetry(db,{event:'task_finished',run_id,outcome:'failed',active_seconds:4,event_id:'event-end-123456789'},fields());
  await ingestTelemetry(db,{event:'task_started',run_id,event_id:'event-start-1234567'},fields());
  const result=await stats(db);
  assert.equal(result.task_outcomes.started,1);assert.equal(result.task_outcomes.failed,1);
  assert.equal(result.task_outcomes.unknown,0);db.sqlite.close();
});
test('read key cannot authorize administrative deletion',async()=>{
  const response=await worker.fetch(new Request('https://telemetry.test/api/admin/purge-user',{
    method:'POST',headers:{'x-stats-key':'read-secret','Content-Type':'application/json'},body:'{"user_id":"user-12345678"}'
  }),{STATS_SECRET:'read-secret',ADMIN_SECRET:'admin-secret'},{waitUntil(){}});
  assert.equal(response.status,401);
});

test('regular users include older IDs and feature-only activity does not invent sessions',async()=>{
  const db=database();
  const yesterday=new Date(Date.now()-86400000).toISOString();
  await ingestTelemetry(db,{event:'feature_use',feature_name:'app_started'},fields({date:yesterday.slice(0,10),now:yesterday}));
  await ingestTelemetry(db,{event:'feature_use',feature_name:'app_started'},fields());
  db.sqlite.prepare("UPDATE users SET first_seen='2020-01-01T00:00:00Z'").run();
  const result=await stats(db);
  assert.equal(result.window_activity.segments.regular_users,1);
  assert.equal(result.window_activity.segments.new_users,0);
  assert.equal(result.summary.today.sessions,0);
  assert.equal(result.window_activity.sessions_30d,0);
  db.sqlite.close();
});

test('delayed retries retain their occurrence date and receipt owner',async()=>{
  const db=database();
  const occurred=Date.now()/1000-86400;
  const response=await worker.fetch(new Request('https://telemetry.test/event',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      event:'feature_use',feature_name:'app_started',user_id:'user-12345678',client:'vscode',
      event_id:'event-delayed-12345678',occurred_at:occurred,
    })
  }),{DB:db},{waitUntil(){}});
  assert.equal(response.status,202);
  const row=db.sqlite.prepare('SELECT date FROM activity_facts').get();
  assert.equal(row.date,new Date(occurred*1000).toISOString().slice(0,10));
  assert.equal(db.sqlite.prepare('SELECT user_id FROM telemetry_receipts').get().user_id,'user-12345678');
  db.sqlite.close();
});
