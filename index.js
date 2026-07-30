#!/usr/bin/env node

/** N-central REST API MCP server entry point. See README.md and .env.example for configuration. */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import http from 'http';

import { safeCompare, jsonSchemaToZod, parseAuthorizationHeader, validateNcFqdn, looksLikeJwt } from './src/server-utils.js';
import { inc, setGauge, renderPrometheus } from './src/metrics.js';

import { als, makeContext, ENV_CONTEXT, MULTI_TENANT } from './src/context.js';
import { evictTenant } from './src/auth.js';
import { registerResources, RESOURCE_COUNT, evictTenantCache } from './src/resources.js';
import { registerPrompts, PROMPT_COUNT } from './src/prompts.js';
import { auditLog } from './src/logging.js';
import { isToolAllowed as _isToolAllowed, buildToolAnnotations } from './src/tool-registry.js';

import { deviceTools } from './src/tools/devices.js';
import { organizationTools } from './src/tools/organizations.js';
import { scheduledTaskTools } from './src/tools/scheduled-tasks.js';
import { customPropertyTools } from './src/tools/custom-properties.js';
import { userTools } from './src/tools/users.js';
import { noteTools } from './src/tools/notes.js';
import { maintenanceWindowTools } from './src/tools/maintenance-windows.js';
import { registrationTools } from './src/tools/registration.js';
import { psaTools } from './src/tools/psa.js';
import { serverInfoTools } from './src/tools/server-info.js';
import { reportTools } from './src/tools/reports.js';

// Host suffixes a client-supplied X-NC-FQDN must match (SSRF guard). Empty = any https host.
const NC_FQDN_ALLOWLIST = (process.env.NC_FQDN_ALLOWLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Single-tenant mode requires env credentials at boot. Multi-tenant mode
// (NC_MULTI_TENANT=1) accepts them per-request via X-NC-FQDN / X-NC-JWT headers,
// so env credentials are optional there.
if (!MULTI_TENANT && !ENV_CONTEXT) {
  console.error('Error: NC_SERVER_URL and NC_JWT_TOKEN environment variables are required.');
  console.error('  NC_SERVER_URL: Your N-central server URL (e.g. https://ncentral.example.com)');
  console.error('  NC_JWT_TOKEN:  Your User-API JWT token from N-central UI');
  console.error('  (or set NC_MULTI_TENANT=1 to accept per-request credentials over HTTP)');
  process.exit(1);
}

const MCP_API_KEY = process.env.MCP_API_KEY || null;
const MCP_CORS_ORIGIN = process.env.MCP_CORS_ORIGIN || null;
const MCP_BIND_ADDRESS = process.env.MCP_BIND_ADDRESS || '127.0.0.1';
const MCP_ALLOW_UNAUTHENTICATED = process.env.MCP_ALLOW_UNAUTHENTICATED === '1';
const MAX_BODY_SIZE = Number(process.env.MCP_MAX_BODY_SIZE) || 1024 * 1024; // 1 MB
const RATE_LIMIT_WINDOW_MS = Number(process.env.MCP_RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.MCP_RATE_LIMIT_MAX) || 120;
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS) || 256;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const QUIET = process.env.MCP_QUIET === '1';

const NC_WRITE_MODE = (process.env.NC_WRITE_MODE || 'write').toLowerCase();
const VALID_WRITE_MODES = new Set(['read-only', 'write', 'full']);
if (!VALID_WRITE_MODES.has(NC_WRITE_MODE)) {
  console.error(`Error: NC_WRITE_MODE must be one of: read-only, write, full (got: ${NC_WRITE_MODE})`);
  process.exit(1);
}

const SENSITIVE_TOOLS = new Set([
  'get_site_registration_token',
  'get_org_unit_registration_token',
  'get_customer_registration_token',
  'get_registration_token',
  'list_users',
  'list_all_users',
  'list_user_roles',
  'get_user_role',
  'list_access_groups',
  'list_all_access_groups',
  'get_access_group',
]);

const isToolAllowed = (tool) => _isToolAllowed(tool, NC_WRITE_MODE);


const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    if (!entry && rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      let oldestIp = null;
      let oldestStart = Infinity;
      for (const [k, v] of rateLimitMap) {
        if (v.windowStart < oldestStart) {
          oldestStart = v.windowStart;
          oldestIp = k;
        }
      }
      if (oldestIp) rateLimitMap.delete(oldestIp);
    }
    entry = { count: 1, windowStart: now };
    rateLimitMap.set(ip, entry);
    return true;
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);
rateLimitCleanup.unref();


const allTools = [
  ...deviceTools,
  ...organizationTools,
  ...scheduledTaskTools,
  ...customPropertyTools,
  ...userTools,
  ...noteTools,
  ...maintenanceWindowTools,
  ...registrationTools,
  ...psaTools,
  ...serverInfoTools,
  ...reportTools,
].filter(isToolAllowed);

