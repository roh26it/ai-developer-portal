import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockMgmtPlane } from '../dev/mock-mgmt-plane.js';
import { createApp } from '../server.js';

let mock;
const apps = [];

// One app per signed-in user, because DEV_LOGIN_EMAIL fixes the identity of /auth/login.
async function signIn(email) {
  const server = createApp({
    MGMT_PLANE_BASE_URL: mock.url, MGMT_ADMIN_KEY: 'mock-key', GATEWAY_URL: 'https://gateway.example.com/v1',
    SESSION_SECRET: 'test-secret-test-secret-test-secret', DEV_LOGIN_EMAIL: email,
  });
  await new Promise(r => server.listen(0, r));
  apps.push(server);
  const base = `http://localhost:${server.address().port}`;
  const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { base, call };
}

let sarah, diane;   // sarah: member of ws-quant, manager of ws-data. diane: member of ws-data.
before(async () => {
  mock = await startMockMgmtPlane();
  sarah = await signIn('sarah.chen@example.com');
  diane = await signIn('diane.kowalski@example.com');
});
after(async () => {
  for (const s of apps) await new Promise(r => s.close(r));
  await mock.close();
});
const lastCall = (method, path) => mock.state.calls.findLast(c => c.method === method && c.path === path);

test('API needs a session', async () => {
  const r = await fetch(`${sarah.base}/api/me`);
  assert.equal(r.status, 401);
});

test('/api/me returns the role per workspace and no service key', async () => {
  const { status, body } = await sarah.call('GET', '/api/me');
  assert.equal(status, 200);
  assert.equal(body.user.name, 'Sarah Chen');
  assert.deepEqual(body.workspaces.map(w => [w.id, w.role]).sort(), [['ws-data', 'manager'], ['ws-quant', 'member']]);
  assert.ok(!JSON.stringify(body).includes('mock-key'));
});

test('members cannot use manager routes', async () => {
  assert.equal((await sarah.call('GET', '/api/w/ws-quant/keys?scope=all')).status, 403);
  assert.equal((await sarah.call('GET', '/api/w/ws-quant/members')).status, 403);
  assert.equal((await sarah.call('GET', '/api/w/ws-quant/overview?scope=workspace')).status, 403);
});

test('unknown workspace is 404', async () => {
  assert.equal((await diane.call('GET', '/api/w/ws-quant/keys')).status, 404);
});

test('member creates own key; full key only in the create response', async () => {
  const created = await sarah.call('POST', '/api/w/ws-quant/keys',
    { name: 'laptop', env: 'Production', rate: 30, unit: 'rpm', credit_limit: 100, alert: 75, user_id: 'u-marco', _user: 'x@evil' });
  assert.equal(created.status, 403);   // user_id for someone else is refused

  const ok = await sarah.call('POST', '/api/w/ws-quant/keys', { name: 'laptop', env: 'Production', rate: 30, unit: 'rpm', credit_limit: 100, alert: 75 });
  assert.equal(ok.status, 201);
  assert.match(ok.body.full, /^sk-mock-/);
  const sent = lastCall('POST', '/api-keys/workspace/user').body;
  assert.equal(sent.user_id, 'u-sarah');
  assert.equal(sent.workspace_id, 'ws-quant');
  assert.deepEqual(sent.defaults.metadata, { environment: 'Production', _user: 'sarah.chen@example.com' });
  assert.deepEqual(sent.usage_limits, { type: 'cost', credit_limit: 100, periodic_reset: 'monthly', alert_threshold: 75 });

  const list = await sarah.call('GET', '/api/w/ws-quant/keys');
  const mine = list.body.find(k => k.id === ok.body.id);
  assert.ok(mine);
  assert.ok(!JSON.stringify(list.body).includes(ok.body.full));
  assert.ok(list.body.every(k => k.type === 'user'));
  assert.ok(!list.body.some(k => k.id === 'k5c6'));   // marco's key is hidden
});

test('member cannot rotate or delete another user\'s key', async () => {
  assert.equal((await sarah.call('DELETE', '/api/w/ws-quant/keys/k5c6')).status, 404);
  assert.equal((await sarah.call('POST', '/api/w/ws-quant/keys/k5c6/rotate')).status, 404);
  assert.ok(mock.state.keys.some(k => k.id === 'k5c6'));
});

