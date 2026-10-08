/**
 * MCP Routes — Comprehensive Tests
 *
 * Run with:
 *   tsx --test test/mcp.test.ts    # tsx native test runner (recommended)
 *   tsx test/mcp.test.ts           # watch mode (project default)
 *
 * Uses Node.js built-in assert/strict for assertions (compatible with node:test).
 *
 * Environment for integration tier:
 *   PLATFORM_ENCRYPTION_KEY=<hex> DATABASE_URL=<url> REDIS_URL=<url>
 */

// Register tsx as the TypeScript loader before any test globals are needed.
import { register } from 'tsx/cjs/api';
register();

// ─── Imports (after register) ─────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';

// ─── Source reading helpers ───────────────────────────────────────────────────

function readMcpSource(): string {
  // Use process.cwd() because node --test resolves __dirname to cwd (.), not the test file's directory.
  return readFileSync(
    join(process.cwd(), 'src/platform/routes/mcp.routes.ts'),
    'utf8',
  );
}

function extractSwitchCases(source: string): string[] {
  const switchStart = source.indexOf('switch (tool)');
  if (switchStart === -1) return [];
  let depth = 0;
  let pos = switchStart;
  let switchEnd = pos;
  while (pos < source.length) {
    if (source[pos] === '{') depth++;
    else if (source[pos] === '}') {
      depth--;
      if (depth === 0) { switchEnd = pos; break; }
    }
    pos++;
  }
  // Use for-of + matchAll (not Array.from) — tsx --test compatibility
  const results: string[] = [];
  for (const m of source.slice(switchStart, switchEnd).matchAll(/case\s+'([^']+)':/g)) {
    results.push(m[1]);
  }
  return results;
}

// Extract all capture group [1] values from a global regex match
function extractAll(source: string, regex: RegExp): string[] {
  const results: string[] = [];
  for (const m of source.matchAll(regex)) {
    results.push(m[1]);
  }
  return results;
}

// Extract all matches (no capture group needed) — returns match strings
function extractMatches(source: string, regex: RegExp): string[] {
  const results: string[] = [];
  for (const m of source.matchAll(regex)) {
    results.push(m[0]);
  }
  return results;
}

function sliceCase(source: string, caseName: string, untilNextCase: string): string {
  const start = source.indexOf(`case '${caseName}':`);
  const end = source.indexOf(`case '${untilNextCase}':`, start);
  return source.slice(start, end > 0 ? end : source.length);
}

function mcpToolsSlice(source: string): string {
  const mcpStart = source.indexOf('const MCP_TOOLS');
  const mcpEnd = source.indexOf('];', mcpStart) + 2;
  return source.slice(mcpStart, mcpEnd);
}

// Extract a section of the source between two // comment markers
function sliceByComment(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end > 0 ? end : source.length);
}

const MCP_TOOL_NAMES: readonly string[] = [
  'list_instances', 'get_instance', 'instance_status', 'list_instances_summary',
  'create_instance', 'delete_instance', 'whatsapp_connect', 'whatsapp_disconnect',
  'whatsapp_restart', 'send_message', 'send_media', 'list_webhooks', 'get_webhook',
  'create_webhook', 'update_webhook', 'delete_webhook', 'test_webhook',
  'rotate_webhook_secret', 'list_api_keys', 'create_api_key', 'revoke_api_key',
  'bind_api_key_instance', 'get_account', 'get_usage', 'get_plans', 'list_subscriptions',
  'health_check', 'get_instance_logs', 'list_contacts', 'list_groups',
];

