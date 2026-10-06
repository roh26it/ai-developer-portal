// In-memory stand-in for the management plane, for local dev and tests.
// It implements only the endpoints that server.js calls, with the spec's response shapes.
import http from 'node:http';
import crypto from 'node:crypto';

const DAY = 86_400_000;

function seed() {
  const now = new Date().toISOString();
  const key = (id, name, ws, user_id, extra = {}) => ({
    id, name, key: `sk-${id.slice(0, 2)}*******${id.slice(-2)}`, type: user_id ? 'workspace-user' : 'workspace-service',
    workspace_id: ws, user_id, status: 'active', created_at: now, rate_limits: [{ type: 'requests', unit: 'rpm', value: 60 }],
    defaults: { metadata: { environment: 'Development' } }, ...extra,
  });
  const budget = (credit_limit, alert_threshold) => ({ type: 'cost', credit_limit, alert_threshold, periodic_reset: 'monthly' });
  return {
    users: [
      { id: 'u-sarah', email: 'sarah.chen@example.com', first_name: 'Sarah', last_name: 'Chen', workspace_ids: ['ws-quant', 'ws-data'] },
      { id: 'u-diane', email: 'diane.kowalski@example.com', first_name: 'Diane', last_name: 'Kowalski', workspace_ids: ['ws-data'] },
      { id: 'u-marco', email: 'marco.ruiz@example.com', first_name: 'Marco', last_name: 'Ruiz', workspace_ids: ['ws-quant'] },
    ],
    workspaces: [
      { id: 'ws-quant', slug: 'quant-research', name: 'Quant Research' },
      { id: 'ws-data', slug: 'data-platform', name: 'Data Platform' },
    ],
    roles: { 'ws-quant': { 'u-sarah': 'member', 'u-marco': 'manager' }, 'ws-data': { 'u-sarah': 'manager', 'u-diane': 'member' } },
    keys: [
      key('k1a2', 'notebook-experiments', 'ws-quant', 'u-sarah', { usage_limits: budget(300, 240) }),
      key('k3b4', 'prod-ingestion-service', 'ws-quant', 'u-sarah', { usage_limits: budget(1500, 1200), rate_limits: [{ type: 'requests', unit: 'rpm', value: 600 }], defaults: { metadata: { environment: 'Production' } } }),
      key('k5c6', 'marco-sandbox', 'ws-quant', 'u-marco'),
      key('k7d8', 'pipeline-dev', 'ws-data', 'u-sarah'),
      key('k9e0', 'batch-backfill', 'ws-data', 'u-diane', { status: 'exhausted', usage_limits: budget(20, 18) }),
      key('kaf1', 'etl-service', 'ws-data', null, { usage_limits: budget(2000, 1600) }),
    ],
    providers: [
      { slug: 'anthropic-prod', name: 'Anthropic', integration_id: 'int-anthropic', status: 'active' },
      { slug: 'openai-prod', name: 'OpenAI', integration_id: 'int-openai', status: 'active' },
    ],
    integrations: [
      { id: 'int-anthropic', slug: 'anthropic', name: 'Anthropic', ai_provider_id: 'anthropic' },
      { id: 'int-openai', slug: 'openai', name: 'OpenAI', ai_provider_id: 'openai' },
    ],
    models: {
      anthropic: [['claude-sonnet-5', 3, 15], ['claude-opus-5-5', 15, 75], ['claude-haiku-4-5', 1, 5]],
      openai: [['gpt-4o', 2.5, 10], ['gpt-4o-mini', 0.15, 0.6, false]],
    },
    mcpServers: [
      { slug: 'internal-docs', name: 'Internal Docs Search', auth_type: 'oauth', status: 'active', description: 'Search the internal knowledge base.', url: 'https://gateway.example.com/internal-docs/mcp' },
      { slug: 'market-data', name: 'Market Data', auth_type: 'headers', status: 'active', description: 'Real-time and historical market data tools.', url: 'https://gateway.example.com/market-data/mcp' },
    ],
    calls: [],
  };
}

// Deterministic daily traffic so screenshots and tests are stable.
const daily = (ts, scale) => Math.round((3200 + Math.sin(ts / DAY / 2) * 600) * scale);
const scaleFor = q => (q.get('api_key_ids') ? 0.04 : q.get('metadata') ? 0.3 : 1);

