# N-central REST API MCP Server — Setup & Client Guide

How to connect the N-central REST API MCP server to common MCP clients — **Claude Code**, **VS Code**,
**Claude Desktop**, **Cursor**, and anything else that speaks MCP — in both deployment modes.

For installing/running the server itself and the full tool list, see the [README](../README.md).

---

## 1. Pick your mode first

|  | Self-host (single-tenant) | Hosted (multi-tenant) |
|---|---|---|
| **Who it's for** | One MSP, one N-central server | One shared server, many users → *different* N-centrals |
| **Where creds live** | `NC_SERVER_URL` + `NC_JWT_TOKEN` in the **server's** env | Each user sends `X-NC-FQDN` + `X-NC-JWT` **headers** per request |
| **Transport** | stdio **or** HTTP | HTTP **only** |
| **Server flag** | *(default)* | `NC_MULTI_TENANT=1` |
| **Client sends** | nothing (stdio) / just the gateway key (HTTP) | gateway key **+ two N-central headers** |

> **You may not need multi-tenant mode.** If you just want to reach several N-centrals from your
> own editor, run one **stdio** entry per server, each with its own env — see
> [Multiple servers without hosting](#multiple-servers-without-hosting).

---

## 2. Multi-tenant requirements — read before configuring a client

When connecting to a **hosted / multi-tenant** server, every request must carry **three headers**:

| Header | Value | Purpose |
|---|---|---|
| `Authorization` | `Bearer <MCP_API_KEY>` | Gates access to the MCP server itself |
| `X-NC-FQDN` | `https://your-ncentral.example.com` | Which N-central to target (**https only**) |
| `X-NC-JWT` | `<your N-central User-API JWT>` | Authenticates to that N-central |

Rules and gotchas:

- **HTTP transport only.** stdio cannot carry per-request headers, so a stdio client cannot use
  multi-tenant mode.
- **The server must run with `NC_MULTI_TENANT=1`.** If it doesn't, the server **silently ignores**
  `X-NC-FQDN` / `X-NC-JWT` and uses its *own* env credentials. This is the #1 "it connected but
  queried the wrong N-central" gotcha — if your headers seem to do nothing, the server isn't in
  multi-tenant mode.
- **One session = one tenant.** Headers are read once when the session is created; a missing or
  invalid pair is rejected with `400` before the session exists.
- **`NC_FQDN_ALLOWLIST`** on the server may restrict which hosts you're allowed to target.
- **`/healthz` and `/metrics` are not** behind the gateway key (they're for probes/scrapers).

A **single-tenant HTTP** client sends only the `Authorization` header — the FQDN/JWT come from the
server's env.

---

## 3. Get your N-central JWT

N-central UI → **Administration → User Management → Users → [your API user] → API Access →
Generate JSON Web Token**. Use a dedicated, least-privilege API user. The underlying API user
password rotates every ~90 days, so regenerate the JWT proactively.

## 4. Server URL

- Local server: `http://localhost:3100/mcp`
- Remote server: `http://<host-or-ip>:3100/mcp` (e.g. `http://10.0.0.5:3100/mcp`) — **not**
  `localhost` unless the client runs on the same machine as the server.
- The path is always **`/mcp`**. (`3100` is the default `MCP_PORT`.)

---

## 5. Claude Code

**Self-host (stdio)** — CLI:
```bash
claude mcp add --transport stdio \
  --env NC_SERVER_URL=https://ncentral.example.com \
  --env NC_JWT_TOKEN=<jwt> \
  --env NC_WRITE_MODE=read-only \
  ncentral -- node /abs/path/to/n-central-rest-api-mcp/index.js
```
or `.mcp.json`:
```json
{
  "mcpServers": {
    "ncentral": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/n-central-rest-api-mcp/index.js"],
      "env": {
        "NC_SERVER_URL": "https://ncentral.example.com",
        "NC_JWT_TOKEN": "<jwt>",
        "NC_WRITE_MODE": "read-only"
      }
    }
  }
}
```

**Hosted (multi-tenant, HTTP)** — CLI:
```bash
claude mcp add --transport http ncentral http://<host>:3100/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>" \
  --header "X-NC-FQDN: https://your-ncentral.example.com" \
  --header "X-NC-JWT: <your-jwt>"
```
or `.mcp.json`:
```json
{
  "mcpServers": {
    "ncentral": {
      "type": "http",
      "url": "http://<host>:3100/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>",
        "X-NC-FQDN": "https://your-ncentral.example.com",
        "X-NC-JWT": "<your-jwt>"
      }
    }
  }
}
```
*(For single-tenant HTTP, keep only the `Authorization` header.)*

**Keep secrets out of plaintext.** In **`.mcp.json`** you can interpolate env vars with `${VAR}`
(or `${VAR:-default}`). This works in `.mcp.json` **only** — not in the user-scope `~/.claude.json`,
and not via the `--header` CLI flag:
```json
"headers": {
  "Authorization": "Bearer ${NC_MCP_KEY}",
  "X-NC-FQDN": "${NC_FQDN}",
  "X-NC-JWT": "${NC_JWT}"
}
```
Export `NC_MCP_KEY` / `NC_FQDN` / `NC_JWT` before launching `claude`. (If a referenced var is unset
and has no default, Claude Code fails to load the config.)

**Scopes:** `--scope local` (default, just you, this project) · `--scope project` (shared
`.mcp.json`, committed to the repo) · `--scope user` (just you, all projects). `${VAR}`
interpolation requires a project `.mcp.json`.

**Manage:** `claude mcp list` · `claude mcp get ncentral` · `claude mcp remove ncentral`. Inside a
session, **`/mcp`** shows connection status and per-server tool count.

---

## 6. VS Code (Copilot / MCP)

VS Code reads MCP servers from an **`mcp.json`** that uses a **`servers`** key (not `mcpServers`):
- Workspace: `.vscode/mcp.json`
- User (macOS): `~/Library/Application Support/Code/User/mcp.json`
  (Linux: `~/.config/Code/User/mcp.json`; Windows: `%APPDATA%\Code\User\mcp.json`)

**Hosted (multi-tenant, HTTP):**
```json
{
  "servers": {
    "ncentral": {
      "type": "http",
      "url": "http://<host>:3100/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>",
        "X-NC-FQDN": "https://your-ncentral.example.com",
        "X-NC-JWT": "<your-jwt>"
      }
    }
  },
  "inputs": []
}
```
*(Single-tenant HTTP: keep only the `Authorization` header.)*

**Prompt for secrets instead of hardcoding** — use `inputs` + `${input:id}`:
```json
{
  "inputs": [
    { "id": "nc-key", "type": "promptString", "description": "MCP API key", "password": true },
    { "id": "nc-jwt", "type": "promptString", "description": "N-central JWT", "password": true }
  ],
  "servers": {
    "ncentral": {
      "type": "http",
      "url": "http://<host>:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${input:nc-key}",
        "X-NC-FQDN": "https://your-ncentral.example.com",
        "X-NC-JWT": "${input:nc-jwt}"
      }
    }
  }
}
```

**After editing**, restart the server: Command Palette → **MCP: List Servers** → select it →
**Restart** (or reload the window).

stdio also works in VS Code — use `"type": "stdio"` with `command` / `args` / `env`, same shape as
Claude Code.

---

## 7. Claude Desktop

Config file `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`;
Windows: `%APPDATA%\Claude\`), key **`mcpServers`**. Fully quit and reopen Claude Desktop after edits.

**Self-host (stdio)** — native:
```json
{
  "mcpServers": {
    "ncentral": {
      "command": "node",
      "args": ["--env-file-if-exists=/abs/path/n-central-rest-api-mcp/.env", "/abs/path/n-central-rest-api-mcp/index.js"],
      "env": { "NC_WRITE_MODE": "read-only" }
    }
  }
}
```

**Hosted (multi-tenant, HTTP)** — Claude Desktop speaks stdio natively, so bridge the remote HTTP
endpoint with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
```json
{
  "mcpServers": {
    "ncentral": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://<host>:3100/mcp",
        "--header", "Authorization: Bearer <MCP_API_KEY>",
        "--header", "X-NC-FQDN: https://your-ncentral.example.com",
        "--header", "X-NC-JWT: <your-jwt>"
      ]
    }
  }
}
```
*(Drop the two `X-NC-*` headers for single-tenant.)*

---

## 8. Cursor

Config file `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), key **`mcpServers`** —
same entry shapes as Claude Code:
```json
{
  "mcpServers": {
    "ncentral": {
      "type": "http",
      "url": "http://<host>:3100/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>",
        "X-NC-FQDN": "https://your-ncentral.example.com",
        "X-NC-JWT": "<your-jwt>"
      }
    }
  }
}
```

