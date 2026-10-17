const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BOT_USER_AGENT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|curl|wget|python|axios|node-fetch|go-http/i;
const MAX_ADMIN_BODY = 256 * 1024;
const MAX_VIEW_BODY = 512;
const PREVIEW_TTL_SECONDS = 3600;
export const DEFAULT_SITE_ORIGIN = 'https://andromity.agenticmarket.dev';

const LIMITS = { slug: 120, title: 200, description: 400, category: 40, author: 100, author_url: 300 };
const POST_COLUMNS = 'id, slug, title, description, category, author, author_url, status, published_at, created_at, updated_at';
const PUBLIC_COLUMNS = 'slug, title, description, category, author, author_url, published_at, updated_at';

function json(body, status, headers, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
  });
}

/** Validates post fields. With `partial`, absent fields are left out instead of defaulted. */
export function cleanPostInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const values = {};
  for (const field of ['slug', 'title', 'description', 'category', 'author', 'author_url']) {
    if (input[field] === undefined) {
      if (!partial) values[field] = '';
      continue;
    }
    if (typeof input[field] !== 'string') return { error: `${field} must be a string` };
    const value = input[field].trim();
    if (value.length > LIMITS[field]) return { error: `${field} is longer than ${LIMITS[field]} characters` };
    values[field] = value;
  }
  if (values.slug !== undefined && !SLUG_PATTERN.test(values.slug)) {
    return { error: 'slug must be lowercase letters, numbers and single hyphens' };
  }
  if (values.title !== undefined && !values.title) return { error: 'title is required' };
  if (values.author_url) {
    let parsed;
    try { parsed = new URL(values.author_url); } catch { return { error: 'author_url must be a URL' }; }
    if (parsed.protocol !== 'https:') return { error: 'author_url must use https' };
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string') return { error: 'body must be a string' };
    values.body = input.body.replace(/\r\n?/g, '\n');
  } else if (!partial) {
    values.body = '';
  }
  if (input.published_at !== undefined) {
    const date = input.published_at === null ? '' : String(input.published_at).trim();
    if (date && (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
      return { error: 'published_at must be a YYYY-MM-DD date' };
    }
    values.published_at = date || null;
  } else if (!partial) {
    values.published_at = null;
  }
  return { values };
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function previewSignature(secret, id, expires) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`blog-preview.${id}.${expires}`)));
}

export async function createPreviewToken(secret, id, now = Date.now()) {
  const expires = Math.floor(now / 1000) + PREVIEW_TTL_SECONDS;
  return { token: `${id}.${expires}.${await previewSignature(secret, id, expires)}`, expires_at: new Date(expires * 1000).toISOString() };
}

/** Returns the post id a preview token grants, or null if it is malformed, forged or expired. */
export async function verifyPreviewToken(secret, token, now = Date.now()) {
  const match = /^(\d{1,12})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!secret || !match) return null;
  const [, id, expires, signature] = match;
  if (Number(expires) * 1000 < now) return null;
  const expected = await previewSignature(secret, id, expires);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0 ? Number(id) : null;
}

function allowedOrigins(env) {
  return (env.BLOG_SITE_ORIGIN || DEFAULT_SITE_ORIGIN).split(',').map((origin) => origin.trim()).filter(Boolean);
}

async function readBody(request, limit) {
  const text = await request.text();
  if (text.length > limit) return { tooLarge: true };
  try { return { data: JSON.parse(text) }; } catch { return { data: null }; }
}

async function getPost(db, id) {
  return db.prepare(`SELECT ${POST_COLUMNS}, body FROM blog_posts WHERE id = ?`).bind(id).first();
}

async function recordView(request, env, headers) {
  const done = new Response(null, { status: 204, headers });
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins(env).includes(origin)) return done;
  if (BOT_USER_AGENT.test(request.headers.get('User-Agent') || '')) return done;
  const { data, tooLarge } = await readBody(request, MAX_VIEW_BODY);
  const slug = typeof data?.slug === 'string' ? data.slug : '';
  if (tooLarge || !SLUG_PATTERN.test(slug) || slug.length > LIMITS.slug) return done;
  await env.DB.prepare(
    `INSERT INTO blog_views (post_id, date, views)
     SELECT id, date('now'), 1 FROM blog_posts WHERE slug = ? AND status = 'published'
     ON CONFLICT(post_id, date) DO UPDATE SET views = views + 1`
  ).bind(slug).run();
  return done;
}

async function handlePublic(request, env, path, headers) {
  if (request.method === 'POST' && path === '/api/blog/view') return recordView(request, env, headers);
  if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405, headers);

  if (path === '/api/blog/posts') {
    const { results } = await env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC, id DESC`
    ).all();
    return json({ posts: results }, 200, headers, 'public, max-age=60');
  }

  const postMatch = /^\/api\/blog\/posts\/([a-z0-9-]{1,120})$/.exec(path);
  if (postMatch) {
    const post = await env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS}, body FROM blog_posts WHERE slug = ? AND status = 'published'`
    ).bind(postMatch[1]).first();
    return post ? json({ post }, 200, headers, 'public, max-age=60') : json({ error: 'Not Found' }, 404, headers);
  }

  const previewMatch = /^\/api\/blog\/preview\/([^/]{1,100})$/.exec(path);
  if (previewMatch) {
    const id = await verifyPreviewToken(env.ADMIN_SECRET, previewMatch[1]);
    const post = id === null ? null : await getPost(env.DB, id);
    return post ? json({ post }, 200, headers) : json({ error: 'Preview link is invalid or expired' }, 404, headers);
  }

  return json({ error: 'Not Found' }, 404, headers);
}

