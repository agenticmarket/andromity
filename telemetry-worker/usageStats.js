import { buildStatsScope } from './statsScope.js';

const finished = "('completed','failed','cancelled')";
const installCutoff = "date('now','-6 days','weekday 1','-49 days')";
const lastDays = span => `days(date) AS (
    SELECT date('now','-${span} days')
    UNION ALL SELECT date(date,'+1 day') FROM days WHERE date < date('now')
  )`;

export function usageQueries(params, db) {
  const scope = buildStatsScope(params);
  const undated = new URLSearchParams(params);
  undated.delete('timeRange');
  const dimensionScope = buildStatsScope(undated);
  const span = Math.min(29, scope.rangeDays ?? 29);
  const usage = scope.tables;
  const fixed = dimensionScope.tables;
  return [
    scope.prepareExplicit(db, `WITH ${lastDays(span)}, prompt_days AS (
        SELECT date, user_id FROM ${usage.tasks} WHERE date >= date('now','-${span} days')
        UNION
        SELECT date, user_id FROM ${usage.sessions} WHERE date >= date('now','-${span} days')
      ), user_days AS (
        SELECT a.date,
          CASE WHEN date(u.first_seen) >= a.date THEN 'new'
            WHEN date(u.first_seen) >= date(a.date,'-6 days') THEN 'week' ELSE 'older' END AS installed,
          p.user_id IS NOT NULL AS used
        FROM (SELECT DISTINCT date, user_id FROM ${usage.activity} WHERE date >= date('now','-${span} days')) a
        JOIN users u ON u.user_id=a.user_id
        LEFT JOIN prompt_days p ON p.date=a.date AND p.user_id=a.user_id
      )
      SELECT d.date, COUNT(ud.date) AS opened,
        COUNT(CASE WHEN ud.installed='new' THEN 1 END) AS opened_new,
        COUNT(CASE WHEN ud.installed='week' THEN 1 END) AS opened_week,
        COUNT(CASE WHEN ud.installed='older' THEN 1 END) AS opened_older,
        COUNT(CASE WHEN ud.used THEN 1 END) AS used,
        COUNT(CASE WHEN ud.used AND ud.installed='new' THEN 1 END) AS used_new,
        COUNT(CASE WHEN ud.used AND ud.installed='week' THEN 1 END) AS used_week,
        COUNT(CASE WHEN ud.used AND ud.installed='older' THEN 1 END) AS used_older
      FROM days d LEFT JOIN user_days ud ON ud.date=d.date
      GROUP BY d.date ORDER BY d.date DESC`),
    dimensionScope.prepareExplicit(db, `WITH weeks(week_start) AS (
        SELECT date('now','-6 days','weekday 1')
        UNION ALL SELECT date(week_start,'-7 days') FROM weeks WHERE week_start > ${installCutoff}
      ), last_prompt AS (
        SELECT user_id, MAX(date) AS last_date FROM (
          SELECT user_id, date FROM ${fixed.tasks} WHERE date >= ${installCutoff}
          UNION ALL
          SELECT user_id, date FROM ${fixed.sessions} WHERE date >= ${installCutoff}
        ) GROUP BY user_id
      ), members AS (
        SELECT date(u.first_seen,'-6 days','weekday 1') AS week_start, date(u.first_seen) AS first_day, p.last_date
        FROM users u LEFT JOIN last_prompt p ON p.user_id=u.user_id
        WHERE u.first_seen >= ${installCutoff}
          ${dimensionScope.hasScope ? 'AND u.user_id IN (SELECT user_id FROM scoped_activity)' : ''}
      )
      SELECT w.week_start, COUNT(m.week_start) AS installs, COUNT(m.last_date) AS used,
        COUNT(CASE WHEN m.last_date > m.first_day THEN 1 END) AS came_back,
        CASE WHEN date(w.week_start,'+13 days') < date('now')
          THEN COUNT(CASE WHEN m.last_date >= date(m.first_day,'+7 days') THEN 1 END) END AS used_after_7d,
        CASE WHEN date(w.week_start,'+20 days') < date('now')
          THEN COUNT(CASE WHEN m.last_date >= date(m.first_day,'+14 days') THEN 1 END) END AS used_after_14d
      FROM weeks w LEFT JOIN members m ON m.week_start=w.week_start
      GROUP BY w.week_start ORDER BY w.week_start DESC`),
    // A session is counted once, on the date of its latest finished turn (recency 1 among finished turns).
    dimensionScope.prepareExplicit(db, `WITH ${lastDays(29)}, turns AS (
        SELECT date, outcome, outcome IN ${finished} AS finished,
          ROW_NUMBER() OVER (PARTITION BY user_id, session_id, outcome IN ${finished}
            ORDER BY date DESC, started_at DESC, run_id DESC) AS recency
        FROM ${fixed.tasks} WHERE date >= date('now','-29 days')
      )
      SELECT d.date, COUNT(t.date) AS turns,
        COUNT(CASE WHEN t.finished THEN 1 END) AS finished_turns,
        COUNT(CASE WHEN t.outcome='failed' THEN 1 END) AS failed_turns,
        COUNT(CASE WHEN t.finished AND t.recency=1 THEN 1 END) AS sessions,
        COUNT(CASE WHEN t.outcome='failed' AND t.recency=1 THEN 1 END) AS last_turn_failed_sessions
      FROM days d LEFT JOIN turns t ON t.date=d.date
      GROUP BY d.date ORDER BY d.date DESC`),
  ];
}

const rate = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : null);

const split = (row, name) => ({
  total: row[name], new: row[`${name}_new`], week: row[`${name}_week`], older: row[`${name}_older`],
});

function reliability(days) {
  const sum = key => days.reduce((total, day) => total + day[key], 0);
  const finishedTurns = sum('finished_turns');
  const failedTurns = sum('failed_turns');
  const sessions = sum('sessions');
  const lastTurnFailed = sum('last_turn_failed_sessions');
  return {
    turns: sum('turns'),
    finished_turns: finishedTurns,
    failed_turns: failedTurns,
    failure_rate: rate(failedTurns, finishedTurns),
    sessions,
    last_turn_failed_sessions: lastTurnFailed,
    last_turn_failure_rate: rate(lastTurnFailed, sessions),
  };
}

export function usageResults([daily, cohorts, turns]) {
  const turnDays = turns.results ?? [];
  return {
    usage_daily: (daily.results ?? []).map(row => ({
      date: row.date, opened: split(row, 'opened'), used: split(row, 'used'),
    })),
    cohorts: (cohorts.results ?? []).map(row => ({
      week_start: row.week_start,
      installs: row.installs,
      used: row.used,
      came_back: row.came_back,
      used_after_7d: row.used_after_7d ?? null,
      used_after_14d: row.used_after_14d ?? null,
    })),
    turn_reliability: {
      // Turn rows are the gap-filled last 30 days, newest first.
      last_7d: reliability(turnDays.slice(0, 7)),
      last_30d: reliability(turnDays),
      daily: turnDays.map(row => ({
        date: row.date,
        turns: row.turns,
        finished_turns: row.finished_turns,
        failed_turns: row.failed_turns,
        failure_rate: rate(row.failed_turns, row.finished_turns),
      })),
    },
  };
}
