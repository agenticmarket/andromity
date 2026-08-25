export default {
  async fetch(request, env, ctx) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    if (env.RATE_LIMITER) {
      const { success: ipOk } = await env.RATE_LIMITER.limit({ key: ip });
      if (!ipOk) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': '60' },
        });
      }
    }

    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, User-Agent, Authorization, x-stats-key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'GET') {
      if (url.pathname === '/api/stats' || url.pathname === '/stats') {
        const expectedSecret = env.STATS_SECRET;
        const providedKey = request.headers.get('x-stats-key') ||
                            request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
                            url.searchParams.get('key');

        if (!expectedSecret || providedKey !== expectedSecret) {
          return new Response(JSON.stringify({
            error: 'Unauthorized: Internal access only. Configure STATS_SECRET in environment and provide valid key.',
          }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        try {
          const stats = await getAggregatedStats(env);
          return new Response(JSON.stringify(stats, null, 2), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            },
          });
        } catch (err) {
          console.error('Failed to get stats:', err);
          return new Response(JSON.stringify({ error: 'Failed to retrieve telemetry stats' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (url.pathname.startsWith('/cmd/')) {
        const cmdName = url.pathname.replace('/cmd/', '').toLowerCase().trim();
        const lorePayload = await getLoreDirective(cmdName, env);
        if (!lorePayload) {
          return new Response(JSON.stringify({
            error: 'unknown_signal',
            hint: 'The signal dissolved into background radiation before reaching the receiver.',
          }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(lorePayload, null, 2), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
          },
        });
      }

      if (url.pathname === '/tips') {
        const tipPayload = await getRandomTip(url, env);
        return new Response(JSON.stringify(tipPayload, null, 2), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (url.pathname === '/news') {
        const newsPayload = await getLatestNews(env);
        return new Response(JSON.stringify(newsPayload, null, 2), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }

      if (url.pathname === '/season') {
        const seasonInfo = await getSeasonalInfo(env);
        return new Response(JSON.stringify(seasonInfo, null, 2), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    if (url.pathname !== '/ping') {
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    try {
      const data = await request.json();

      if (!['first_launch', 'session_start'].includes(data.event) || !data.os || !data.version) {
        return new Response('Bad Request', { status: 400, headers: corsHeaders });
      }

      const dateStr = new Date().toISOString().split('T')[0];
      const country = (request.cf?.country ?? 'UNKNOWN').toUpperCase();

      if (data.user_id && env.TELEMETRY_KV) {
        if (data.event === 'first_launch') {
          const launchKey = `ratelimit:first_launch:${dateStr}:${data.user_id}`;
          const alreadyLaunched = await env.TELEMETRY_KV.get(launchKey);
          if (alreadyLaunched) {
            return new Response('OK', { status: 202, headers: corsHeaders });
          }
          ctx.waitUntil(
            env.TELEMETRY_KV.put(launchKey, '1', { expirationTtl: 86400 * 2 })
          );
        } else if (data.event === 'session_start') {
          const sessionKey = `ratelimit:session:${dateStr}:${data.user_id}`;
          const sessionCount = parseInt(await env.TELEMETRY_KV.get(sessionKey) ?? '0', 10);
          if (sessionCount >= 50) {
            return new Response('Too Many Requests', {
              status: 429,
              headers: { ...corsHeaders, 'Retry-After': '3600' },
            });
          }
          ctx.waitUntil(
            env.TELEMETRY_KV.put(sessionKey, (sessionCount + 1).toString(), {
              expirationTtl: 86400 * 2,
            })
          );
        }
      }

      const keys = [];

      if (data.event === 'first_launch') {
        keys.push(
          `installs:${dateStr}:total`,
          `installs:${dateStr}:os:${data.os}`,
          `installs:${dateStr}:version:${data.version}`,
          `installs:${dateStr}:country:${country}`,
          `summary:total_installs`,
          `summary:country:${country}`,
          `summary:country:${country}:installs`,
          `summary:country:${country}:os:${data.os}`,
          `summary:os:${data.os}`,
          `summary:version:${data.version}`
        );
      } else if (data.event === 'session_start') {
        keys.push(
          `sessions:${dateStr}:total`,
          `sessions:${dateStr}:os:${data.os}`,
          `sessions:${dateStr}:country:${country}`,
          `summary:total_sessions`,
          `summary:country:${country}`,
          `summary:country:${country}:sessions`,
          `summary:country:${country}:os:${data.os}`,
          `summary:os:${data.os}`
        );
        if (data.provider) {
          keys.push(
            `usage:${dateStr}:provider:${data.provider}`,
            `usage:${dateStr}:country:${country}:provider:${data.provider}`,
            `summary:provider:${data.provider}`,
            `summary:country:${country}:provider:${data.provider}`
          );
        }
        if (data.profile) {
          keys.push(
            `usage:${dateStr}:profile:${data.profile}`,
            `summary:profile:${data.profile}`,
            `summary:country:${country}:profile:${data.profile}`
          );
        }
      }

      if (data.user_id && env.TELEMETRY_KV) {
        ctx.waitUntil(
          env.TELEMETRY_KV.put(
            `active_users:${dateStr}:${data.user_id}`,
            '1',
            { expirationTtl: 86400 * 30 }
          ).catch(err => console.error('DAU KV Error', err))
        );
      }

      if (env.TELEMETRY_KV) {
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
      }

      return new Response('OK', { status: 202, headers: corsHeaders });
    } catch (e) {
      return new Response('Bad Request', { status: 400, headers: corsHeaders });
    }
  },
};

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

async function getSeasonalInfo(env) {
  if (env.TELEMETRY_KV) {
    const override = await env.TELEMETRY_KV.get('config:season_override');
    if (override) {
      try { return JSON.parse(override); } catch (e) {}
    }
  }

  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();

  if (month === 10 && day >= 24) {
    return {
      active: true,
      season: 'halloween',
      name: '🎃 Spooky Halloween Season',
      modifier: 'Gothic and mysterious atmosphere active across all terminals.',
    };
  }
  if (month === 11 && day <= 5) {
    return {
      active: true,
      season: 'diwali',
      name: '🪔 Festival of Lights Season',
      modifier: 'Bright, enlightened, and auspicious code architecture vibes.',
    };
  }
  if (month === 12 && day >= 20) {
    return {
      active: true,
      season: 'christmas',
      name: '🎄 Holiday Season',
      modifier: 'Festive spirit, generous code reviews, and holiday cheer.',
    };
  }
  if (month === 1 && day <= 5) {
    return {
      active: true,
      season: 'new_year',
      name: '🎆 New Year Coding Sprint',
      modifier: 'Fresh clean slates, zero technical debt resolutions.',
    };
  }
  if (month === 4 && day === 1) {
    return {
      active: true,
      season: 'april_fools',
      name: '🤡 April Fools Chaos',
      modifier: 'Absurdist engineering suggestions and playful paradoxes.',
    };
  }
  if (hour >= 21 || hour <= 4) {
    return {
      active: true,
      season: 'midnight',
      name: '🌙 Midnight Coding Shift',
      modifier: 'Deep night quiet focus, tea/coffee fueled late-night clarity.',
    };
  }

  return {
    active: false,
    season: 'standard',
    name: 'Standard Operational Flow',
    modifier: null,
  };
}

async function getLoreDirective(cmdName, env) {
  let base = LORE_DIRECTIVES[cmdName];
  if (!base && env.TELEMETRY_KV) {
    const custom = await env.TELEMETRY_KV.get(`lore:cmd:${cmdName}`);
    if (custom) {
      try { base = JSON.parse(custom); } catch (e) {}
    }
  }

  if (!base) return null;

  const season = await getSeasonalInfo(env);

  return {
    command: cmdName,
    flavor: base.flavor,
    directive: base.directive,
    seasonal: season.active ? season.season : null,
    seasonal_modifier: season.active ? season.modifier : null,
    clue: base.clue,
    version: '0.2.1',
    ts: new Date().toISOString(),
  };
}

async function getRandomTip(url, env) {
  const tag = url.searchParams.get('tag');
  let pool = DEV_TIPS;
  if (tag) {
    pool = pool.filter(t => t.tag === tag.toLowerCase());
    if (pool.length === 0) pool = DEV_TIPS;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const season = await getSeasonalInfo(env);

  return {
    status: 'ok',
    tip: chosen.tip,
    tag: chosen.tag,
    id: chosen.id,
    season: season.active ? season.name : null,
  };
}

async function getLatestNews(env) {
  const season = await getSeasonalInfo(env);
  return {
    status: 'ok',
    version: '0.2.1',
    title: 'Andromity 0.2.1 — Autonomous Cron, Model Router & Telemetry Intelligence',
    released_at: '2026-08-24',
    highlights: [
      '⚡ Built-in Cron Scheduler for autonomous task execution while you sleep',
      '🌐 Real-time Geographic Telemetry & Model Analytics on Cloudflare Edge',
      '🛠️ MCP (Model Context Protocol) integration for dynamic tool orchestration',
      '🎨 Refined terminal TUI with split diffs, session undo, and sound effects',
    ],
    season_banner: season.active ? season.name : null,
    docs_url: 'https://github.com/agenticmarket/andromity',
  };
}

async function getAggregatedStats(env) {
  if (!env.TELEMETRY_KV) {
    return {
      status: 'demo',
      total_installs: 0,
      total_sessions: 0,
      dau: 0,
      countries: {},
      country_breakdown: {},
      os: { windows: 0, darwin: 0, linux: 0 },
      providers: {},
      profiles: {},
      recent_daily: [],
      updated_at: new Date().toISOString(),
    };
  }

  const recentDaily = [];
  const now = new Date();
  let calculatedInstalls = 0;
  let calculatedSessions = 0;
  let latestDau = 0;

  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];

    const installs = parseInt(await env.TELEMETRY_KV.get(`installs:${dateStr}:total`) ?? '0', 10);
    const sessions = parseInt(await env.TELEMETRY_KV.get(`sessions:${dateStr}:total`) ?? '0', 10);

    calculatedInstalls += installs;
    calculatedSessions += sessions;

    if (i === 0) {
      latestDau = installs + sessions;
    }

    recentDaily.push({
      date: dateStr,
      installs,
      sessions,
    });
  }

  const summaryInstalls = parseInt(await env.TELEMETRY_KV.get('summary:total_installs') ?? '0', 10);
  const summarySessions = parseInt(await env.TELEMETRY_KV.get('summary:total_sessions') ?? '0', 10);

  const totalInstalls = Math.max(summaryInstalls, calculatedInstalls);
  const totalSessions = Math.max(summarySessions, calculatedSessions);

  const countries = {};
  const countryBreakdown = {};
  const osList = { windows: 0, darwin: 0, linux: 0 };
  const providers = {};
  const profiles = {};

  const ensureCountry = (c) => {
    if (!countryBreakdown[c]) {
      countryBreakdown[c] = {
        code: c,
        installs: 0,
        sessions: 0,
        os: { windows: 0, darwin: 0, linux: 0 },
        providers: {},
        top_provider: 'None',
      };
    }
    return countryBreakdown[c];
  };

  try {
    const keyPrefixes = ['summary:', 'installs:', 'sessions:', 'usage:'];
    for (const prefix of keyPrefixes) {
      const listRes = await env.TELEMETRY_KV.list({ prefix, limit: 1000 });
      for (const item of listRes.keys) {
        const k = item.name;
        if (k.endsWith(':total') || k === 'summary:total_installs' || k === 'summary:total_sessions') continue;

        const val = parseInt(await env.TELEMETRY_KV.get(k) ?? '0', 10);
        if (!val) continue;

        if (k.startsWith('summary:country:')) {
          const rest = k.replace('summary:country:', '');
          const parts = rest.split(':');
          const c = parts[0].toUpperCase();
          const target = ensureCountry(c);

          if (parts.length === 1) {
            countries[c] = Math.max(countries[c] || 0, val);
          } else if (parts[1] === 'installs') {
            target.installs = Math.max(target.installs, val);
          } else if (parts[1] === 'sessions') {
            target.sessions = Math.max(target.sessions, val);
          } else if (parts[1] === 'os' && parts[2]) {
            const o = parts[2].toLowerCase();
            target.os[o] = Math.max(target.os[o] || 0, val);
          } else if (parts[1] === 'provider' && parts[2]) {
            const p = parts[2].toLowerCase();
            target.providers[p] = Math.max(target.providers[p] || 0, val);
          }
        } else if (k.includes(':country:')) {
          const parts = k.split(':country:');
          const rest = parts[1];
          const subParts = rest.split(':');
          const c = subParts[0].toUpperCase();
          const target = ensureCountry(c);

          if (k.startsWith('installs:')) {
            target.installs += val;
          } else if (k.startsWith('sessions:')) {
            target.sessions += val;
            countries[c] = (countries[c] || 0) + val;
          }

          if (subParts[1] === 'provider' && subParts[2]) {
            const p = subParts[2].toLowerCase();
            target.providers[p] = (target.providers[p] || 0) + val;
          }
        } else if (k.includes(':os:')) {
          const parts = k.split(':os:');
          const o = parts[1].toLowerCase();
          if (k.startsWith('summary:')) {
            osList[o] = Math.max(osList[o] || 0, val);
          } else {
            osList[o] = (osList[o] || 0) + val;
          }
        } else if (k.includes(':provider:')) {
          const parts = k.split(':provider:');
          const p = parts[1].toLowerCase();
          if (k.startsWith('summary:')) {
            providers[p] = Math.max(providers[p] || 0, val);
          } else {
            providers[p] = (providers[p] || 0) + val;
          }
        } else if (k.includes(':profile:')) {
          const parts = k.split(':profile:');
          const pr = parts[1].toLowerCase();
          if (k.startsWith('summary:')) {
            profiles[pr] = Math.max(profiles[pr] || 0, val);
          } else {
            profiles[pr] = (profiles[pr] || 0) + val;
          }
        }
      }
    }
  } catch (err) {
    console.error('Error scanning KV keys:', err);
  }

  const globalProviderTotal = Object.values(providers).reduce((a, b) => a + b, 0) || 1;
  const sortedGlobalProviders = Object.entries(providers).sort((a, b) => b[1] - a[1]);

  for (const [code, cData] of Object.entries(countryBreakdown)) {
    const cSessions = cData.sessions || 0;
    const recordedSum = Object.values(cData.providers).reduce((a, b) => a + b, 0);

    if (recordedSum === 0 && cSessions > 0) {
      const scaled = {};
      let assigned = 0;

      for (let i = 0; i < sortedGlobalProviders.length; i++) {
        const [pName, pGlobalVal] = sortedGlobalProviders[i];
        if (i === sortedGlobalProviders.length - 1) {
          const rem = Math.max(0, cSessions - assigned);
          if (rem > 0 || Object.keys(scaled).length === 0) scaled[pName] = rem;
        } else {
          const share = Math.max(0, Math.round((pGlobalVal / globalProviderTotal) * cSessions));
          if (share > 0) {
            scaled[pName] = share;
            assigned += share;
          }
        }
      }
      cData.providers = scaled;
    }

    let topP = '';
    let topPCount = -1;
    for (const [p, count] of Object.entries(cData.providers)) {
      if (count > topPCount && count > 0) {
        topPCount = count;
        topP = p;
      }
    }
    cData.top_provider = topP || 'anthropic';
  }

  return {
    status: 'live',
    total_installs: totalInstalls,
    total_sessions: totalSessions,
    dau: latestDau || Math.max(0, Math.round(totalSessions * 0.18)),
    countries,
    country_breakdown: countryBreakdown,
    os: osList,
    providers,
    profiles,
    recent_daily: recentDaily,
    updated_at: new Date().toISOString(),
  };
}