for (const tool of allTools) {
  if (tool.writeScope && tool.writeScope !== 'read') SENSITIVE_TOOLS.add(tool.name);
}

/** Error type for invalid/missing per-request credentials → HTTP 400. */
class ContextError extends Error {}

/**
 * Resolve the tenant context for an incoming HTTP request. Per-request
 * X-NC-FQDN / X-NC-JWT headers take precedence; otherwise fall back to env
 * credentials (single-tenant). Throws ContextError when credentials are
 * required but absent or invalid (the caller maps that to a 400).
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {import('./src/context.js').TenantContext}
 */
function resolveRequestContext(req) {
  // Single-tenant: ALWAYS use the operator's env credentials, and ignore any
  // client-supplied X-NC-* headers. Honoring them here would let any caller past
  // the MCP_API_KEY gate redirect the server to an arbitrary host (SSRF) or
  // override the configured tenant. Headers are strictly a multi-tenant feature.
  if (!MULTI_TENANT) {
    if (ENV_CONTEXT) return ENV_CONTEXT;
    throw new ContextError('No N-central credentials configured');
  }

  // Multi-tenant: credentials MUST come from per-request headers.
  const fqdnHeader = req.headers['x-nc-fqdn'];
  const jwtHeader = req.headers['x-nc-jwt'];
  if (typeof fqdnHeader !== 'string' || typeof jwtHeader !== 'string') {
    // Reject missing or multi-valued (array) headers — a tenant is exactly one (fqdn, jwt).
    throw new ContextError('Both X-NC-FQDN and X-NC-JWT must be present and single-valued');
  }
  if (!looksLikeJwt(jwtHeader)) throw new ContextError('X-NC-JWT is not a valid JWT');
  let fqdn;
  try {
    fqdn = validateNcFqdn(fqdnHeader, NC_FQDN_ALLOWLIST);
  } catch (err) {
    throw new ContextError(`Invalid X-NC-FQDN: ${err.message}`);
  }
  return makeContext(fqdn, jwtHeader);
}

/** Run fn inside the tenant's async context, so getContext() resolves to it. */
function runWithCtx(ctx, fn) {
  return ctx ? als.run(ctx, fn) : fn();
}

function createServer() {
  const srv = new McpServer({
    name: 'ncentral-api',
    version: '2.1.0',
    description: 'N-central REST API MCP Server (Unofficial)',
  });

  for (const tool of allTools) {
    /** @type {Record<string, any>} */
    const schemaShape = {};
    const properties = tool.inputSchema.properties || {};
    const required = tool.inputSchema.required || [];

    for (const [key, prop] of Object.entries(properties)) {
      let zodProp = jsonSchemaToZod(prop);
      if (!required.includes(key)) zodProp = zodProp.optional();
      schemaShape[key] = zodProp;
    }

    const handler = tool.handler;
    const toolName = tool.name;
    const annotations = buildToolAnnotations(tool);

    srv.tool(toolName, tool.description, schemaShape, annotations, async (args) => {
      const t0 = Date.now();
      try {
        // Auth is lazy and per-tenant: the first apiRequest for this tenant
        // (resolved from the active async context) authenticates on demand.
        if (SENSITIVE_TOOLS.has(toolName)) {
          auditLog('sensitive_tool_call', { tool: toolName, args });
        }

        const result = await handler(args);
        const durationMs = Date.now() - t0;
        auditLog('tool_call', { tool: toolName, success: true, durationMs });
        inc('nc_mcp_tool_calls_total', { tool: toolName, success: 'true' });

        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const durationMs = Date.now() - t0;
        auditLog('tool_error', { tool: toolName, error: error.message, durationMs });
        inc('nc_mcp_tool_calls_total', { tool: toolName, success: 'false' });
        return {
          content: [{ type: 'text', text: `Error: ${sanitizeErrorMessage(error.message)}` }],
          isError: true,
        };
      }
    });
  }

  registerResources(srv);
  registerPrompts(srv);
  return srv;
}

function sanitizeErrorMessage(message) {
  let msg = message.replace(/https?:\/\/[^\s]+/g, '[server]');
  msg = msg.replace(/on GET \/api\/([^\s:]+)/g, 'on $1');
  return msg.length > 300 ? msg.substring(0, 300) + '...' : msg;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let done = false;

    const finish = (fn, val) => {
      if (done) return;
      done = true;
      fn(val);
    };

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        finish(reject, new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { finish(resolve, data ? JSON.parse(data) : undefined); }
      catch { finish(reject, new Error('Invalid JSON body')); }
    });
    req.on('error', err => finish(reject, err));
  });
}

