// Backend-for-frontend over the management plane. The management plane accepts only an
// org API key and has no per-user auth, so this server holds the key, runs OIDC login,
// and enforces the member/manager rules before every call.
import http from 'node:http';
import crypto from 'node:crypto';
// A text import puts the UI inside the compiled binary, so the binary needs no files beside it.
import indexHtml from './public/index.html' with { type: 'text' };

const DAY = 86_400_000;
const RATE_UNITS = ['rps', 'rpm', 'rph', 'rpd'];
const num = v => Number(v) || 0;
const iso = t => new Date(t).toISOString().slice(0, 19) + 'Z';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp(env = process.env) {
  const port = Number(env.PORT) || 3000;
  const cfg = {
    mgmtUrl: (env.MGMT_PLANE_BASE_URL || '').replace(/\/$/, ''),
    mgmtKey: env.MGMT_ADMIN_KEY,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    sessionSecret: env.SESSION_SECRET || '',
    sessionHours: Number(env.SESSION_HOURS) || 8,
    oidc: { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET },
    devEmail: env.DEV_LOGIN_EMAIL?.toLowerCase(),
    ui: {
      portalName: env.PORTAL_NAME || 'AI Developer Portal',
      gatewayUrl: (env.GATEWAY_URL || '').replace(/\/$/, ''),
      adminConsoleName: env.ADMIN_CONSOLE_NAME || 'Admin Console',
      adminConsoleUrl: env.ADMIN_CONSOLE_URL || null,
      docsUrl: env.DOCS_URL || null,
    },
  };
  for (const v of ['MGMT_PLANE_BASE_URL', 'MGMT_ADMIN_KEY', 'GATEWAY_URL']) if (!env[v]) throw new Error(`${v} is required`);
  if (cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  if (cfg.devEmail && env.NODE_ENV === 'production') throw new Error('DEV_LOGIN_EMAIL is not allowed in production');
  if (!cfg.devEmail && !(cfg.oidc.issuer && cfg.oidc.clientId && cfg.oidc.clientSecret)) {
    throw new Error('Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (or DEV_LOGIN_EMAIL for local dev)');
  }
  const secureCookie = cfg.publicUrl.startsWith('https://');
  const redirectUri = `${cfg.publicUrl}/auth/callback`;

  /* ── Signed cookies (stateless, so any replica can serve any request) ── */
  const hmac = p => crypto.createHmac('sha256', cfg.sessionSecret).update(p).digest('base64url');
  const sign = obj => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${p}.${hmac(p)}`; };
  const unsign = v => {
    const [p, s] = (v || '').split('.');
    if (!s || s.length !== hmac(p).length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(hmac(p)))) return null;
    try { const obj = JSON.parse(Buffer.from(p, 'base64url')); return obj.exp > Date.now() ? obj : null; } catch { return null; }
  };
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean)
    .map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  const setCookie = (res, name, value, maxAgeSec) => res.appendHeader('Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`);

  /* ── Small in-memory cache; failures are not cached ── */
  const cache = new Map();
  const cached = (key, ttlMs, fn) => {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = fn();
    cache.set(key, { value, exp: Date.now() + ttlMs });
    value.catch(() => cache.delete(key));
    return value;
  };

  /* ── Management-plane client ── */
  async function mgmt(method, path, { query, body } = {}) {
    const url = new URL(cfg.mgmtUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method,
      // The management plane API reads the key from this header name.
      headers: { 'x-portkey-api-key': cfg.mgmtKey, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : {};
    console.error(`management plane ${method} ${url.pathname} -> ${r.status} ${text.slice(0, 300)}`);
    // 401/403 here mean our service key is wrong or lacks a scope; that is not the user's fault.
    if ([400, 404, 409, 422].includes(r.status)) {
      let msg; try { msg = JSON.parse(text).message; } catch {}
      throw new HttpError(r.status, msg || 'The management plane rejected the request');
    }
    throw new HttpError(502, 'The management plane is unavailable. Try again later.');
  }

  async function all(path, query = {}, pageSize = 100) {
    const rows = [];
    for (let page = 0; ; page++) {
      const r = await mgmt('GET', path, { query: { ...query, page_size: pageSize, current_page: page } });
      const data = r.data || [];
      rows.push(...data);
      if (data.length < pageSize || rows.length >= (r.total ?? Infinity)) return rows;
    }
  }

  const analytics = (ws, metric, from, to, extra = {}) => mgmt('GET', `/analytics/${metric}`, {
    query: { workspace_slug: ws.slug, time_of_generation_min: iso(from), time_of_generation_max: iso(to), ...extra },
  });
  const userFilter = email => ({ metadata: JSON.stringify({ _user: email }) });

  /* ── Identity: email → management-plane user → workspaces and role ── */
  const loadUser = email => cached(`user:${email}`, 60_000, async () => {
    const u = (await mgmt('GET', '/admin/users', { query: { email } })).data?.find(x => x.email?.toLowerCase() === email);
    if (!u) return null;
    // Self-hosted management planes omit workspace_ids, so check membership in every workspace instead.
    const ids = u.workspace_ids || (await all('/admin/workspaces')).map(w => w.id);
    const workspaces = await Promise.all(ids.map(async id => {
      const [ws, members] = await Promise.all([
        mgmt('GET', `/admin/workspaces/${encodeURIComponent(id)}`),
        mgmt('GET', `/admin/workspaces/${encodeURIComponent(id)}/users`, { query: { email } }),
      ]);
      const role = members.data?.find(m => m.email?.toLowerCase() === email)?.role;
      if (!role) return null;
      return { id: ws.id, slug: ws.slug, name: ws.name, role: role === 'admin' || role === 'manager' ? 'manager' : 'member' };
    }));
    return {
      id: u.id, email,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || email,
      workspaces: workspaces.filter(Boolean),
    };
  });

  const wsMembers = ws => cached(`members:${ws.id}`, 60_000, () => all(`/admin/workspaces/${encodeURIComponent(ws.id)}/users`));
  const fullName = m => [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email;

  /* ── Overview ── */
  async function overview(ws, email) {
    const now = Date.now(), filter = email ? userFilter(email) : {};
    const [cost, reqs, costPrev, reqsPrev] = await Promise.all([
      analytics(ws, 'graphs/cost', now - 30 * DAY, now, filter),
      analytics(ws, 'graphs/requests', now - 30 * DAY, now, filter),
      analytics(ws, 'graphs/cost', now - 60 * DAY, now - 30 * DAY, filter),
      analytics(ws, 'graphs/requests', now - 60 * DAY, now - 30 * DAY, filter),
    ]);
    const points = new Map();
    const at = ts => points.get(ts) || points.set(ts, { timestamp: ts, requests: 0, cost: 0 }).get(ts);
    for (const p of reqs.data_points || []) at(p.timestamp).requests = num(p.total);
    for (const p of cost.data_points || []) at(p.timestamp).cost = num(p.total) / 100;  // cents → USD
    return {
      spend: num(cost.summary?.total) / 100, spendPrev: num(costPrev.summary?.total) / 100,
      requests: num(reqs.summary?.total), requestsPrev: num(reqsPrev.summary?.total),
      series: [...points.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    };
  }

  /* ── API keys ── */
  const inWorkspace = (k, ws) => k.type?.startsWith('workspace-') && [ws.id, ws.slug].includes(k.workspace_id);

  // Start of the current budget period, so spend matches what the usage limit counts.
  function periodStart(k) {
    const ul = k.usage_limits;
    if (ul.next_usage_reset_at) {
      const d = new Date(ul.next_usage_reset_at);
      ul.periodic_reset === 'weekly' ? d.setUTCDate(d.getUTCDate() - 7) : d.setUTCMonth(d.getUTCMonth() - 1);
      return d;
    }
    const now = new Date();
    if (ul.periodic_reset === 'monthly') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (ul.periodic_reset === 'weekly') return new Date(now - 7 * DAY);
    return new Date(k.created_at || now - 30 * DAY);
  }

  async function toKey(k, ws, members) {
    const ul = k.usage_limits?.credit_limit ? k.usage_limits : null;
    const rl = k.rate_limits?.[0];
    const owner = members.find(m => m.id === k.user_id);
    const out = {
      id: k.id, name: k.name, key: k.key, status: k.status, created_at: k.created_at,
      type: k.type === 'workspace-service' ? 'service' : 'user',
      owner: k.type === 'workspace-service' ? null : owner ? fullName(owner) : k.user_id,
      env: k.defaults?.metadata?.environment || null,
      rate_limit: rl ? { value: rl.value, unit: rl.unit } : null,
      usage_limit: ul && {
        type: ul.type || 'cost', credit_limit: ul.credit_limit,
        alert_pct: ul.alert_threshold ? Math.round((ul.alert_threshold / ul.credit_limit) * 100) : 80,
      },
    };
    if (ul && out.usage_limit.type === 'cost') {
      const r = await analytics(ws, 'graphs/cost', periodStart(k), Date.now(), { api_key_ids: k.id });
      out.spend = num(r.summary?.total) / 100;
    }
    return out;
  }

  async function listKeys(ws, user, scope) {
    const [raw, members] = await Promise.all([all('/api-keys', { workspace_id: ws.id }), wsMembers(ws)]);
    const keys = raw.filter(k => inWorkspace(k, ws) && (scope === 'all' || k.user_id === user.id));
    return Promise.all(keys.map(k => toKey(k, ws, members)));
  }

  async function createKey(ws, user, b) {
    const name = String(b.name || '').trim();
    if (!name || name.length > 100) throw new HttpError(400, 'Give the key a name (max 100 characters)');
    const manager = ws.role === 'manager';
    const body = {
      name, workspace_id: ws.id, scopes: ['completions.write'],
      defaults: { metadata: { environment: b.env === 'Production' ? 'Production' : 'Development' } },
    };
    let path;
    if (b.type === 'service') {
      if (!manager) throw new HttpError(403, 'Only managers can create service keys');
      path = '/api-keys/workspace/service';
    } else {
      const ownerId = b.user_id || user.id;
      if (ownerId !== user.id && !manager) throw new HttpError(403, 'Only managers can create keys for other members');
      const owner = ownerId === user.id ? user : (await wsMembers(ws)).find(m => m.id === ownerId);
      if (!owner) throw new HttpError(400, 'That user is not a member of this workspace');
      // _user drives per-member analytics and budgets. Set it here, never from the browser.
      body.user_id = ownerId;
      body.defaults.metadata._user = owner.email.toLowerCase();
      path = '/api-keys/workspace/user';
    }
    if (b.rate) body.rate_limits = [{ type: 'requests', unit: RATE_UNITS.includes(b.unit) ? b.unit : 'rpm', value: Math.max(1, Math.round(num(b.rate))) }];
    if (b.credit_limit) {
      const limit = Math.max(1, Math.round(num(b.credit_limit)));
      const threshold = Math.floor((limit * Math.min(Math.max(num(b.alert) || 80, 1), 99)) / 100);
      body.usage_limits = { type: 'cost', credit_limit: limit, periodic_reset: 'monthly',
        ...(threshold >= 1 && threshold < limit && { alert_threshold: threshold }) };
    }
    const created = await mgmt('POST', path, { body });
    return { id: created.id, full: created.key };
  }

  // Members may act only on their own keys; managers on any key in the workspace.
  async function checkKey(ws, user, id) {
    const k = await mgmt('GET', `/api-keys/${encodeURIComponent(id)}`);
    if (!inWorkspace(k, ws) || (ws.role !== 'manager' && k.user_id !== user.id)) throw new HttpError(404, 'Key not found');
  }

  /* ── Members (manager) ── */
  // One graphs call per member instead of /analytics/groups/users, because some deployments
  // do not accept API keys on that path. Workspaces have few members.
  async function members(ws) {
    const now = Date.now();
    const usage = async filter => {
      const [reqs, cost] = await Promise.all(['graphs/requests', 'graphs/cost'].map(g => analytics(ws, g, now - 30 * DAY, now, filter)));
      return { requests: num(reqs.summary?.total), cost: num(cost.summary?.total) / 100 };
    };
    const list = await wsMembers(ws);
    // Every user key sets metadata._user to the owner's email.
    const [total, ...each] = await Promise.all([usage({}), ...list.map(m => usage(userFilter(m.email.toLowerCase())))]);
    const rows = list.map((m, i) => ({ id: m.id, name: fullName(m), email: m.email, role: m.role, ...each[i] }));
    const rest = {
      requests: total.requests - rows.reduce((s, r) => s + r.requests, 0),
      cost: Math.max(0, total.cost - rows.reduce((s, r) => s + r.cost, 0)),
    };
    if (rest.requests > 0) rows.push({ id: 'unattributed', name: 'Service and unattributed', email: null, role: null, ...rest });
    return rows;
  }

  /* ── Catalog ── */
  const perMillion = c => (c == null ? null : c * 10_000);  // cents per token → USD per 1M tokens
  const catalog = ws => cached(`catalog:${ws.id}`, 300_000, async () => {
    const [providers, integrations, mcp] = await Promise.all([
      all('/providers', { workspace_id: ws.id }),
      all('/integrations', { workspace_id: ws.id }),
      all('/mcp-servers', { workspace_id: ws.id }),
    ]);
    // providers.integration_id holds the integration id on SaaS and the slug when self-hosted.
    const integrationById = new Map(integrations.flatMap(i => [[i.id, i], [i.slug, i]]));
    const models = await Promise.all(providers.map(async p => {
      const integ = integrationById.get(p.integration_id);
      if (!integ) return [];
      const r = await mgmt('GET', `/integrations/${encodeURIComponent(integ.slug)}/models`);
      return (r.models || []).filter(m => m.enabled).map(m => ({
        id: `@${p.slug}/${m.slug}`, provider: p.name,
        input: perMillion(m.pricing_config?.pay_as_you_go?.request_token?.price),
        output: perMillion(m.pricing_config?.pay_as_you_go?.response_token?.price),
      }));
    }));
    return {
      models: models.flat(),
      mcpServers: mcp.map(s => ({ slug: s.slug, name: s.name, description: s.description, auth_type: s.auth_type, status: s.status, url: s.url })),
    };
  });

  /* ── OIDC login ── */
  const discovery = () => cached('oidc', 3_600_000, async () => {
    const r = await fetch(`${cfg.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!r.ok) throw new HttpError(502, 'SSO provider is unavailable');
    return r.json();
  });
  const startSession = (res, email) => setCookie(res, 'sid', sign({ email, exp: Date.now() + cfg.sessionHours * 3_600_000 }), cfg.sessionHours * 3600);
  const redirect = (res, to) => { res.writeHead(302, { Location: String(to) }); res.end(); };
  const rand = () => crypto.randomBytes(32).toString('base64url');

  async function login(res) {
    if (cfg.devEmail) { startSession(res, cfg.devEmail); return redirect(res, '/'); }
    const d = await discovery();
    const t = { state: rand(), nonce: rand(), verifier: rand(), exp: Date.now() + 600_000 };
    setCookie(res, 'oidc', sign(t), 600);
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: cfg.oidc.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
      state: t.state, nonce: t.nonce, code_challenge_method: 'S256',
      code_challenge: crypto.createHash('sha256').update(t.verifier).digest('base64url'),
    });
    redirect(res, u);
  }

  async function callback(req, res, url) {
    const t = unsign(cookies(req).oidc);
    setCookie(res, 'oidc', '', 0);
    if (!t || url.searchParams.get('state') !== t.state) throw new HttpError(400, 'Login expired. Go back and try again.');
    const d = await discovery();
    const r = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.oidc.clientId)}:${encodeURIComponent(cfg.oidc.clientSecret)}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri, code_verifier: t.verifier }),
    });
    if (!r.ok) { console.error('token exchange failed', r.status, await r.text()); throw new HttpError(502, 'SSO login failed'); }
    const { id_token } = await r.json();
    // OIDC Core 3.1.3.7: an ID token fetched directly from the token endpoint over TLS
    // may rely on TLS instead of a signature check, so no JWKS handling is needed.
    const c = JSON.parse(Buffer.from(String(id_token).split('.')[1] || '', 'base64url'));
    if (c.iss !== d.issuer || ![].concat(c.aud).includes(cfg.oidc.clientId) || c.exp * 1000 < Date.now() || c.nonce !== t.nonce) {
      throw new HttpError(401, 'SSO login failed');
    }
    const email = String(c.email || c.preferred_username || '').toLowerCase();
    if (!email.includes('@')) throw new HttpError(401, 'Your SSO account has no email address');
    startSession(res, email);
    redirect(res, '/');
  }

  /* ── HTTP ── */
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65_536) reject(new HttpError(413, 'Body too large')); else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    const url = new URL(req.url, cfg.publicUrl);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(indexHtml);
    }
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/auth/login') return login(res);
    if (p === '/auth/callback') return callback(req, res, url);
    if (p === '/auth/logout') { setCookie(res, 'sid', '', 0); return redirect(res, '/'); }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    const session = unsign(cookies(req).sid);
    if (!session) return json(res, 401, { error: 'Sign in to continue' });
    // A JSON content type cannot be sent cross-site without a CORS preflight, which blocks CSRF.
    if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) {
      return json(res, 415, { error: 'Use application/json' });
    }
    const user = await loadUser(session.email);
    if (!user) return json(res, 403, { error: 'You do not have access. Ask your workspace manager.' });

    if (p === '/api/me') {
      return json(res, 200, {
        user: { id: user.id, name: user.name, email: user.email },
        workspaces: user.workspaces.map(({ id, name, role }) => ({ id, name, role })),
        config: cfg.ui,
      });
    }

    const m = p.match(/^\/api\/w\/([^/]+)\/(.+)$/);
    const ws = m && user.workspaces.find(w => w.id === decodeURIComponent(m[1]));
    if (!ws) return json(res, 404, { error: 'Workspace not found' });
    const route = `${req.method} ${m[2]}`;
    const managersOnly = () => { if (ws.role !== 'manager') throw new HttpError(403, 'Only workspace managers can do this'); };
    const keyRoute = m[2].match(/^keys\/([^/]+)(\/rotate)?$/);

    if (route === 'GET overview') {
      const workspaceWide = url.searchParams.get('scope') === 'workspace';
      if (workspaceWide) managersOnly();
      return json(res, 200, await cached(`overview:${ws.id}:${workspaceWide ? '*' : user.email}`, 30_000,
        () => overview(ws, workspaceWide ? null : user.email)));
    }
    if (route === 'GET keys') {
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
      if (scope === 'all') managersOnly();
      return json(res, 200, await listKeys(ws, user, scope));
    }
    if (route === 'POST keys') return json(res, 201, await createKey(ws, user, await readBody(req)));
    if (keyRoute && req.method === 'POST' && keyRoute[2]) {
      await checkKey(ws, user, keyRoute[1]);
      const r = await mgmt('POST', `/api-keys/${encodeURIComponent(keyRoute[1])}/rotate`, { body: {} });
      return json(res, 200, { id: r.id, full: r.key, old_key_expires_at: r.key_transition_expires_at });
    }
    if (keyRoute && req.method === 'DELETE' && !keyRoute[2]) {
      await checkKey(ws, user, keyRoute[1]);
      await mgmt('DELETE', `/api-keys/${encodeURIComponent(keyRoute[1])}`);
      return json(res, 200, { ok: true });
    }
    if (route === 'GET members') { managersOnly(); return json(res, 200, await members(ws)); }
    if (route === 'GET catalog') return json(res, 200, await catalog(ws));
    return json(res, 404, { error: 'Not found' });
  }

  return http.createServer((req, res) => handle(req, res).catch(err => {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Internal error' });
  }));
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Developer portal listening on :${port}`));
}
