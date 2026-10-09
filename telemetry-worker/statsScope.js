const dimensions = ['country', 'client', 'os', 'version', 'provider', 'model'];

export function buildStatsScope(params = new URLSearchParams()) {
  const conditions = [];
  const bindings = [];
  for (const column of dimensions) {
    for (const [key, operator] of [[column, '='], ['exclude' + column[0].toUpperCase() + column.slice(1), '<>']]) {
      const value = params.get(column === 'os' && operator === '<>' ? 'excludeOS' : key);
      if (value) {
        if (value.length > 96) throw new Error('Invalid filter');
        conditions.push(`COALESCE(a.${column},'unknown') ${operator} ?`);
        bindings.push(value);
      }
    }
  }
  const range = params.get('timeRange') || 'all';
  const days = { today: 0, '7d': 6, '30d': 29 }[range];
  if (range !== 'all' && days === undefined) throw new Error('Invalid time range');
  if (days !== undefined) conditions.push(`a.date >= date('now', '-${days} days')`);
  const dateCondition = days === undefined ? '1=1' : `date >= date('now', '-${days} days')`;
  const hasScope = conditions.length > 0;
  const cte = `WITH all_activity AS (
    SELECT * FROM activity_facts
  ), scoped_activity AS (
    SELECT * FROM all_activity a WHERE ${conditions.join(' AND ') || '1=1'}
  ), scoped_sessions AS (
    SELECT * FROM sessions WHERE ${hasScope ? 'session_id IN (SELECT session_id FROM scoped_activity)' : '1=1'}
  ), scoped_users AS (
    SELECT u.user_id, u.first_seen, u.last_seen, u.country,
      COALESCE(counts.session_count,0) AS session_count
    FROM users u LEFT JOIN (SELECT user_id,COUNT(*) AS session_count FROM scoped_sessions GROUP BY user_id) counts
      ON counts.user_id=u.user_id
    WHERE ${hasScope ? 'u.user_id IN (SELECT user_id FROM scoped_activity)' : '1=1'}
  ), scoped_tasks AS (
    SELECT t.* FROM task_runs t WHERE ${dateCondition}
      AND EXISTS (SELECT 1 FROM scoped_activity a WHERE a.user_id=t.user_id
        AND a.session_id=t.session_id AND a.date=t.date)
  ), scoped_events AS NOT MATERIALIZED (
    SELECT * FROM events WHERE ${dateCondition}
      ${hasScope ? 'AND user_id IN (SELECT user_id FROM scoped_activity) AND session_id IN (SELECT session_id FROM scoped_activity)' : ''}
  ), scoped_features AS NOT MATERIALIZED (
    SELECT * FROM feature_events WHERE ${dateCondition}
      ${hasScope ? 'AND user_id IN (SELECT user_id FROM scoped_activity) AND session_id IN (SELECT session_id FROM scoped_activity)' : ''}
  )`;
  return {
    bindings,
    prepare(db, sql) {
      const scoped = sql.replace(/\b(FROM|JOIN)\s+(sessions|users|events|feature_events)\b/gi,
        (_, keyword, table) => `${keyword} ${ { sessions: hasScope ? 'scoped_sessions' : 'sessions',
          users: 'scoped_users', events: hasScope ? 'scoped_events' : 'events',
          feature_events: hasScope ? 'scoped_features' : 'feature_events' }[table.toLowerCase()]}`);
      if (!hasScope && !/\bscoped_(activity|tasks|users)\b/.test(scoped)) return db.prepare(scoped).bind();
      const combined = /^\s*WITH\s/i.test(scoped) ? cte + ',' + scoped.replace(/^\s*WITH\s/i, '') : cte + ' ' + scoped;
      return db.prepare(combined).bind(...bindings);
    },
  };
}

