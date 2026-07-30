# N-central REST API MCP Server

> A [Model Context Protocol](https://modelcontextprotocol.io/) server for **N-able N-central** — exposing the N-central REST API as MCP tools, resources, and prompts for use with any MCP-compatible client.

> **Disclaimer:** This is an unofficial, community-maintained MCP server. It is **not** an official N-able MCP server, and it is focused specifically on the N-central **REST API** surface.

---

## Features at a Glance

- **87 tools** covering devices, device notes, organizations, users, custom properties, scheduled tasks, PSA integrations, maintenance windows, and reporting — full coverage of the N-central REST API
- **Three write modes**: `read-only`, `write` (default), `full` — controls which tools are exposed
- **Auto-paginated bulk reports** in CSV or JSON; per-endpoint concurrency caps tuned to N-central's documented limits
- **MCP Resources** for live org-hierarchy context (`ncentral://org-tree`) and per-entity lookups via templated URIs
- **MCP Prompts** for common audit and reporting workflows
- **Two transports**: stdio (for Claude Desktop / local clients) and Streamable HTTP (for remote clients, MCP Inspector, etc.)
- **Single- or multi-tenant**: self-host against one N-central (env credentials), or run one hosted server many users point at — each targeting their *own* N-central via per-request headers (`NC_MULTI_TENANT=1`), with strict per-request credential isolation. See the **[Setup & Client Guide](docs/SETUP-GUIDE.md)**
- **Production-grade auth**: JWT exchange with auto-refresh, hash-based bearer-token auth for the HTTP endpoint, CORS allow-list, rate limiting, audit log
- **Operability**: `/healthz` and `/metrics` (Prometheus text format) endpoints, structured audit logging, configurable retry/timeout/session caps

---

## Quick Start

### Prerequisites

- **Node.js ≥ 22.9** (uses the built-in `--env-file-if-exists` flag and `fetch`)
- An **N-central instance** you can reach over HTTPS
- A **User-API JWT token** generated in the N-central UI

### 1. Install dependencies

```bash
npm install
```

### 2. Get your N-central JWT token

In the N-central UI: **Administration → User Management → Users → [user] → API Access → Generate JSON Web Token**

> **Best practice:** Use a dedicated API-only user with least-privilege roles. The API user password rotates every 90 days — regenerate the JWT proactively to avoid 500 errors.

### 3. Configure your environment

```bash
cp .env.example .env
# Edit .env — set NC_SERVER_URL and NC_JWT_TOKEN at minimum.
```

The most common variables (full list in [.env.example](.env.example)):

| Variable | Required when | Description |
|---|---|---|
| `NC_SERVER_URL` | single-tenant | Your N-central URL, e.g. `https://ncentral.example.com`. *Not* needed in multi-tenant mode |
| `NC_JWT_TOKEN` | single-tenant | User-API JWT from the N-central UI. *Not* needed in multi-tenant mode |
| `NC_MULTI_TENANT` | hosted mode | Set to `1` to require per-request `X-NC-FQDN`/`X-NC-JWT` headers (HTTP only). See [Multi-Tenant Mode](#multi-tenant-hosted-mode) |
| `NC_FQDN_ALLOWLIST` | multi-tenant | Comma-separated host suffixes a client may target — SSRF guard (exact or DNS-suffix match) |
| `NC_WRITE_MODE` | optional | `read-only` \| `write` \| `full` (default `write`) |
| `MCP_PORT` | HTTP mode only | Setting this enables HTTP mode (omit for stdio) |
| `MCP_API_KEY` | HTTP mode | Bearer token clients must present. Generate with `openssl rand -hex 32`. **Required** unless `MCP_ALLOW_UNAUTHENTICATED=1` |
| `MCP_BIND_ADDRESS` | optional | Interface to bind. `127.0.0.1` (default) for localhost-only; `0.0.0.0` for Docker / LAN exposure |
| `MCP_CORS_ORIGIN` | browser clients | Comma-separated allow-list of origins |

> **Connecting a client?** See the **[Setup & Client Guide](docs/SETUP-GUIDE.md)** for copy-paste config for Claude Code, VS Code, Claude Desktop, and Cursor — in both single- and multi-tenant modes.

#### Write modes

| Mode | Tool count | Includes |
|---|---|---|
| `read-only` | 56 | GET endpoints only |
| `write` *(default)* | 82 | Read tools + create/update tools (POST/PUT/PATCH) |
| `full` | 87 | Everything, including destructive tools: `delete_device`, `delete_maintenance_windows`, `delete_device_note`, `clear_device_notes`, `create_direct_scheduled_task` |

All write/destructive tools are audit-logged. Start in `read-only`, move to `write` once the integration is trusted, and reserve `full` for vetted automation.

### 4. Start the server

The server runs in **stdio mode** by default and switches to **HTTP mode** when `MCP_PORT` is set.

**Option A — stdio (Claude Desktop / local clients)**

Use the npm script (loads `.env` if present):

```bash
npm start
```

Or wire it into Claude Desktop directly. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ncentral": {
      "command": "node",
      "args": ["--env-file-if-exists=/absolute/path/to/n-central-rest-api-mcp/.env", "/absolute/path/to/n-central-rest-api-mcp/index.js"],
      "env": {
        "NC_WRITE_MODE": "read-only"
      }
    }
  }
}
```

**Option B — Streamable HTTP (remote clients, MCP Inspector)**

Set `MCP_PORT` in `.env` (default `3100`) and an `MCP_API_KEY`, then:

```bash
npm run start:http
# Listening at http://127.0.0.1:3100/mcp
# Health probe: http://127.0.0.1:3100/healthz
# Metrics:      http://127.0.0.1:3100/metrics
```

Clients send `Authorization: Bearer <MCP_API_KEY>` on every request.

**Option C — Docker**

```bash
cp .env.example .env
# Edit .env: NC_SERVER_URL, NC_JWT_TOKEN, MCP_API_KEY are required for the HTTP listener.
docker compose up -d
```

Compose maps `127.0.0.1:3100:3100` by default. To expose on the LAN, edit `docker-compose.yml` and ensure `MCP_API_KEY` is set.

### 5. Verify

```bash
# stdio mode — should print "Authenticated with N-central..." on first tool call.
# HTTP mode — should respond:
curl -s http://127.0.0.1:3100/healthz
# {"status":"ok","sessions":0}
```

---

## Multi-Tenant (Hosted) Mode

By default the server is **single-tenant**: it reads one `NC_SERVER_URL` + `NC_JWT_TOKEN` from
its environment. That's the right model for an MSP self-hosting it against a single N-central.

Set **`NC_MULTI_TENANT=1`** to host **one** server that many users point at, each targeting a
**different** N-central server with their **own** JWT — supplied per request via headers in their
own MCP client config. (Intended for a centrally-hosted demo/eval box, not for routing third
parties' production credentials through infrastructure you don't control.)

```bash
# Hosted server (HTTP only — stdio cannot carry per-request headers):
NC_MULTI_TENANT=1 \
MCP_PORT=3100 \
MCP_API_KEY="$(openssl rand -hex 32)" \
NC_FQDN_ALLOWLIST=ncentral.com,n-able.com \
node index.js
```

Each user's MCP client config sends, per request:

```jsonc
{
  "mcpServers": {
    "ncentral": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>",       // gates access to THIS server
        "X-NC-FQDN": "https://their-ncentral.example.com",
        "X-NC-JWT":  "<their N-central User-API JWT>"
      }
    }
  }
}
```

**Isolation guarantees**

- **One session = one tenant.** Credentials are validated at session init (before the session
  exists); an invalid/missing header pair is rejected with `400`. The tenant is then bound to the
  session for its lifetime — later header changes on the same session are ignored.
- **No shared credential state.** Tokens are keyed per tenant and resolved per request via
  `AsyncLocalStorage`, so concurrent requests for different servers can never read each other's
  URL or token. The resource cache is tenant-scoped for the same reason.
- **Memory only, auto-evicted.** Tokens and cache entries live in memory and are dropped when the
  last session for a tenant closes. Nothing is persisted; JWTs are never logged.
- **SSRF guard.** `NC_FQDN_ALLOWLIST` restricts which N-central hosts a client may target (exact
  or DNS-suffix match). Leave it unset only behind trusted network boundaries — the server warns
  at startup if it's empty.

**Scaling.** The event loop handles many concurrent users on one process (the work is I/O-bound —
waiting on N-central). If you outgrow one process, run replicas behind a load balancer with
**sticky routing by `mcp-session-id`** — StreamableHTTP sessions live in process memory, so a
session must return to the replica that created it.

> **Tip — multiple servers without hosting:** a self-hoster who just needs to target several
> N-central servers from their own editor can skip multi-tenant mode entirely and define one
> stdio entry per server, each with its own `env: { NC_SERVER_URL, NC_JWT_TOKEN }`.

---

## Tools

Each tool is tagged with its required write mode:

- 🟢 **read** — available in every mode
- 🟡 **write** — requires `NC_WRITE_MODE=write` or `full`
- 🔴 **destructive** — requires `NC_WRITE_MODE=full`

### Pagination

Every `list_*` tool returns a single page by default (with pagination metadata: `pageNumber`, `pageSize`, `totalItems`, `totalPages`, `_links`). To retrieve every result across all pages in one call, pass `all: true` — the server will auto-paginate at 200 items per page (up to 40,000 items). For CSV/JSON exports over large datasets, use the matching `report_*` tool instead.

### Devices (11)

| Tool | Mode | Description |
|------|------|-------------|
| `list_devices` | 🟢 | List all devices with pagination, sorting, and filter support |
| `list_devices_by_org_unit` | 🟢 | List devices under a specific org unit |
| `get_device` | 🟢 | Get a device by ID |
| `get_device_status` | 🟢 | Get service monitoring status for a device |
| `get_device_assets` | 🟢 | Get hardware/software asset info for a device |
| `get_device_lifecycle` | 🟢 | Get warranty/lifecycle info for a device |
| `get_appliance_task` | 🟢 | Get appliance task info by task ID |
| `create_device` | 🟡 | Add a new device (customerId, networkAddress, longName, supportedOs, deviceClass required) |
| `update_device_lifecycle` | 🟡 | PUT — replace asset lifecycle/warranty info (all fields required) |
| `patch_device_lifecycle` | 🟡 | PATCH — partially update asset lifecycle info |
| `delete_device` | 🔴 | Delete a device by ID (optional `removeAgents`) |

### Organizations (14)

| Tool | Mode | Description |
|------|------|-------------|
| `list_service_orgs` | 🟢 | List all service organizations |
| `get_service_org` | 🟢 | Get a specific service org by ID |
| `list_customers` | 🟢 | List customers (all or filtered by SO) |
| `get_customer` | 🟢 | Get a specific customer by ID |
| `list_sites` | 🟢 | List sites (all or filtered by customer) |
| `get_site` | 🟢 | Get a specific site by ID |
| `list_org_units` | 🟢 | List all organization units |
| `get_org_unit` | 🟢 | Get a specific org unit by ID |
| `get_org_unit_limits` | 🟢 | Get licensing/usage limits for an org unit |
| `list_org_unit_children` | 🟢 | List child org units for a parent |
| `create_service_org` | 🟡 | Create a new service organization |
| `create_customer` | 🟡 | Create a new customer under a service org |
| `create_site` | 🟡 | Create a new site under a customer (PREVIEW) |
| `update_org_unit_limits` | 🟡 | Update licensing/usage limits for an org unit (PATCH) |

### Scheduled Tasks (5)

| Tool | Mode | Description |
|------|------|-------------|
| `list_scheduled_tasks` | 🟢 | List all scheduled tasks across the environment |
| `get_scheduled_task` | 🟢 | Get general info for a scheduled task |
| `get_scheduled_task_status` | 🟢 | Get aggregated or per-device task status |
| `list_device_tasks` | 🟢 | List all scheduled tasks for a device |
| `create_direct_scheduled_task` | 🔴 | Run an Automation Policy / Script / MacScript on a device (direct support task) |

### Custom Properties (9)

| Tool | Mode | Description |
|------|------|-------------|
| `list_device_custom_properties` | 🟢 | List all custom properties for a device |
| `get_device_custom_property` | 🟢 | Get a specific device custom property |
| `get_device_default_custom_property` | 🟢 | Get default custom property for an org unit |
| `list_org_custom_properties` | 🟢 | List custom properties for an org unit |
| `get_org_unit_property` | 🟢 | Get a specific org unit custom property |
| `get_org_custom_property_default` | 🟢 | Get default value for an org unit custom property |
| `update_device_custom_property` | 🟡 | Update a custom property value on a device |
| `update_org_unit_custom_property` | 🟡 | Update a custom property value on an org unit |
| `update_org_custom_property_default` | 🟡 | Update the default value of an org-unit custom property (with propagation) |

### Users & Access (10)

| Tool | Mode | Description |
|------|------|-------------|
| `list_all_users` | 🟢 | List all users in N-central (global, not scoped by org unit) |
| `get_current_user` | 🟢 | Get details for the currently authenticated user |
| `list_users` | 🟢 | List users for an org unit |
| `list_user_roles` | 🟢 | List user roles for an org unit |
| `get_user_role` | 🟢 | Get a specific user role |
| `list_access_groups` | 🟢 | List access groups for an org unit |
| `get_access_group` | 🟢 | Get a specific access group by ID |
| `create_user_role` | 🟡 | Create a new user role for an org unit (PREVIEW) |
| `create_access_group` | 🟡 | Create a new org-unit-type access group |
| `create_device_access_group` | 🟡 | Create a new device-type access group |

### Server Info & Discovery (6)

| Tool | Mode | Description |
|------|------|-------------|
| `get_server_info` | 🟢 | Server/API version info, health, or extended system details |
| `get_server_time` | 🟢 | Current server time (useful for clock drift detection) |
| `list_device_filters` | 🟢 | List all device filters |
| `get_report` | 🟢 | Retrieve an N-central report by ID |
| `get_server_info_authenticated` | 🟡 | Extra server version info using supplied credentials |
| `logout` | 🟡 | Invalidate the current N-central API session |

### Registration & Software (4)

| Tool | Mode | Description |
|------|------|-------------|
| `get_registration_token` | 🟢 | Agent registration token for a site / customer / org unit |
| `get_device_activation_key` | 🟢 | Generate an activation key for a device |
| `get_software_installers` | 🟢 | List agent installer download URLs for a customer |
| `generate_software_download_link` | 🟡 | Generate a software download link for a customer |

### Maintenance Windows (4)

| Tool | Mode | Description |
|------|------|-------------|
| `get_maintenance_windows` | 🟢 | List all maintenance windows for a device |
| `create_maintenance_windows` | 🟡 | Add a set of patch maintenance windows to a list of devices |
| `update_maintenance_windows` | 🟡 | Modify existing maintenance windows by ScheduleId |
| `delete_maintenance_windows` | 🔴 | Delete maintenance windows by ScheduleIds |

### PSA (10)

| Tool | Mode | Description |
|------|------|-------------|
| `get_psa_customer_mapping` | 🟢 | Customer-mapping record by customer ID |
| `list_psa_customer_mappings` | 🟢 | All PSA mappings for a customer |
| `list_psa_companies` | 🟢 | Standard PSA companies for a customer |
| `list_psa_company_contacts` | 🟢 | Contacts in a Standard PSA company |
| `list_psa_company_sites` | 🟢 | Sites in a Standard PSA company |
| `list_custom_psa_tickets` | 🟢 | List Custom PSA tickets |
| `validate_psa_credential` | 🟡 | Validate Standard PSA credentials (TigerPaw 3.0 only) |
| `get_custom_psa_ticket_detail` | 🟡 | Retrieve a Custom PSA ticket (POST — requires creds) |
| `create_custom_psa_ticket` | 🟡 | Create a new Custom PSA ticket |
| `update_psa_customer_mappings` | 🟡 | Update PSA mappings for a customer |

### Device Notes (6)

| Tool | Mode | Description |
|------|------|-------------|
| `list_device_notes` | 🟢 | List all notes attached to a device |
| `add_device_note` | 🟡 | Add a note to a device |
| `add_notes_bulk` | 🟡 | Add the same note to a list of devices |
| `update_device_note` | 🟡 | Update an existing note on a device |
| `delete_device_note` | 🔴 | Delete a specific note on a device |
| `clear_device_notes` | 🔴 | Delete ALL notes on a device |

### Reports (8)

The cross-entity and bulk aggregate reports. For simple lists, use the matching `list_*` tool with `all: true` and `format: "csv"` — those auto-paginate and CSV-export too. Bulk reports use per-endpoint safe concurrency (3-5); override with `concurrency`.

| Tool | Mode | Description |
|------|------|-------------|
| `report_devices_bulk` | 🟢 | Fan out a per-device call across an org unit — `dataType`: `custom-properties` / `assets` / `monitor-status`. CSV default. |
| `report_all_users_by_so` | 🟢 | Deduplicated users across an SO and all its customers. CSV default. |
| `report_devices_by_so` | 🟢 | All devices under a service org (filters across all devices). CSV default. |
| `report_customer_site_summary` | 🟢 | Customers with sites and device counts (per-site and customer totals). CSV default. |
| `report_org_hierarchy` | 🟢 | Full SO → Customer → Site hierarchy flat table. CSV default. |
| `list_active_issues` | 🟢 | All active issues for an org unit. CSV/JSON. |
| `list_job_statuses` | 🟢 | All job statuses for an org unit. CSV/JSON. |
| `generate_patch_comparison_report` | 🟡 | Submit a patch comparison report job (returns report ID) |

---

## Resources

Resources provide live context to the client without requiring explicit tool calls. Hierarchical resources are cached for 60s by default — set `NC_RESOURCE_CACHE_TTL_MS=0` to disable.

| URI | Description |
|-----|-------------|
| `ncentral://org-tree` | Full SO → Customer → Site hierarchy with IDs and names |
| `ncentral://status` | Server health + version snapshot |
| `ncentral://device/{deviceId}` | Templated — full device record by ID |
| `ncentral://customer/{customerId}` | Templated — customer details by ID |
| `ncentral://org-unit/{orgUnitId}` | Templated — org unit details by ID |

