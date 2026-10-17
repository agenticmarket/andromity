import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.js';
import { cleanPostInput, createPreviewToken, verifyPreviewToken, DEFAULT_SITE_ORIGIN } from './blog.js';

const SECRET = 'admin-secret-for-tests';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./blog.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

function client() {
  const env = { DB: d1(), ADMIN_SECRET: SECRET };
  const call = async (path, { method = 'GET', body, admin = false, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`https://telemetry.test${path}`, {
      method,
      headers: { ...(admin ? { 'x-stats-key': SECRET } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }), env, {});
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const view = (slug, headers = {}) => call('/api/blog/view', {
    method: 'POST', body: JSON.stringify({ slug }),
    headers: { Origin: DEFAULT_SITE_ORIGIN, 'User-Agent': 'Mozilla/5.0 Firefox/131.0', 'Content-Type': 'text/plain', ...headers },
  });
  return { env, call, view };
}

const draft = { slug: 'try-a-model', title: 'Try a model', description: 'How to run it.', category: 'MODEL LAUNCH', author: 'Shekhar Pachlore', author_url: 'https://github.com/shekharP1536', body: '# Hello\n\nBody text.' };

test('admin routes need the admin secret', async () => {
  const { call } = client();
  assert.equal((await call('/api/admin/blog/posts')).status, 401);
  assert.equal((await call('/api/admin/blog/posts', { headers: { 'x-stats-key': 'wrong' } })).status, 401);
  assert.equal((await call('/api/admin/blog/posts', { admin: true })).status, 200);
});

test('drafts stay private until published and previews need a valid token', async () => {
  const { call } = client();
  const created = await call('/api/admin/blog/posts', { method: 'POST', body: draft, admin: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.post.status, 'draft');
  assert.deepEqual((await call('/api/blog/posts')).data.posts, []);
  assert.equal((await call('/api/blog/posts/try-a-model')).status, 404);

  const { data: { token } } = await call(`/api/admin/blog/posts/${created.data.post.id}/preview-token`, { method: 'POST', admin: true });
  const preview = await call(`/api/blog/preview/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.post.body, draft.body);
  const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await call(`/api/blog/preview/${forged}`)).status, 404);
});

test('publishing makes the post public and keeps its slug fixed', async () => {
  const { call } = client();
  const { data: { post } } = await call('/api/admin/blog/posts', { method: 'POST', body: { ...draft, description: '' }, admin: true });
  assert.equal((await call(`/api/admin/blog/posts/${post.id}/publish`, { method: 'POST', admin: true })).status, 400);
  await call(`/api/admin/blog/posts/${post.id}`, { method: 'POST', body: { description: 'How to run it.' }, admin: true });
  const published = await call(`/api/admin/blog/posts/${post.id}/publish`, { method: 'POST', admin: true });
  assert.equal(published.data.post.status, 'published');
  assert.match(published.data.post.published_at, /^\d{4}-\d{2}-\d{2}$/);

  const list = await call('/api/blog/posts');
  assert.deepEqual(list.data.posts.map((p) => p.slug), ['try-a-model']);
  assert.equal(list.data.posts[0].body, undefined);
  assert.equal((await call('/api/blog/posts/try-a-model')).data.post.body, draft.body);

  const renamed = await call(`/api/admin/blog/posts/${post.id}`, { method: 'POST', body: { slug: 'new-slug' }, admin: true });
  assert.equal(renamed.status, 409);
  await call(`/api/admin/blog/posts/${post.id}/unpublish`, { method: 'POST', admin: true });
  assert.equal((await call('/api/blog/posts/try-a-model')).status, 404);
  assert.equal((await call(`/api/admin/blog/posts/${post.id}`, { method: 'POST', body: { slug: 'new-slug' }, admin: true })).status, 200);
});

test('duplicate slugs and invalid fields are rejected', async () => {
  const { call } = client();
  await call('/api/admin/blog/posts', { method: 'POST', body: draft, admin: true });
  assert.equal((await call('/api/admin/blog/posts', { method: 'POST', body: draft, admin: true })).status, 409);
  assert.equal((await call('/api/admin/blog/posts', { method: 'POST', body: { ...draft, slug: 'Bad Slug' }, admin: true })).status, 400);
  assert.match(cleanPostInput({ ...draft, author_url: 'http://example.com' }).error, /https/);
  assert.match(cleanPostInput({ ...draft, published_at: '2026-13-45' }).error, /YYYY-MM-DD/);
  assert.equal(cleanPostInput({ ...draft, body: 'a\r\nb' }).values.body, 'a\nb');
  assert.deepEqual(Object.keys(cleanPostInput({ title: 'Only title' }, { partial: true }).values), ['title']);
});

test('the view beacon counts published posts from the site only, without storing visitor data', async () => {
  const { env, call, view } = client();
  const { data: { post } } = await call('/api/admin/blog/posts', { method: 'POST', body: draft, admin: true });
  assert.equal((await view('try-a-model')).status, 204);
  await call(`/api/admin/blog/posts/${post.id}/publish`, { method: 'POST', admin: true });
  await view('try-a-model');
  await view('try-a-model');
  await view('try-a-model', { Origin: 'https://evil.example' });
  await view('try-a-model', { 'User-Agent': 'Googlebot/2.1' });
  await view('missing-post');

  const rows = env.DB.sqlite.prepare('SELECT * FROM blog_views').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['date', 'post_id', 'views']);
  assert.equal(rows[0].views, 2);

  const listed = (await call('/api/admin/blog/posts', { admin: true })).data.posts[0];
  assert.equal(listed.views_total, 2);
  assert.equal(listed.views_7d, 2);
  assert.equal((await call(`/api/admin/blog/posts/${post.id}`, { admin: true })).data.daily_views[0].views, 2);

  await call(`/api/admin/blog/posts/${post.id}/delete`, { method: 'POST', admin: true });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM blog_views').get().n, 0);
  assert.equal((await call(`/api/admin/blog/posts/${post.id}`, { admin: true })).status, 404);
});

test('preview tokens expire and are bound to the secret', async () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const { token } = await createPreviewToken(SECRET, 7, now);
  assert.equal(await verifyPreviewToken(SECRET, token, now), 7);
  assert.equal(await verifyPreviewToken('another-secret', token, now), null);
  assert.equal(await verifyPreviewToken(SECRET, token, now + 2 * 3600 * 1000), null);
  assert.equal(await verifyPreviewToken(SECRET, 'not-a-token', now), null);
});