export function measurementQueries(scope, db) {
  const prepare = sql => scope.prepare(db, sql);
  return [
    prepare(`SELECT COUNT(DISTINCT CASE WHEN date >= date('now','-6 days') THEN user_id END) AS wau,
      COUNT(DISTINCT CASE WHEN date >= date('now','-29 days') THEN user_id END) AS mau,
      COUNT(DISTINCT CASE WHEN date >= date('now','-6 days') AND session_id IN (SELECT session_id FROM sessions) THEN session_id END) AS sessions_7d,
      COUNT(DISTINCT CASE WHEN date >= date('now','-29 days') AND session_id IN (SELECT session_id FROM sessions) THEN session_id END) AS sessions_30d,
      COUNT(DISTINCT CASE WHEN date >= date('now','-6 days') AND session_id IN (SELECT session_id FROM sessions) THEN user_id END) AS session_users_7d,
      COUNT(DISTINCT CASE WHEN date >= date('now','-29 days') AND session_id IN (SELECT session_id FROM sessions) THEN user_id END) AS session_users_30d,
      COUNT(DISTINCT CASE WHEN user_id IN (SELECT user_id FROM users WHERE date(first_seen)>=date('now','-6 days')) THEN user_id END) AS new_users_7d,
      COUNT(DISTINCT CASE WHEN user_id IN (SELECT user_id FROM users WHERE date(first_seen)>=date('now','-29 days')) THEN user_id END) AS new_users_30d
      FROM scoped_activity WHERE date >= date('now','-29 days')`),
    prepare(`SELECT
      SUM(last_date=date('now')) AS activeToday,
      SUM(last_date<date('now') AND last_date>=date('now','-6 days')) AS retainedWeekly,
      SUM(last_date<date('now','-6 days') AND last_date>=date('now','-13 days')) AS atRisk,
      SUM(last_date<date('now','-13 days')) AS dormant, COUNT(*) AS total
      FROM (SELECT user_id,MAX(date) AS last_date FROM scoped_activity GROUP BY user_id)`),
    prepare(`SELECT COUNT(DISTINCT CASE WHEN date(u.first_seen)<=date('now','-7 days') THEN u.user_id END) AS d7_eligible,
      COUNT(DISTINCT CASE WHEN date(u.first_seen)<=date('now','-7 days') AND EXISTS (
        SELECT 1 FROM all_activity a WHERE a.user_id=u.user_id AND a.date=date(u.first_seen,'+7 days')) THEN u.user_id END) AS d7_returned,
      COUNT(DISTINCT CASE WHEN date(u.first_seen)<=date('now','-30 days') THEN u.user_id END) AS d30_eligible,
      COUNT(DISTINCT CASE WHEN date(u.first_seen)<=date('now','-30 days') AND EXISTS (
        SELECT 1 FROM all_activity a WHERE a.user_id=u.user_id AND a.date=date(u.first_seen,'+30 days')) THEN u.user_id END) AS d30_returned FROM users u`),
    prepare(`SELECT COUNT(*) AS started, COUNT(CASE WHEN outcome='completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN outcome='failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN outcome='cancelled' THEN 1 END) AS cancelled,
      COUNT(CASE WHEN finished_at IS NULL THEN 1 END) AS unknown,
      AVG(CASE WHEN finished_at IS NOT NULL THEN active_seconds END) AS avg_active_seconds,
      (SELECT active_seconds FROM (
        SELECT active_seconds,ROW_NUMBER() OVER (ORDER BY active_seconds) AS rank,COUNT(*) OVER () AS total
        FROM scoped_tasks WHERE finished_at IS NOT NULL AND active_seconds IS NOT NULL
      ) WHERE rank=CAST((total+1)/2 AS INTEGER)) AS p50_active_seconds,
      (SELECT active_seconds FROM (
        SELECT active_seconds,ROW_NUMBER() OVER (ORDER BY active_seconds) AS rank,COUNT(*) OVER () AS total
        FROM scoped_tasks WHERE finished_at IS NOT NULL AND active_seconds IS NOT NULL
      ) WHERE rank=CAST((total*95+99)/100 AS INTEGER)) AS p95_active_seconds
      FROM scoped_tasks`),
    prepare(`SELECT COUNT(*) AS observed,
      SUM(EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.user_id)
        OR EXISTS(SELECT 1 FROM scoped_tasks t WHERE t.user_id=u.user_id)) AS prompted,
      SUM(EXISTS(SELECT 1 FROM scoped_tasks t WHERE t.user_id=u.user_id AND t.outcome='completed')) AS completed,
      SUM((SELECT COUNT(*) FROM scoped_tasks t WHERE t.user_id=u.user_id AND t.outcome='completed')>=2) AS repeat_completed
      FROM users u`),
    prepare(`SELECT SUM(is_new) AS new_users, SUM(days>=2) AS regular_users FROM (
      SELECT a.user_id,date(u.first_seen)>=date('now','-29 days') AS is_new,COUNT(DISTINCT a.date) AS days
      FROM scoped_activity a JOIN users u ON u.user_id=a.user_id
      WHERE a.date>=date('now','-29 days') GROUP BY a.user_id)`),
  ];
}