export function startMockMgmtPlane({ port = 0, apiKey = 'mock-key' } = {}) {
  const s = seed();
  const page = (rows, q) => {
    const size = Number(q.get('page_size')) || rows.length || 1, cur = Number(q.get('current_page')) || 0;
    return { object: 'list', total: rows.length, data: rows.slice(cur * size, cur * size + size) };
  };
  const member = (wsId, u) => ({ object: 'workspace-user', id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, role: s.roles[wsId][u.id], status: 'active', workspace_id: wsId });

  const routes = [
    ['GET', /^\/admin\/users$/, (q) => page(s.users.filter(u => !q.get('email') || u.email === q.get('email')), q)],
    ['GET', /^\/admin\/workspaces\/([^/]+)$/, (q, [id]) => s.workspaces.find(w => w.id === id) || 404],
    ['GET', /^\/admin\/workspaces\/([^/]+)\/users$/, (q, [id]) => page(s.users
      .filter(u => s.roles[id]?.[u.id] && (!q.get('email') || u.email === q.get('email'))).map(u => member(id, u)), q)],
    ['GET', /^\/api-keys$/, (q) => page(s.keys.filter(k => k.workspace_id === q.get('workspace_id')), q)],
    ['GET', /^\/api-keys\/([^/]+)$/, (q, [id]) => s.keys.find(k => k.id === id) || 404],
    ['DELETE', /^\/api-keys\/([^/]+)$/, (q, [id]) => { const n = s.keys.length; s.keys = s.keys.filter(k => k.id !== id); return n === s.keys.length ? 404 : {}; }],
    ['POST', /^\/api-keys\/workspace\/(user|service)$/, (q, [sub], body) => {
      const full = `sk-mock-${crypto.randomBytes(12).toString('hex')}`, id = crypto.randomUUID();
      s.keys.push({ ...body, id, key: `${full.slice(0, 4)}*******${full.slice(-2)}`, type: `workspace-${sub}`, status: 'active', created_at: new Date().toISOString(), user_id: body.user_id ?? null });
      return { id, key: full, object: 'api-key' };
    }],
    ['POST', /^\/api-keys\/([^/]+)\/rotate$/, (q, [id]) => {
      const k = s.keys.find(x => x.id === id); if (!k) return 404;
      const full = `sk-mock-${crypto.randomBytes(12).toString('hex')}`;
      k.key = `${full.slice(0, 4)}*******${full.slice(-2)}`;
      return { id, key: full, key_transition_expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }],
    ['GET', /^\/analytics\/graphs\/(cost|requests)$/, (q, [metric]) => {
      const from = Date.parse(q.get('time_of_generation_min')), to = Date.parse(q.get('time_of_generation_max'));
      const data_points = [];
      for (let t = Math.floor(from / DAY) * DAY; t <= to; t += DAY) {
        const r = daily(t, scaleFor(q));
        data_points.push({ timestamp: new Date(t).toISOString(), total: metric === 'cost' ? r * 1.4 : r });
      }
      const total = data_points.reduce((a, p) => a + p.total, 0);
      return { object: 'analytics-graph', summary: { total }, data_points };
    }],
    ['GET', /^\/providers$/, (q) => page(s.providers, q)],
    ['GET', /^\/integrations$/, (q) => page(s.integrations, q)],
    ['GET', /^\/integrations\/([^/]+)\/models$/, (q, [slug]) => {
      const models = (s.models[slug] || []).map(([m, input, output, enabled = true]) => ({
        slug: m, name: m, enabled,
        pricing_config: { type: 'static', pay_as_you_go: { request_token: { price: input / 10_000 }, response_token: { price: output / 10_000 } } },
      }));
      return { total: models.length, models };
    }],
    ['GET', /^\/mcp-servers$/, (q) => page(s.mcpServers, q)],
  ];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers['x-portkey-api-key'] !== apiKey) return send(401, { message: 'Invalid API key' });
      const body = raw ? JSON.parse(raw) : undefined;
      s.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      for (const [method, re, fn] of routes) {
        const m = req.method === method && url.pathname.match(re);
        if (!m) continue;
        const out = fn(url.searchParams, m.slice(1), body);
        return out === 404 ? send(404, { message: 'Not found' }) : send(200, out);
      }
      send(404, { message: `No mock for ${req.method} ${url.pathname}` });
    });
  });

  return new Promise(resolve => server.listen(port, () => resolve({
    url: `http://localhost:${server.address().port}`,
    state: s,
    close: () => new Promise(r => server.close(r)),
  })));
}