function authenticateRequest(req) {
  if (!MCP_API_KEY) return true;
  const token = parseAuthorizationHeader(req.headers['authorization']);
  if (!token) return false;
  return safeCompare(token, MCP_API_KEY);
}

const TRUST_PROXY = process.env.MCP_TRUST_PROXY === '1';

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}


const MCP_PORT = process.env.MCP_PORT;

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`Unhandled rejection: ${msg}`);
  auditLog('unhandled_rejection', { error: msg });
});

process.on('uncaughtException', (error) => {
  console.error(`Uncaught exception: ${error.message}`);
  auditLog('uncaught_exception', { error: error.message });
  process.exit(1);
});


async function main() {
  try {
    if (MULTI_TENANT && !MCP_PORT) {
      console.error('FATAL: NC_MULTI_TENANT=1 requires HTTP mode (set MCP_PORT).');
      console.error('       Per-request credentials cannot be supplied over stdio.');
      process.exit(1);
    }

    if (MCP_PORT && !MCP_API_KEY && !MCP_ALLOW_UNAUTHENTICATED) {
      console.error('FATAL: MCP_PORT is set but MCP_API_KEY is not. HTTP mode requires an API key.');
      console.error('       Set MCP_API_KEY (e.g. `openssl rand -hex 32`) or set MCP_ALLOW_UNAUTHENTICATED=1 for local dev.');
      process.exit(1);
    }

    if (!QUIET) {
      console.error(`Registered ${allTools.length} tools, ${RESOURCE_COUNT} resources, ${PROMPT_COUNT} prompts (NC_WRITE_MODE=${NC_WRITE_MODE})`);
      console.error(MULTI_TENANT
        ? 'Multi-tenant mode: per-request X-NC-FQDN / X-NC-JWT required; auth is per-tenant on first call.'
        : 'Auth will be performed on first tool call.');
    }

    if (MCP_PORT) {
      if (!MCP_API_KEY && MCP_ALLOW_UNAUTHENTICATED) {
        console.error('⚠️  WARNING: MCP_API_KEY not set — HTTP endpoint is unauthenticated (MCP_ALLOW_UNAUTHENTICATED=1).');
      }
      if (!MCP_CORS_ORIGIN && !QUIET) {
        console.error('ℹ️  CORS disabled (no MCP_CORS_ORIGIN set).');
      }
      if (MULTI_TENANT && NC_FQDN_ALLOWLIST.length === 0) {
        console.error('⚠️  WARNING: NC_MULTI_TENANT=1 with no NC_FQDN_ALLOWLIST — any https FQDN will be accepted (SSRF risk).');
      }

      const transports = new Map();
      const sessionCtx = new Map();        // sessionId -> TenantContext
      const tenantRefs = new Map();        // ctx.key -> Set<sessionId>
      const sessionLastActivity = new Map();
      const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS) || 30 * 60_000;
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      function validSessionId(id) {
        return typeof id === 'string' && UUID_RE.test(id);
      }

      function addTenantRef(key, sid) {
        let set = tenantRefs.get(key);
        if (!set) { set = new Set(); tenantRefs.set(key, set); }
        set.add(sid);
      }

      // Tear down a session; when it was the last session for its tenant, evict
      // that tenant's cached tokens + resource-cache entries so credential
      // material doesn't accumulate for the process lifetime. Idempotent.
      function teardownSession(sid) {
        transports.delete(sid);
        sessionLastActivity.delete(sid);
        const ctx = sessionCtx.get(sid);
        if (!ctx) return;
        sessionCtx.delete(sid);
        const set = tenantRefs.get(ctx.key);
        if (!set) return;
        set.delete(sid);
        if (set.size === 0) {
          tenantRefs.delete(ctx.key);
          evictTenant(ctx.key);
          evictTenantCache(ctx.key);
        }
      }

      const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${MCP_PORT}`);
        const clientIp = getClientIp(req);

        if (MCP_CORS_ORIGIN) {
          const allowed = MCP_CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
          const reqOrigin = req.headers.origin;
          if (reqOrigin && allowed.includes(reqOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', reqOrigin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, X-NC-FQDN, X-NC-JWT');
            res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
          }
        }

        if (req.method === 'OPTIONS') {
          if (MCP_CORS_ORIGIN && res.hasHeader('Access-Control-Allow-Origin')) {
            res.writeHead(204);
          } else {
            res.writeHead(405, { Allow: 'POST, GET, DELETE' });
          }
          res.end();
          return;
        }

        if (url.pathname === '/healthz' || url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', sessions: transports.size }));
          return;
        }

        if (url.pathname === '/metrics') {
          if (process.env.MCP_METRICS_REQUIRE_AUTH === '1' && !authenticateRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
          }
          setGauge('nc_mcp_active_sessions', transports.size);
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          res.end(renderPrometheus());
          return;
        }

        if (!checkRateLimit(clientIp)) {
          auditLog('rate_limited', { ip: clientIp, path: url.pathname });
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null }));
          return;
        }

        if (!authenticateRequest(req)) {
          auditLog('auth_failed', { ip: clientIp, path: url.pathname });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
          return;
        }

        if (url.pathname !== '/mcp') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        if (req.method === 'POST') {
          try {
            const body = await parseBody(req);
            const sessionId = req.headers['mcp-session-id'];

            if (sessionId && validSessionId(sessionId) && transports.has(sessionId)) {
              sessionLastActivity.set(sessionId, Date.now());
              const ctx = sessionCtx.get(sessionId);
              const transport = transports.get(sessionId);
              await runWithCtx(ctx, () => transport.handleRequest(req, res, body));
            } else if (!sessionId && isInitializeRequest(body)) {
              if (transports.size >= MAX_SESSIONS) {
                auditLog('session_limit_reached', { ip: clientIp, count: transports.size });
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Server session limit reached' }, id: null }));
                return;
              }

              // Resolve + validate credentials BEFORE constructing the transport,
              // so an invalid/missing-credential init is rejected (400) without
              // ever creating a session. The ctx is bound to this session for its
              // lifetime — one session = one tenant; later header changes ignored.
              let ctx;
              try {
                ctx = resolveRequestContext(req);
              } catch (err) {
                if (err instanceof ContextError) {
                  auditLog('context_rejected', { ip: clientIp, reason: err.message });
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null }));
                  return;
                }
                throw err;
              }

              auditLog('session_init', { ip: clientIp, fqdn: ctx.fqdn, tenant: ctx.key.slice(0, 12) });
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                  transports.set(sid, transport);
                  sessionCtx.set(sid, ctx);
                  addTenantRef(ctx.key, sid);
                  sessionLastActivity.set(sid, Date.now());
                },
              });
              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) teardownSession(sid);
              };
              const server = createServer();
              await server.connect(transport);
              await runWithCtx(ctx, () => transport.handleRequest(req, res, body));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad request: missing session' }, id: null }));
            }
          } catch (error) {
            console.error('POST /mcp error:', error.message);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
            }
          }
          return;
        }

        if (req.method === 'GET') {
          const sessionId = req.headers['mcp-session-id'];
          if (!sessionId || !validSessionId(sessionId) || !transports.has(sessionId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid session');
            return;
          }
          sessionLastActivity.set(sessionId, Date.now());
          const ctx = sessionCtx.get(sessionId);
          const transport = transports.get(sessionId);
          await runWithCtx(ctx, () => transport.handleRequest(req, res));
          return;
        }

        if (req.method === 'DELETE') {
          const sessionId = req.headers['mcp-session-id'];
          if (!sessionId || !validSessionId(sessionId) || !transports.has(sessionId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid session');
            return;
          }
          auditLog('session_delete', { sessionId, ip: clientIp });
          await transports.get(sessionId).handleRequest(req, res);
          return;
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
      });

      httpServer.on('clientError', (_err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });

      httpServer.listen(Number(MCP_PORT), MCP_BIND_ADDRESS, () => {
        console.error(`N-central REST API MCP Server on http://${MCP_BIND_ADDRESS}:${MCP_PORT}/mcp`);
        if (MCP_API_KEY) console.error('  Auth: Bearer token required');
      });

      async function shutdown() {
        console.error('Shutting down...');
        auditLog('server_shutdown', {});
        for (const [sid, transport] of transports) {
          try { await transport.close(); } catch { /* ignore */ }
          transports.delete(sid);
        }
        process.exit(0);
      }
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      const sessionCleanup = setInterval(() => {
        const now = Date.now();
        for (const sid of transports.keys()) {
          if (!sessionLastActivity.has(sid)) {
            sessionLastActivity.set(sid, now);
          } else if (now - sessionLastActivity.get(sid) > SESSION_TTL_MS) {
            auditLog('session_expired', { sessionId: sid });
            console.error(`Cleaning stale session: ${sid}`);
            const transport = transports.get(sid);
            // Delete before awaiting close so concurrent requests see 400 instead of a closing transport.
            teardownSession(sid);
            try { transport?.close(); } catch { /* ignore */ }
          }
        }
      }, 5 * 60_000);
      sessionCleanup.unref();
    } else {
      // stdio mode
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error('N-central REST API MCP Server running on stdio');
    }

    auditLog('server_start', { mode: MCP_PORT ? 'http' : 'stdio', toolCount: allTools.length });
  } catch (error) {
    console.error(`Failed to start: ${error.message}`);
    process.exit(1);
  }
}

main();