---

## 9. Any other MCP client

The server exposes a standard **Streamable HTTP** MCP endpoint:
- **URL:** `http://<host>:<MCP_PORT>/mcp`
- **Headers:** `Authorization: Bearer <MCP_API_KEY>` always; add `X-NC-FQDN` + `X-NC-JWT` when the
  server runs multi-tenant.
- Or **stdio:** run `node index.js` with `NC_SERVER_URL` / `NC_JWT_TOKEN` in the process env.

---

## Multiple servers without hosting

You don't need multi-tenant mode just to use several N-centrals from your own editor — define one
**stdio** entry per server, each with its own env:
```json
{
  "mcpServers": {
    "ncentral-acme":   { "command": "node", "args": ["/abs/index.js"], "env": { "NC_SERVER_URL": "https://acme.ncentral.com",   "NC_JWT_TOKEN": "<jwt-acme>" } },
    "ncentral-globex": { "command": "node", "args": ["/abs/index.js"], "env": { "NC_SERVER_URL": "https://globex.ncentral.com", "NC_JWT_TOKEN": "<jwt-globex>" } }
  }
}
```
Each entry is its own process with its own credentials — fully isolated, no server changes needed.

---

## Verify the connection

- **Claude Code:** `/mcp` → the server shows ✓ with a tool count.
- **VS Code:** **MCP: List Servers** → Running, tools listed.
- **Anywhere:** `curl -s http://<host>:3100/healthz` → `{"status":"ok","sessions":N}`.
- The **first tool call** triggers the N-central token exchange — a bad JWT/FQDN surfaces there in
  single-tenant mode, or at connect (`400`) in multi-tenant mode.