async function handleAdmin(request, env, path, headers) {
  const collection = path === '/api/admin/blog/posts';
  const match = /^\/api\/admin\/blog\/posts\/(\d{1,12})(?:\/(publish|unpublish|delete|preview-token))?$/.exec(path);
  if (!collection && !match) return json({ error: 'Not Found' }, 404, headers);

  if (collection && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.slug, p.title, p.description, p.category, p.author, p.author_url, p.status, p.published_at, p.created_at, p.updated_at,
              COALESCE(SUM(v.views), 0) AS views_total,
              COALESCE(SUM(CASE WHEN v.date >= date('now', '-6 days') THEN v.views END), 0) AS views_7d,
              COALESCE(SUM(CASE WHEN v.date >= date('now', '-29 days') THEN v.views END), 0) AS views_30d
       FROM blog_posts p LEFT JOIN blog_views v ON v.post_id = p.id
       GROUP BY p.id ORDER BY p.updated_at DESC, p.id DESC`
    ).all();
    return json({ posts: results }, 200, headers);
  }

  if (collection && request.method === 'POST') {
    const { data, tooLarge } = await readBody(request, MAX_ADMIN_BODY);
    if (tooLarge) return json({ error: 'Post is larger than 256 KB' }, 413, headers);
    const { values, error } = cleanPostInput(data);
    if (error) return json({ error }, 400, headers);
    try {
      const created = await env.DB.prepare(
        `INSERT INTO blog_posts (slug, title, description, category, author, author_url, body, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(values.slug, values.title, values.description, values.category, values.author, values.author_url, values.body, values.published_at).first();
      return json({ post: await getPost(env.DB, created.id) }, 201, headers);
    } catch (err) {
      if (String(err?.message || err).includes('UNIQUE')) return json({ error: `A post with the slug "${values.slug}" already exists` }, 409, headers);
      throw err;
    }
  }

  const id = Number(match[1]);
  const action = match[2];
  const existing = await getPost(env.DB, id);
  if (!existing) return json({ error: 'Post not found' }, 404, headers);

  if (!action && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT date, views FROM blog_views WHERE post_id = ? AND date >= date('now', '-29 days') ORDER BY date`
    ).bind(id).all();
    return json({ post: existing, daily_views: results }, 200, headers);
  }
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, headers);

  if (!action) {
    const { data, tooLarge } = await readBody(request, MAX_ADMIN_BODY);
    if (tooLarge) return json({ error: 'Post is larger than 256 KB' }, 413, headers);
    const { values, error } = cleanPostInput(data, { partial: true });
    if (error) return json({ error }, 400, headers);
    if (existing.status === 'published' && values.slug !== undefined && values.slug !== existing.slug) {
      return json({ error: 'Unpublish the post before changing its slug, so published links keep working' }, 409, headers);
    }
    const fields = Object.keys(values);
    if (fields.length) {
      try {
        await env.DB.prepare(
          `UPDATE blog_posts SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        ).bind(...fields.map((field) => values[field]), id).run();
      } catch (err) {
        if (String(err?.message || err).includes('UNIQUE')) return json({ error: `A post with the slug "${values.slug}" already exists` }, 409, headers);
        throw err;
      }
    }
    return json({ post: await getPost(env.DB, id) }, 200, headers);
  }

  if (action === 'publish') {
    const missing = ['title', 'description', 'body'].filter((field) => !String(existing[field] || '').trim());
    if (missing.length) return json({ error: `Add ${missing.join(', ')} before publishing` }, 400, headers);
    await env.DB.prepare(
      `UPDATE blog_posts SET status = 'published', published_at = COALESCE(published_at, date('now')), updated_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return json({ post: await getPost(env.DB, id) }, 200, headers);
  }

  if (action === 'unpublish') {
    await env.DB.prepare(`UPDATE blog_posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?`).bind(id).run();
    return json({ post: await getPost(env.DB, id) }, 200, headers);
  }

  if (action === 'delete') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM blog_views WHERE post_id = ?').bind(id),
      env.DB.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id),
    ]);
    return json({ deleted: id }, 200, headers);
  }

  if (!env.ADMIN_SECRET) return json({ error: 'Previews need ADMIN_SECRET to be set' }, 503, headers);
  return json(await createPreviewToken(env.ADMIN_SECRET, id), 200, headers);
}

/**
 * Blog routes. Public: the published list and posts, signed draft previews, and the
 * cookieless view beacon. Admin (`isAdmin` required): drafts, publishing and read counts.
 * Returns null for paths that are not blog routes.
 */
export async function handleBlogRequest(request, env, { url, headers, isAdmin }) {
  const path = url.pathname;
  const admin = path.startsWith('/api/admin/blog/');
  if (!admin && !path.startsWith('/api/blog/')) return null;
  if (!env.DB) return json({ error: 'Database not bound' }, 500, headers);
  if (admin && !isAdmin) return json({ error: 'Unauthorized' }, 401, headers);
  try {
    return admin ? await handleAdmin(request, env, path, headers) : await handlePublic(request, env, path, headers);
  } catch (err) {
    console.error('Blog request failed:', err);
    return json({ error: 'Blog request failed' }, 500, headers);
  }
}