---

## Prompts

| Name | Description |
|------|-------------|
| `full-customer-report` | Comprehensive customer/site report with org custom properties |
| `device-health-audit` | Active issues and monitoring status across the environment |
| `agent-deployment-status` | Find sites with missing or low device counts |
| `custom-property-audit` | Audit custom property consistency across all customers |

---

## Resilience

| Concern | Behavior |
|---------|----------|
| Rate limits (429) | Auto-retry with exponential backoff on all methods (up to 3 attempts) |
| Unauthorized (401) | Auto re-authenticates from JWT and replays the request on all methods |
| Token expiry | Access tokens (1hr) and refresh tokens (25hr) auto-refreshed; concurrent refreshes coalesced |
| Server errors (500/503) | Retried on GET/PUT/DELETE (idempotent). POST/PATCH fail fast to avoid duplicate writes |
| Request timeouts | 30s on API calls, 15s on auth calls. Retried on idempotent methods only |
| Stale HTTP sessions | Cleaned up after 30 minutes of inactivity |

---

## Known API Quirks

- **Probe assets:** Return 404 — probes don't have asset records (expected behavior, skipped in bulk reports)
- **Active issues:** `deviceClassValue` and `deviceClassLabel` are always `null` (known N-central API bug)
- **`get_device` by ID:** `lastLoggedInUser` and `stillLoggedIn` may return `null` — use `list_devices` instead for these fields. (`lastApplianceCheckinTime` was also missing pre-v2025.3.1.9 — now fixed.)
- **Active issues at SO level:** The `/active-issues` endpoint only supports customer/site org unit types, not service org
- **Scheduled task `/details`:** does NOT accept DEVICE-level task IDs — only SYSTEM and CUSTOMER. Navigate via `parentId` if you have a device task ID.
- **`create_direct_scheduled_task`:** Scripts must have Repository ID ≥ 2000 and "Enable API" toggled ON in the N-central UI. There's no API to enumerate scripts — find IDs in the Script/Software Repository UI. Extensive use accumulates DB rows that slow the UI's Task Execution page.
- **`validate_psa_credential`:** only works with TigerPaw 3.0 — calls for other PSAs will fail.
- **Per-endpoint concurrency limits:** N-central enforces concurrency per-endpoint (range 1-50). `/api/devices` allows 5 concurrent; `/api/devices/{id}/assets/lifecycle-info` only 1. Bulk reports default to safe values; tune via the `concurrency` parameter.
- **PREVIEW endpoints:** `create_site` and `create_user_role` are flagged PREVIEW by N-central — the request/response shape may change between versions
- **Credentialed POST endpoints:** `validate_psa_credential`, `get_custom_psa_ticket_detail`, and `get_server_info_authenticated` transmit plaintext credentials in request bodies — only use over HTTPS and be mindful of audit-log contents
- **`select` is a filter, not a projection:** despite the name, the `select` query parameter on list endpoints is a **FIQL/RSQL predicate** that filters rows. It does NOT pick which fields come back. Valid: `select=soId==50` (returns only that SO). Invalid: `select=soId,soName` (parse error). Not all fields are queryable — unsupported ones error with `Field not found: X`. Some operators (e.g. `=gt=`) throw NPEs on the server.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 500 errors on every API call | N-central API user password expired (rotates every 90 days) | Reset the password in N-central UI; regenerate the JWT; set a reminder for ~80 days |
| Repeated `Got 401, re-authenticating...` logs | N-central instance was rebooted (in-memory token state lost) | First 401 triggers re-auth; subsequent calls recover automatically. Noisy on restart but transient. |
| JWT works now but fails 5 minutes later | Token revocation propagation | After regenerating a JWT in N-central UI, allow up to 5 minutes for the old token's revocation to propagate |
| Server restart loses authentication state | Tokens are stored in-memory only | First API call after restart triggers fresh JWT exchange — no action needed |
| Can't reach the API on a custom port | N-central only serves the API on port 443 | Use a reverse proxy or accept port 443 |
| `create_direct_scheduled_task` errors with no script found | Repository ID < 2000 (bundled default) or "Enable API" toggle is OFF | Use a custom-uploaded script; toggle "Enable API" in the UI |
| Reaching `MAX_PAGES` errors on big environments | `fetchAll` caps at 200 pages × 200 items (40k rows) | Use a tighter filter via the `select` parameter, or call the underlying tool with explicit `pageNumber`/`pageSize` |
| HTTP mode exits with "FATAL: MCP_PORT is set but MCP_API_KEY is not" | Safety check — HTTP mode requires an API key | Set `MCP_API_KEY=$(openssl rand -hex 32)` or `MCP_ALLOW_UNAUTHENTICATED=1` for local dev |
| `ERR_CONNECTION_REFUSED` / can't reach `/healthz`/`/metrics` from another machine | Server bound or published to localhost only | Set `MCP_BIND_ADDRESS=0.0.0.0`; in Docker publish `0.0.0.0:3100:3100` (not `127.0.0.1:3100:3100`) and connect to the host's **LAN IP**, not `localhost`. If `curl 127.0.0.1:3100/healthz` works *on the host* but not remotely, it's the bind/publish scope |
| Client connects but queries the **wrong** N-central / `X-NC-*` headers ignored | Server not started with `NC_MULTI_TENANT=1` | In single-tenant mode the headers are ignored and env `NC_SERVER_URL`/`NC_JWT_TOKEN` are used. Start with `NC_MULTI_TENANT=1` for header passthrough |
| `400` at connect in multi-tenant mode | Missing/invalid `X-NC-FQDN` / `X-NC-JWT` | Send both; FQDN must be `https://` and match `NC_FQDN_ALLOWLIST` if set |
| "FATAL: NC_MULTI_TENANT=1 requires HTTP mode" | Multi-tenant needs per-request headers, which stdio can't carry | Set `MCP_PORT` (run in HTTP mode) |

