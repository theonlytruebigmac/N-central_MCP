/**
 * End-to-end and structural isolation tests:
 *  - resource cache is tenant-scoped,
 *  - AsyncLocalStorage context survives async hops and throws when absent in
 *    multi-tenant mode,
 *  - two concurrent sessions through the REAL McpServer + StreamableHTTP
 *    transport never cross tenants (validates ALS propagation through the SDK),
 *  - the boot matrix (multi-tenant vs single-tenant) behaves correctly.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { als, getContext, makeContext } from '../src/context.js';
import { apiGet } from '../src/client.js';
import { evictTenant } from '../src/auth.js';
import { cached, evictTenantCache } from '../src/resources.js';
import { installMockFetch } from './mock-fetch.js';

const ctxA = makeContext('https://a.example.com', 'jwtA');
const ctxB = makeContext('https://b.example.com', 'jwtB');

// ---------------------------------------------------------------------------
// Resource cache isolation
// ---------------------------------------------------------------------------
describe('resource cache isolation', () => {
  after(() => { evictTenantCache(ctxA.key); evictTenantCache(ctxB.key); });

  it('keys the cache by tenant — same URI never leaks across tenants', async () => {
    let n = 0;
    const loadA = async () => ({ who: 'A', n: ++n });
    const loadB = async () => ({ who: 'B', n: ++n });
    const uri = 'ncentral://org-tree';

    const a1 = await als.run(ctxA, () => cached(uri, loadA));
    const b1 = await als.run(ctxB, () => cached(uri, loadB)); // same URI, other tenant
    const a2 = await als.run(ctxA, () => cached(uri, loadA)); // must hit A's cache

    assert.equal(a1.who, 'A');
    assert.equal(b1.who, 'B', 'tenant B must NOT receive tenant A cached value');
    assert.deepEqual(a2, a1, "tenant A's second read should be a cache hit");
  });
});

// ---------------------------------------------------------------------------
// AsyncLocalStorage propagation / fail-loud behavior
// ---------------------------------------------------------------------------
describe('async-context propagation', () => {
  it('survives setTimeout / microtask continuations', async () => {
    const seen = await als.run(ctxA, () => new Promise((resolve) => {
      setTimeout(() => resolve(getContext().key), 5);
    }));
    assert.equal(seen, ctxA.key);
  });

  it('getContext() throws in multi-tenant mode when no store is present', async () => {
    // Fresh module instance with NC_MULTI_TENANT set (query string busts the
    // ESM module cache). Its `als` is separate, which is exactly what we want.
    process.env.NC_MULTI_TENANT = '1';
    const mod = await import('../src/context.js?multitenant=1');
    delete process.env.NC_MULTI_TENANT;

    assert.equal(mod.MULTI_TENANT, true);
    assert.throws(() => mod.getContext(), /No tenant context/);

    const ctx = mod.makeContext('https://a.example.com', 'jwtA');
    assert.equal(mod.als.run(ctx, () => mod.getContext().key), ctx.key);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: two concurrent sessions through the real SDK transport
// ---------------------------------------------------------------------------
function buildMcp() {
  const srv = new McpServer({ name: 'isolation-test', version: '0.0.0' });
  // The tool calls the N-central client, which resolves its tenant from the
  // active async context — i.e. it only works if ALS propagated from the
  // als.run() wrapper, through transport.handleRequest, into this handler.
  srv.tool('whoami', 'Return the tenant host this call reached', {}, async () => {
    const r = await apiGet('/api/whoami');
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });
  return srv;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function startTestServer() {
  const transports = new Map();
  const ctxs = new Map();

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      const body = await readJson(req);
      const sid = req.headers['mcp-session-id'];

      if (sid && transports.has(sid)) {
        await als.run(ctxs.get(sid), () => transports.get(sid).handleRequest(req, res, body));
        return;
      }
      if (!sid && isInitializeRequest(body)) {
        const fqdn = makeContext(req.headers['x-nc-fqdn'], req.headers['x-nc-jwt']);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true, // plain-JSON responses keep the test parser simple
          onsessioninitialized: (id) => { transports.set(id, transport); ctxs.set(id, fqdn); },
        });
        const mcp = buildMcp();
        await mcp.connect(transport);
        await als.run(fqdn, () => transport.handleRequest(req, res, body));
        return;
      }
      res.writeHead(400).end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
      void err;
    }
  });

  return server;
}

async function mcpPost(port, extraHeaders, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const sessionId = res.headers.get('mcp-session-id');
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, sessionId, json };
}

const initMsg = (id) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});
const initializedMsg = () => ({ jsonrpc: '2.0', method: 'notifications/initialized' });
const toolCallMsg = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } });

function toolHost(callResult) {
  const text = callResult?.json?.result?.content?.[0]?.text;
  return JSON.parse(text).host;
}

describe('end-to-end session isolation through the real MCP transport', () => {
  it('routes two concurrent sessions to their own tenants', async () => {
    const server = startTestServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const mock = installMockFetch();

    try {
      const initA = await mcpPost(port, { 'X-NC-FQDN': 'https://a.example.com', 'X-NC-JWT': 'jwtA' }, initMsg(1));
      const initB = await mcpPost(port, { 'X-NC-FQDN': 'https://b.example.com', 'X-NC-JWT': 'jwtB' }, initMsg(1));
      assert.ok(initA.sessionId, `session A init failed: ${JSON.stringify(initA)}`);
      assert.ok(initB.sessionId, `session B init failed: ${JSON.stringify(initB)}`);

      await mcpPost(port, { 'mcp-session-id': initA.sessionId }, initializedMsg());
      await mcpPost(port, { 'mcp-session-id': initB.sessionId }, initializedMsg());

      // Fire the two tool calls concurrently — the ALS store must keep them apart.
      const [ra, rb] = await Promise.all([
        mcpPost(port, { 'mcp-session-id': initA.sessionId }, toolCallMsg(2)),
        mcpPost(port, { 'mcp-session-id': initB.sessionId }, toolCallMsg(2)),
      ]);

      assert.equal(toolHost(ra), 'a.example.com');
      assert.equal(toolHost(rb), 'b.example.com');
    } finally {
      mock.restore();
      evictTenant(ctxA.key);
      evictTenant(ctxB.key);
      await new Promise((r) => server.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// Boot matrix
// ---------------------------------------------------------------------------
const indexPath = fileURLToPath(new URL('../index.js', import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function waitForHealth(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.ok) { resolve(); return; }
      } catch { /* not up yet */ }
      if (tries > 60) { reject(new Error('server did not become healthy')); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function cleanEnv(extra) {
  const base = { ...process.env };
  for (const k of ['NC_SERVER_URL', 'NC_JWT_TOKEN', 'NC_MULTI_TENANT', 'MCP_PORT', 'MCP_API_KEY', 'NC_FQDN_ALLOWLIST']) {
    delete base[k];
  }
  return { ...base, ...extra };
}

function runBoot(env, { readyRe, waitMs = 2500 } = {}) {
  const base = { ...process.env };
  for (const k of ['NC_SERVER_URL', 'NC_JWT_TOKEN', 'NC_MULTI_TENANT', 'MCP_PORT', 'MCP_API_KEY', 'NC_FQDN_ALLOWLIST']) {
    delete base[k];
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [indexPath], {
      env: { ...base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const done = (exitCode) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ exitCode, stderr });
    };
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => {
      stderr += d;
      if (readyRe && readyRe.test(stderr)) done(null); // booted successfully → still running
    });
    child.on('exit', (code) => done(code));
    setTimeout(() => done(null), waitMs);
  });
}

