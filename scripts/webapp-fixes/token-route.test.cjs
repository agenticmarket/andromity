const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('../../vscode-extension/node_modules/typescript');
const source = ts.transpileModule(readFileSync(join(__dirname, 'andromity-token-route.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(fetch, authenticated = true) {
  const exports = {};
  const deps = {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/auth': { auth: { api: { getSession: async () => authenticated ? { user: { id: 'user', name: 'dev' } } : null } } },
    '../../../../../db': { db: { select: () => ({ from: () => ({ where: async () => [{ username: 'developer' }] }) }) } },
    '../../../../../db/schema': { user: {} }, 'drizzle-orm': { eq: () => undefined },
    'node:crypto': require('node:crypto'),
  };
  new Script(source).runInNewContext({ exports, require: name => deps[name], process: { env: {} }, fetch, AbortSignal });
  return exports.GET({ headers: new Headers() });
}

test('registration failures never return an IDE token', async () => {
  for (const fetch of [async () => new Response('{}', { status: 500 }), async () => { throw new Error('timeout'); }]) {
    const response = await harness(fetch);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).token, undefined);
  }
});
test('successful registration returns the exact random token registered with gateway', async () => {
  const registered = [];
  const response = await harness(async (_url, options) => {
    registered.push(JSON.parse(options.body).token);
    return new Response('{}');
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.token, registered[0]);
  assert.match(data.token, /^andromity_[a-f0-9]{64}$/);
  assert.equal(registered[1], 'andromity_developer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
test('signed out callers cannot register a token', async () => {
  const response = await harness(async () => { throw new Error('must not register'); }, false);
  assert.equal(response.status, 401);
});
test('dashboard registration outage preserves the successfully registered IDE token', async () => {
  let calls = 0;
  const response = await harness(async () => {
    if (++calls === 2) throw new Error('dashboard timeout');
    return new Response('{}');
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).token);
});
