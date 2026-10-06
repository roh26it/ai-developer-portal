# AI Developer Portal

Self-service portal for developers on the AI gateway. Developers sign in with SSO, create and rotate API keys, see their usage, and browse the approved models and MCP servers. Workspace managers also see all keys, per-member usage, and can create keys for members and service keys.

- **One server file, one HTML file.** `server.js` has no dependencies. `public/index.html` loads React and antd from a CDN, so the UI has no build step.
- **One binary.** `bun run build` compiles the server and the UI into one executable. It needs no runtime on the host.
- **The browser never holds the admin key.** The server holds one management-plane admin key and checks the user's role before each management-plane call.
- **Stateless.** Sessions are signed cookies, so you can run more than one replica with no shared store.

## Run locally

Needs [Bun](https://bun.sh) 1.4 or later.

```sh
bun run dev      # mock management plane + portal at http://localhost:3000, signed in as a mock user
bun test
```

`DEV_LOGIN_EMAIL=diane.kowalski@example.com bun run dev` signs in as a member. The mock data is in `dev/mock-mgmt-plane.js`.

## Deploy

| Option | Commands |
|---|---|
| Binary | `bun run build:linux` makes `dist/ai-developer-portal-linux-x64` and `-linux-arm64` (about 80 MB each). Copy one to the host and run it. It reads `.env` from its working directory, or takes the variables from the environment |
| Docker | `docker build -t ai-developer-portal .`, then `docker run -p 3000:3000 --env-file .env ai-developer-portal`. The image holds only the binary on Alpine |
| Source | `bun server.js`. Bun reads `.env` from the working directory |

1. Copy `.env.example` to `.env` and set the values (table below).
2. Register `${PUBLIC_URL}/auth/callback` as the redirect URI in your IdP. Request the scopes `openid email profile`.
3. Put the server behind HTTPS. Cookies are `Secure` when `PUBLIC_URL` starts with `https://`.
4. Health check: `GET /healthz`.

| Variable | Required | Use |
|---|---|---|
| `MGMT_PLANE_BASE_URL` | Yes | Management plane URL, including `/v1`. Example: `https://mgmt.example.com/v1` |
| `MGMT_ADMIN_KEY` | Yes | Org admin API key for the management plane. Scopes below |
| `SESSION_SECRET` | Yes | At least 32 characters. Signs the session cookies |
| `PUBLIC_URL` | Yes | Public URL of the portal, for the SSO redirect |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Yes | OIDC app in your IdP (code flow with PKCE) |
| `SESSION_HOURS` | No | Session length. Default 8 |
| `PORT` | No | Default 3000 |
| `PORTAL_NAME` | No | Name in the sidebar and login screen |
| `GATEWAY_URL` | Yes | Gateway URL in the code samples |
| `ADMIN_CONSOLE_NAME`, `ADMIN_CONSOLE_URL` | No | The admin console that the sidebar links to |
| `DOCS_URL` | No | Developer docs link on Get Started |
| `DEV_LOGIN_EMAIL` | Dev only | Skips SSO. The server refuses to start with it when `NODE_ENV=production` |

### Scopes for the admin key

| Scope | Use |
|---|---|
| `organisation_users.read`, `organisation_users.list` | Find the user at login |
| `workspaces.read`, `workspaces.list` | Workspace switcher |
| `workspace_users.read`, `workspace_users.list` | Roles, Members page |
| `workspace_user_api_keys.create/read/update/delete/list` | User keys |
| `workspace_service_api_keys.create/read/update/delete/list` | Service keys |
| `analytics.view` | Overview, Members, Get Started |
| Read access to providers, integrations, MCP servers | Catalog. The API spec does not name these scopes. If the Catalog shows an error, the server log shows which call got a 403; add that scope |

### Before production

- **Gateway version.** Per-member usage uses `metadata._user`, which the server sets on each user key. The key metadata must override request metadata, or a caller can bill another member. The gateway applies this order from v1.10.20.

## How it works

| Page | Who | Management-plane calls |
|---|---|---|
| Login | All | `GET /admin/users?email=`, `GET /admin/workspaces/{id}`, `GET /admin/workspaces/{id}/users?email=` |
| Get Started, Overview | All | `GET /analytics/graphs/cost`, `/analytics/graphs/requests` (filtered by `_user` for members) |
| My API Keys | All | `GET /api-keys`, `POST /api-keys/workspace/user`, `POST /api-keys/{id}/rotate`, `DELETE /api-keys/{id}` |
| Workspace Keys | Managers | Same, plus `POST /api-keys/workspace/service` |
| Members | Managers | `GET /admin/workspaces/{id}/users`, then `GET /analytics/graphs/{cost,requests}` per member, filtered by `_user` |
| Catalog | All | `GET /providers`, `/integrations`, `/integrations/{slug}/models`, `/mcp-servers` |

Rules the server enforces:

- A member sees and changes only their own keys. A manager can act on any key in the workspace.
- Only managers create service keys, or keys for another member.
- The server sets `user_id` and `metadata._user` on each user key. The browser cannot set them.
- The full key value is passed to the browser once, on create or rotate. The server does not log or store it.

## Update

- **UI:** edit `public/index.html`. `bun run dev` restarts on save, so a reload shows the change. The binary contains the UI, so rebuild to ship it.
- **Server:** edit `server.js`, run `bun test`, then rebuild and redeploy.
- **Libraries:** the CDN versions are pinned in the `<script>` tags in `public/index.html`.
