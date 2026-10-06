const result = rows => ({ results: rows });
const order = (rows, metric, label) => rows.sort((a,b) => b[metric]-a[metric] ||
  (String(a[label]) < String(b[label]) ? -1 : String(a[label]) > String(b[label]) ? 1 : 0));

export function sessionSummaries(rows) {
  const grouped = (column, fallback, predicate = () => true, limit) => {
    const groups = new Map();
    for (const row of rows.filter(predicate)) {
      const key = row[column] ?? fallback;
      if (!groups.has(key)) groups.set(key, { [column]:key, users:new Set(),sessions:0,
        ...(column==='model' ? {provider:row.provider ?? 'unknown'} : {}) });
      const group = groups.get(key); group.users.add(row.user_id); group.sessions++;
    }
    const values = [...groups.values()].map(row=>({...row,users:row.users.size}));
    return result(order(values,column==='country'?'users':'sessions',column).slice(0,limit));
  };
  const cutoff = new Date(Date.now()-7*86400000).toISOString().slice(0,19).replace('T',' ');
  const hours = new Map();
  const turns = new Map();
  for (const row of rows) {
    if (row.created_at >= cutoff) {
      const hour = row.created_at.slice(11,13);
      hours.set(hour,(hours.get(hour)||0)+1);
    }
    const bucket = row.turn_count===0 ? '0 turns (bounce)' : row.turn_count===1 ? '1 turn' :
      row.turn_count>=2 && row.turn_count<=4 ? '2-4 turns' : '5+ turns';
    if (!turns.has(bucket)) turns.set(bucket,{bucket,sessions:0,users:new Set()});
    turns.get(bucket).sessions++; turns.get(bucket).users.add(row.user_id);
  }
  const turnOrder=['0 turns (bounce)','1 turn','2-4 turns','5+ turns'];
  return {
    clientsRes: grouped('client'), countriesRes: grouped('country','UNKNOWN',undefined,30),
    osRes: grouped('os','unknown'), versionsRes: grouped('version','0.0.0',undefined,20),
    providersRes: grouped('provider','unknown',r=>r.provider!=null && r.provider!=='unknown',20),
    modelsRes: grouped('model','unknown',r=>r.model!=null && r.model!=='unknown',30),
    providerTypesRes: grouped('provider_type','cloud'), reasoningRes: grouped('reasoning_effort','off'),
    profilesRes: grouped('profile','builder'),
    hourlyRes: result([...hours].sort().map(([hour,sessions])=>({hour,sessions}))),
    turnDistRes: result([...turns.values()].map(r=>({...r,users:r.users.size}))
      .sort((a,b)=>turnOrder.indexOf(a.bucket)-turnOrder.indexOf(b.bucket))),
  };
}

export function featureSummaries(rows) {
  const count = predicate => rows.filter(r=>predicate(r.feature_name)).reduce((sum,r)=>sum+r.use_count,0);
  const users = predicate => new Set(rows.filter(r=>predicate(r.feature_name)).map(r=>r.user_id)).size;
  const named = name => feature => feature===name;
  const grouped = (predicate, column, label) => {
    const groups = new Map();
    for (const row of rows.filter(r=>predicate(r.feature_name))) {
      const key=label(row.feature_name);
      if (!groups.has(key)) groups.set(key,{[column]:key,count:0,users:new Set()});
      const group=groups.get(key); group.count+=row.use_count; group.users.add(row.user_id);
    }
    return order([...groups.values()].map(r=>({...r,users:r.users.size})),'count',column);
  };
  const waterfall = new Map();
  for (const row of rows.filter(r=>r.feature_name==='waterfall_manual'))
    waterfall.set(row.user_id,(waterfall.get(row.user_id)||0)+row.use_count);
  const buckets=new Map();
  for (const count of waterfall.values()) {
    const bucket=count===1?'1 trace (Explorer)':count<=4?'2-4 traces (Engaged)':'5+ traces (Habitual Power User)';
    if (!buckets.has(bucket)) buckets.set(bucket,{bucket,users:0,invocations:0});
    const group=buckets.get(bucket); group.users++; group.invocations+=count;
  }
  const wfOrder=['1 trace (Explorer)','2-4 traces (Engaged)','5+ traces (Habitual Power User)'];
  return {
    featuresRes: result(grouped(()=>true,'feature',name=>name).slice(0,25)),
    onboardingRes: result([{viewed_users:users(named('onboarding_viewed')),
      provider_selected_users:users(f=>/^onboard.prov./.test(f)),
      key_saved_users:users(named('onboarding_key_saved')),completed_users:users(named('onboarding_completed'))}]),
    errorCategoriesRes: result(grouped(f=>/^error./.test(f),'category',name=>name)),
    cronStatsRes: result([{user_crons_created:count(named('cron_created')),
      user_manual_runs:count(named('cron_user_run_manual')),user_auto_runs:count(named('cron_user_run_auto')),
      user_toggled:count(named('cron_user_toggled')),seed_manual_runs:count(named('cron_seed_run_manual')),
      seed_auto_runs:count(named('cron_seed_run_auto')),active_cron_users:users(f=>/^cron.user./.test(f)||f==='cron_created')}]),
    mascotStatsRes: result([{petted_count:count(named('mascot_petted')),tossed_count:count(named('mascot_tossed')),
      engaged_users:users(f=>['mascot_petted','mascot_tossed'].includes(f)),
      enabled_count:count(named('mascot_enabled')),disabled_count:count(named('mascot_disabled'))}]),
    wallpaperStatsRes: result([{enabled_count:count(named('wallpaper_enabled')),disabled_count:count(named('wallpaper_disabled')),
      unique_users_enabled:users(named('wallpaper_enabled'))}]),
    settingsTabsRes: result(grouped(f=>/^settings.tab./.test(f),'tab',name=>name.replaceAll('settings_tab_',''))
      .map(({count,...row})=>({...row,visits:count}))),
    waterfallFrequencyRes: result([...buckets.values()].sort((a,b)=>wfOrder.indexOf(a.bucket)-wfOrder.indexOf(b.bucket))),
  };
}