describe('boot matrix', () => {
  it('rejects multi-tenant + stdio (no MCP_PORT)', async () => {
    const { exitCode, stderr } = await runBoot({ NC_MULTI_TENANT: '1' });
    assert.equal(exitCode, 1);
    assert.match(stderr, /requires HTTP mode/);
  });

  it('rejects single-tenant with no credentials', async () => {
    const { exitCode, stderr } = await runBoot({});
    assert.equal(exitCode, 1);
    assert.match(stderr, /NC_SERVER_URL and NC_JWT_TOKEN .* are required/s);
  });

  it('boots multi-tenant over HTTP without env credentials', async () => {
    const port = await freePort();
    const { exitCode, stderr } = await runBoot(
      { NC_MULTI_TENANT: '1', MCP_PORT: String(port), MCP_API_KEY: 'test-key' },
      { readyRe: /Multi-tenant mode|REST API MCP Server on http/ },
    );
    assert.equal(exitCode, null, `expected the server to keep running, exited with ${exitCode}\n${stderr}`);
    assert.match(stderr, /Multi-tenant mode/);
  });
});

// ---------------------------------------------------------------------------
// SSRF / header-override guard (single-tenant must ignore client X-NC-* headers)
// ---------------------------------------------------------------------------
describe('single-tenant SSRF guard', () => {
  it('ignores client X-NC-* headers in single-tenant mode (no override / SSRF)', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [indexPath], {
      env: cleanEnv({
        NC_SERVER_URL: 'https://env.ncentral.com',
        NC_JWT_TOKEN: 'a.b.c',
        MCP_PORT: String(port),
        MCP_API_KEY: 'k',
        MCP_QUIET: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await waitForHealth(port);
      // Bogus X-NC headers that WOULD be rejected (400) if honored: http:// + non-JWT.
      // In single-tenant mode they must be ignored and env creds used → init succeeds.
      const r = await mcpPost(port, {
        Authorization: 'Bearer k',
        'X-NC-FQDN': 'http://evil.example.org',
        'X-NC-JWT': 'not-a-jwt',
      }, initMsg(1));
      assert.equal(r.status, 200, `expected env-credential init to succeed (headers ignored), got ${r.status}`);
      assert.ok(r.sessionId, 'expected a session bound to the env tenant');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