---

## Troubleshooting (connectivity)

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` / unreachable from another machine | Server bound or published to localhost only | Set `MCP_BIND_ADDRESS=0.0.0.0`; in Docker publish `0.0.0.0:3100:3100` (not `127.0.0.1:3100:3100`); connect to the host's **LAN IP**, not `localhost`. **Quick check:** run `curl 127.0.0.1:3100/healthz` *on the server host* — if that works but remote doesn't, it's the bind/publish scope. |
| `/healthz` or `/metrics` won't load in a browser | Same reachability issue; or `/metrics` returns `401` | Fix exposure as above. `/metrics` is open by default; a `401` means `MCP_METRICS_REQUIRE_AUTH=1` — then scrape it with `curl -H "Authorization: Bearer <key>"` (a browser tab can't send that header). |
| Connects, but queries the **wrong** N-central / your `X-NC-*` headers seem ignored | Server is **not** in multi-tenant mode | Start the server with `NC_MULTI_TENANT=1`. In single-tenant mode the headers are ignored and the env `NC_SERVER_URL`/`NC_JWT_TOKEN` are used. |
| `400 Bad Request` at connect (multi-tenant) | Missing/invalid `X-NC-FQDN` or `X-NC-JWT` | Send both; FQDN must be `https://`; if `NC_FQDN_ALLOWLIST` is set, the host must match it (exact or DNS-suffix). |
| `401 Unauthorized` at connect | `Authorization` missing or ≠ the server's `MCP_API_KEY` | Send `Authorization: Bearer <MCP_API_KEY>` matching the server's key. |
| stdio server doesn't appear in the client | Wrong `command`/path or missing env | Use an **absolute** path to `index.js`; ensure `NC_SERVER_URL` / `NC_JWT_TOKEN` are in `env`. |

For N-central API-side issues (expired API password, token revocation, custom ports), see the
[README Troubleshooting](../README.md#troubleshooting).