test('member rotates and deletes own key', async () => {
  const rot = await sarah.call('POST', '/api/w/ws-quant/keys/k1a2/rotate');
  assert.equal(rot.status, 200);
  assert.match(rot.body.full, /^sk-mock-/);
  assert.ok(rot.body.old_key_expires_at);
  assert.deepEqual(lastCall('POST', '/api-keys/k1a2/rotate').body, {});
  assert.equal((await sarah.call('DELETE', '/api/w/ws-quant/keys/k1a2')).status, 200);
  assert.ok(!mock.state.keys.some(k => k.id === 'k1a2'));
});

test('member cannot create a service key', async () => {
  assert.equal((await diane.call('POST', '/api/w/ws-data/keys', { name: 'svc', type: 'service' })).status, 403);
});

test('manager creates a key for a member and a service key', async () => {
  const forDiane = await sarah.call('POST', '/api/w/ws-data/keys', { name: 'for-diane', user_id: 'u-diane' });
  assert.equal(forDiane.status, 201);
  const userBody = lastCall('POST', '/api-keys/workspace/user').body;
  assert.equal(userBody.user_id, 'u-diane');
  assert.equal(userBody.defaults.metadata._user, 'diane.kowalski@example.com');

  const svc = await sarah.call('POST', '/api/w/ws-data/keys', { name: 'etl', type: 'service', credit_limit: 200 });
  assert.equal(svc.status, 201);
  const svcBody = lastCall('POST', '/api-keys/workspace/service').body;
  assert.equal(svcBody.user_id, undefined);
  assert.equal(svcBody.defaults.metadata._user, undefined);

  const outsider = await sarah.call('POST', '/api/w/ws-data/keys', { name: 'x', user_id: 'u-marco' });
  assert.equal(outsider.status, 400);   // marco is not in ws-data

  const all = await sarah.call('GET', '/api/w/ws-data/keys?scope=all');
  const byName = Object.fromEntries(all.body.map(k => [k.name, k]));
  assert.equal(byName['for-diane'].owner, 'Diane Kowalski');
  assert.equal(byName.etl.type, 'service');
  assert.equal(byName.etl.owner, null);
});

test('writes need a JSON content type', async () => {
  const r = await sarah.call('POST', '/api/w/ws-quant/keys', { name: 'x' }, { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('overview filters by _user and converts cents to dollars', async () => {
  const { status, body } = await diane.call('GET', '/api/w/ws-data/overview?scope=me');
  assert.equal(status, 200);
  const q = lastCall('GET', '/analytics/graphs/cost').query;
  assert.equal(q.workspace_slug, 'data-platform');
  assert.deepEqual(JSON.parse(q.metadata), { _user: 'diane.kowalski@example.com' });
  const requests = body.series.reduce((s, p) => s + p.requests, 0);
  assert.equal(body.requests, requests);
  assert.ok(Math.abs(body.spend - requests * 0.014) < 0.01);
});

test('members page shows usage per _user and the rest as unattributed', async () => {
  const { status, body } = await sarah.call('GET', '/api/w/ws-data/members');
  assert.equal(status, 200);
  const mine = (await sarah.call('GET', '/api/w/ws-data/overview?scope=me')).body;
  const total = (await sarah.call('GET', '/api/w/ws-data/overview?scope=workspace')).body;
  const sarahRow = body.find(m => m.email === 'sarah.chen@example.com');
  assert.equal(sarahRow.requests, mine.requests);
  assert.equal(body.at(-1).id, 'unattributed');
  assert.equal(body.reduce((s, r) => s + r.requests, 0), total.requests);
});

test('catalog lists enabled models as @provider/model with USD per 1M tokens', async () => {
  const { body } = await diane.call('GET', '/api/w/ws-data/catalog');
  const sonnet = body.models.find(m => m.id === '@anthropic-prod/claude-sonnet-5');
  assert.equal(sonnet.provider, 'Anthropic');
  assert.ok(Math.abs(sonnet.input - 3) < 1e-9 && Math.abs(sonnet.output - 15) < 1e-9);
  assert.ok(!body.models.some(m => m.id.endsWith('gpt-4o-mini')));
  assert.equal(body.mcpServers.length, 2);
});