const HAS_INTEGRATION_ENV = !!(
  process.env.PLATFORM_ENCRYPTION_KEY &&
  process.env.DATABASE_URL &&
  process.env.REDIS_URL
);

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 1 — CODE INSPECTION TESTS (always runs; no runtime deps)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Tool Registry — Completeness', () => {
  it('all 30 tools are present in the MCP_TOOLS array', () => {
    const source = readMcpSource();
    const slice = mcpToolsSlice(source);
    for (const name of MCP_TOOL_NAMES) {
      assert.match(slice, new RegExp(`name:\\s*'${name}'`));
    }
    const names = extractAll(slice, /name:\s*'([^']+)'/g);
    assert.equal(names.length, 30);
  });

  it('every tool has a non-empty description', () => {
    const source = readMcpSource();
    const slice = mcpToolsSlice(source);
    // Only match top-level object property descriptions (at start of line in the slice)
    const descs = extractAll(slice, /^\s+description:\s*'([^']+)'/gm);
    assert.equal(descs.length, 30);
    for (const d of descs) assert.ok(d.trim().length > 0);
  });

  it('every tool has an inputSchema object', () => {
    const source = readMcpSource();
    const slice = mcpToolsSlice(source);
    const schemas = extractMatches(slice, /inputSchema:\s*\{[^}]+\}/gs);
    assert.equal(schemas.length, 30);
  });

  it('every tool category maps to a defined CATEGORY id', () => {
    const source = readMcpSource();
    const catIds = extractAll(source, /id:\s*'([^']+)'/g);
    const slice = mcpToolsSlice(source);
    const catMatches = extractAll(slice, /category:\s*'([^']+)'/g);
    for (const c of catMatches) assert.ok(catIds.includes(c));
  });
});

describe('Tool Registry — Handler Coverage', () => {
  it('every MCP_TOOLS entry has a corresponding switch case', () => {
    const source = readMcpSource();
    const cases = extractSwitchCases(source);
    for (const tool of MCP_TOOL_NAMES) assert.ok(cases.includes(tool));
    for (const c of cases) assert.ok(MCP_TOOL_NAMES.includes(c));
  });

  it('no case statement references an unknown tool', () => {
    const source = readMcpSource();
    const cases = extractSwitchCases(source);
    for (const c of cases) assert.ok(MCP_TOOL_NAMES.includes(c));
  });
});