For client-side setup issues, see the **[Setup & Client Guide](docs/SETUP-GUIDE.md)**.

---

## Project Structure

```
├── index.js                  # Entry point — transport selection (stdio / HTTP)
├── src/
│   ├── auth.js               # Per-tenant JWT → Access Token auth, auto-refresh logic
│   ├── client.js             # HTTP client with retry, timeout, and rate-limit handling
│   ├── context.js            # Per-request tenant context (AsyncLocalStorage) — credential isolation
│   ├── logging.js            # Structured logger + audit log
│   ├── metrics.js            # Prometheus counters / gauges
│   ├── paginator.js          # Auto-pagination, bounded concurrency, CSV helpers
│   ├── prompts.js            # MCP Prompts definitions
│   ├── resources.js          # MCP Resources definitions
│   ├── server-utils.js       # JSON-schema → Zod, header parsing, safeCompare
│   ├── shared.js             # Shared pagination/format schema helpers
│   ├── tool-registry.js      # Write-mode gating + MCP tool annotations
│   └── tools/
│       ├── custom-properties.js
│       ├── devices.js
│       ├── maintenance-windows.js
│       ├── notes.js
│       ├── organizations.js
│       ├── psa.js
│       ├── registration.js
│       ├── reports.js
│       ├── scheduled-tasks.js
│       ├── server-info.js
│       └── users.js
├── test/
│   ├── auth-isolation.test.js  # Per-tenant token/credential isolation (forced interleave, 401 path)
│   ├── isolation.test.js       # End-to-end session isolation, cache, boot matrix, SSRF guard
│   ├── mock-fetch.js           # Shared test helpers (not a test suite)
│   ├── helpers.test.js
│   ├── server-utils.test.js
│   └── utils.test.js
├── docs/
│   └── SETUP-GUIDE.md          # Client setup how-to (Claude Code, VS Code, Claude Desktop, Cursor)
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## License

Released under the [MIT License](LICENSE) — see the `LICENSE` file for the full text.
