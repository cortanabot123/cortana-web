# cortana-web

A mobile-first installable chat PWA for a Hermes agent, built with React, Vite, and Tailwind CSS. Cortana communicates with Hermes only through the TUI Gateway bridge at `/api/gateway`.

## TUI Gateway

The browser checks `GET /api/gateway/status`, then opens a same-origin WebSocket to `/api/gateway`. The Node server authenticates to the Hermes dashboard, mints a single-use WebSocket ticket, and relays the TUI Gateway JSON-RPC stream. Chat, command catalog/completion, slash commands, status events, and interrupts all use this connection. If the gateway is unavailable or the connection fails, Cortana reports an inline error; there is no alternate transport.

Configure the dashboard credentials on the server only:

| Variable | Meaning |
|---|---|
| `HERMES_DASHBOARD_URL` | Dashboard base URL, default `http://127.0.0.1:9119` |
| `HERMES_DASHBOARD_USERNAME` | Dashboard auth username (bundled basic-auth provider) |
| `HERMES_DASHBOARD_PASSWORD` | Dashboard auth password |

With both credentials set, `server.mjs` logs in to the dashboard, keeps session cookies in memory, mints a fresh short-lived ticket per browser connection, and connects to the dashboard WebSocket. Credentials and tickets are not sent to the browser or written to disk.

The gateway WebSocket relays the Hermes agent control plane. **Any Cortana user can drive the full Hermes agent control plane** (tools, config, MCP, vault). The same-origin check and `CORTANA_ACCESS_USERNAME`/`CORTANA_ACCESS_PASSWORD` are the only additional boundary, so never expose a non-loopback Cortana without access credentials.

`scripts/start-cortana.sh` starts the server in this container: it reads dashboard credentials from the container environment, loads `CORTANA_ACCESS_*` from `/opt/data/.env`, and defaults to `HOST=0.0.0.0 PORT=3000`.

## Requirements

- Node.js 22 or later.
- A reachable Hermes dashboard with gateway access.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm test
npm run lint
npm run build
npm run smoke
```

## Data and privacy

Chat messages and session IDs remain in memory except for the gateway's resumable session ID, which is kept in browser localStorage. The service worker caches the built app shell only; it does not cache API requests or responses.

## Production server

Build and run the included Node HTTP server to serve `dist/`:

```bash
npm run build
npm start
```

The Node server listens on port 3000 by default (`PORT` can be set) and binds only to `127.0.0.1` when started with `node server.mjs`; the bundled `scripts/start-cortana.sh` sets `HOST=0.0.0.0` so a reverse proxy on another host/container can reach it. For non-loopback binds, both `CORTANA_ACCESS_USERNAME` and `CORTANA_ACCESS_PASSWORD` are required server-side and HTTP Basic authentication is enforced on every route, including the `/api/gateway` WebSocket upgrade. A successful Basic login also sets a signed `cortana_session` cookie (HttpOnly, SameSite=Lax, 30 days, `Secure` behind HTTPS) so reloads and app relaunches do not ask for the password again; rotating either credential invalidates every outstanding session.

Use a trusted TLS-terminating reverse proxy/load balancer for remote deployments and restrict ingress to that proxy.

## Checks

- `npm test` runs Node tests for the gateway bridge/client, slash commands and menu, server access control/static serving, and PWA behavior. Browser tests use the local Playwright Chromium available in the development environment.
- `npm run lint` runs oxlint.
- `npm run build` type-checks and produces `dist/`, including a generated app-shell-only `sw.js`.
- `npm run smoke` exercises the built static server and gateway status endpoint without contacting Hermes.