describe('Scope Map', () => {
  it('TOOL_SCOPES has an entry for every tool', () => {
    const source = readMcpSource();
    const slice = mcpToolsSlice(source);
    const toolNames = extractAll(slice, /name:\s*'([^']+)'/g);
    const scopesStart = source.indexOf('const TOOL_SCOPES');
    const scopesSlice = source.slice(scopesStart, source.indexOf(';', scopesStart));
    for (const tool of toolNames) {
      // TOOL_SCOPES uses unquoted keys: list_instances: [...], not 'list_instances': [...]
      assert.match(scopesSlice, new RegExp(`${tool}\\s*:`));
    }
  });

  it('checkScopes function grants access on wildcard scope', () => {
    const source = readMcpSource();
    const fnSlice = source.slice(
      source.indexOf('function checkScopes'),
      source.indexOf('function checkScopes') + 450,
    );
    assert.match(fnSlice, /\.\s*includes\s*\(\s*['"]\*['"]\s*\)/);
    assert.match(fnSlice, /return true/);
  });

  it('scope check runs before handleTool in POST /invoke', () => {
    const source = readMcpSource();
    const checkIdx = source.indexOf('checkScopes(req, tool)');
    const handleIdx = source.indexOf('handleTool(tool, parameters');
    assert.ok(checkIdx > 0);
    assert.ok(handleIdx > checkIdx);
  });
});

describe('PAT Security — Code Inspection', () => {
  it('list_api_keys never returns plaintextKey or a key: field', () => {
    const source = readMcpSource();
    const block = sliceCase(source, 'list_api_keys', 'create_api_key');
    assert.doesNotMatch(block, /\bplaintextKey\b/);
    assert.doesNotMatch(block, /\bkey\s*:/);
  });

  it('create_api_key returns plaintextKey (one-time display)', () => {
    const source = readMcpSource();
    const block = sliceCase(source, 'create_api_key', 'revoke_api_key');
    assert.match(block, /\bplaintextKey\b/);
  });

  it('revoke_api_key does not return plaintextKey', () => {
    const source = readMcpSource();
    const block = sliceCase(source, 'revoke_api_key', 'bind_api_key_instance');
    assert.doesNotMatch(block, /\bplaintextKey\b/);
  });

  it('health_check uses jsonRpcError and never exposes error.stack', () => {
    const source = readMcpSource();
    const block = sliceCase(source, 'health_check', 'get_instance_logs');
    assert.match(block, /jsonRpcError/);
    assert.doesNotMatch(block, /error\.stack/);
  });

  it('send_message and send_media use PUBLIC_API_BASE, not a literal URL', () => {
    const source = readMcpSource();
    assert.match(source, /^const PUBLIC_API_BASE\s*=/m);
    assert.match(sliceCase(source, 'send_message', 'send_media'), /\$\{PUBLIC_API_BASE\}/);
    assert.match(sliceCase(source, 'send_media', 'list_webhooks'), /\$\{PUBLIC_API_BASE\}/);
  });

  it('send_message handler never references 127.0.0.1 or localhost', () => {
    const source = readMcpSource();
    const block = sliceCase(source, 'send_message', 'send_media');
    assert.doesNotMatch(block, /127\.0\.0\.1/);
    assert.doesNotMatch(block, /localhost(?::\d+)?(?=\/)/);
  });
});

describe('JSON-RPC Protocol', () => {
  it('error constants match JSON-RPC 2.0 spec (-32600 to -32603)', () => {
    const source = readMcpSource();
    assert.match(source, /JSONRPC_INVALID_REQUEST\s*=\s*-32600/);
    assert.match(source, /JSONRPC_METHOD_NOT_FOUND\s*=\s*-32601/);
    assert.match(source, /JSONRPC_INVALID_PARAMS\s*=\s*-32602/);
    assert.match(source, /JSONRPC_INTERNAL_ERROR\s*=\s*-32603/);
  });

  it('unknown tool returns -32601 before handleTool is called', () => {
    const source = readMcpSource();
    const toolDefIdx = source.indexOf('const toolDef = MCP_TOOLS.find');
    const handleIdx = source.indexOf('handleTool(tool, parameters');
    assert.ok(toolDefIdx > 0);
    assert.ok(handleIdx > toolDefIdx);
    assert.match(source.slice(toolDefIdx, handleIdx), /JSONRPC_METHOD_NOT_FOUND/);
  });

  it('jsonRpcError always returns HTTP 200 with error envelope', () => {
    const source = readMcpSource();
    const fn = source.slice(
      source.indexOf('function jsonRpcError'),
      source.indexOf('function jsonRpcResult'),
    );
    assert.match(fn, /res\.status\(200\)\.json\(\{ error:/);
  });

  it('jsonRpcResult always returns HTTP 200 with result envelope', () => {
    const source = readMcpSource();
    const fn = source.slice(
      source.indexOf('function jsonRpcResult'),
      source.indexOf('async function resolveInstance'),
    );
    assert.match(fn, /res\.status\(200\)\.json\(\{ result/);
  });
});

describe('Route Structure', () => {
  it('GET /tools returns category metadata, not full tool schemas', () => {
    const source = readMcpSource();
    // Use comment markers — route handlers span multiple lines
    const handler = sliceByComment(source, '// GET /tools', '// GET /tools/:category');
    assert.match(handler, /CATEGORIES\.map/);
    // The endpoint may use MCP_TOOLS.filter internally for counting, but must return
    // only { categories } — not { categories, tools }
    assert.match(handler, /res\.json\(\{ categories \}\)/);
  });

  it('GET /tools/:category returns filtered tools and category id', () => {
    const source = readMcpSource();
    const handler = sliceByComment(source, '// GET /tools/:category', '// POST /invoke');
    assert.match(handler, /MCP_TOOLS\.filter/);
    // Match the line that extracts category from req.params
    assert.match(handler, /const\s*{\s*category\s*}\s*=\s*req\.params/);
  });

  it('POST /invoke uses hybridAuth and tenantResolveMiddleware', () => {
    const source = readMcpSource();
    const handler = sliceByComment(source, '// POST /invoke', '// --- Tool handler');
    assert.match(handler, /hybridAuth/);
    assert.match(handler, /tenantResolveMiddleware/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 2 — INTEGRATION TESTS (require full app context)
// ═══════════════════════════════════════════════════════════════════════════════

if (HAS_INTEGRATION_ENV) {
  describe('MCP Categorical Discovery (Integration)', () => {
    let app: { baseUrl: string; close: () => void };

    before(async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', mcpRouter);
      const srv = a.listen(0);
      const addr = srv.address() as { port: number };
      app = { baseUrl: `http://localhost:${addr.port}`, close: () => srv.close() };
    });
    after(() => app.close());

    it('GET /tools returns categories only', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/platform/mcp/tools`);
      assert.equal(res.ok, true);
      const body = await res.json() as { categories: unknown[] };
      assert.ok(Array.isArray(body.categories));
      assert.ok(body.categories.length > 0);
      for (const cat of body.categories as any[]) {
        assert.ok('id' in cat);
        assert.ok('label' in cat);
        assert.ok('toolCount' in cat);
        assert.ok(!('tools' in cat));
      }
    });

    it('GET /tools/instances returns instances-category tools', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/platform/mcp/tools/instances`);
      assert.equal(res.ok, true);
      const body = await res.json() as { category: string; tools: unknown[] };
      assert.equal(body.category, 'instances');
      const names = (body.tools as any[]).map((t: any) => t.name);
      assert.ok(names.includes('list_instances'));
      assert.ok(names.includes('delete_instance'));
    });

    it('GET /tools/nonexistent returns -32001 error', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/platform/mcp/tools/nonexistent`);
      const body = await res.json() as { error?: { code: number } };
      assert.equal(body.error?.code, -32001);
    });
  });

  describe('MCP Authentication (Integration)', () => {
    it('POST /invoke with no auth → 401', async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', mcpRouter);
      const srv = a.listen(0);
      const addr = srv.address() as { port: number };
      try {
        const res = await fetch(`http://localhost:${addr.port}/api/v1/platform/mcp/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'health_check', parameters: {} }),
        });
        assert.equal(res.status, 401);
      } finally {
        srv.close();
      }
    });

    it('POST /invoke with unknown tool → -32601', async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', mcpRouter);
      const srv = a.listen(0);
      const addr = srv.address() as { port: number };
      try {
        const res = await fetch(`http://localhost:${addr.port}/api/v1/platform/mcp/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'unknown_tool_xyz', parameters: {} }),
        });
        assert.equal(res.ok, true);
        const body = await res.json() as { error: { code: number } };
        assert.equal(body.error.code, -32601);
      } finally {
        srv.close();
      }
    });
  });

  describe('MCP Tool Execution (Integration)', () => {
    let app: { baseUrl: string; close: () => void };

    before(async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', mcpRouter);
      const srv = a.listen(0);
      const addr = srv.address() as { port: number };
      app = { baseUrl: `http://localhost:${addr.port}`, close: () => srv.close() };
    });
    after(() => app.close());

    it('health_check returns a result with status field', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/platform/mcp/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'health_check', parameters: {} }),
      });
      assert.equal(res.ok, true);
      const body = await res.json() as { result: { status: string } };
      assert.ok('status' in body.result);
    });

    it('send_message missing required params → -32602', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/platform/mcp/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'send_message', parameters: { text: 'hi' } }),
      });
      const body = await res.json() as { error: { code: number } };
      assert.equal(body.error.code, -32602);
    });

    it('scope enforcement: PAT with messages:send cannot call delete_instance', async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', (req: any, _res: any, next: any) => {
        req.platformTenant = { accountId: 'acct_limited', publicId: 'pub_ltd', status: 'active', plan: { planId: 'p', name: 'n', monthlyMessageLimit: null } };
        req.platformKey = { scopes: ['messages:send'] };
        next();
      });
      a.use('/api/v1/platform/mcp', mcpRouter);
      const srv = a.listen(0);
      const addr = srv.address() as { port: number };
      try {
        const res = await fetch(`http://localhost:${addr.port}/api/v1/platform/mcp/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'delete_instance', parameters: { instanceId: 'inst_test' } }),
        });
        assert.equal(res.ok, true);
        const body = await res.json() as { error: { code: number; message: string; data: any } };
        assert.equal(body.error.code, -32007);
        assert.ok(body.error.message.includes('Forbidden'));
        assert.equal(body.error.data.tool, 'delete_instance');
      } finally {
        srv.close();
      }
    });
  });
} else {
  describe('Integration Tests', () => {
    it('skipped — PLATFORM_ENCRYPTION_KEY, DATABASE_URL, and REDIS_URL are not all set', () => {});
  });
}
