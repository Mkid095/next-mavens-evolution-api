/**
 * MCP — Comprehensive Tests
 *
 * Run with:
 *   npx tsx --test test/mcp.test.ts    # tsx native test runner (recommended)
 *   npx tsx test/mcp.test.ts           # watch mode (project default)
 *
 * Uses Node.js built-in assert/strict for assertions (compatible with node:test).
 *
 * Environment for integration tier:
 *   PLATFORM_ENCRYPTION_KEY=<hex> DATABASE_URL=<url> REDIS_URL=<url>
 */

// Register tsx as the TypeScript loader before any test globals are needed.
import { register } from 'tsx/cjs/api';
register();

// ─── Imports (after register) ───────────────────────────────────────────────
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CATEGORIES,
  MCP_TOOLS,
  TOOL_SCOPES,
  findTool,
  toolCountByCategory,
} from '../src/platform/mcp/tool-registry';
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from '../src/platform/mcp/jsonrpc';

// ─── Source reading helpers ──────────────────────────────────────────────────
//
// Only the *handler* and *route* bodies are read as text. The tool registry
// itself is imported above: asserting on source text for it meant the suite
// broke every time the registry moved, without anything being wrong.

function readSource(...parts: string[]): string {
  // Use process.cwd() because node --test resolves __dirname to cwd (.), not
  // the test file's directory.
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function readExecutorSource(): string {
  return readSource('src/platform/mcp/tool-executor.ts');
}

function readRouteSource(): string {
  return readSource('src/platform/routes/mcp.routes.ts');
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

function sliceCase(source: string, caseName: string, untilNextCase: string): string {
  const start = source.indexOf(`case '${caseName}':`);
  const end = source.indexOf(`case '${untilNextCase}':`, start);
  return source.slice(start, end > 0 ? end : source.length);
}

// Extract a section of the source between two // comment markers
function sliceByComment(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end > 0 ? end : source.length);
}

const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);

const HAS_INTEGRATION_ENV = !!(
  process.env.PLATFORM_ENCRYPTION_KEY &&
  process.env.DATABASE_URL &&
  process.env.REDIS_URL
);

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 1 — REGISTRY TESTS (always runs; no runtime deps)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Tool Registry — Completeness', () => {
  it('every registered tool has a name, description and schema', () => {
    assert.ok(MCP_TOOLS.length > 0);
    for (const tool of MCP_TOOLS) {
      assert.ok(tool.name, 'tool has a name');
      assert.ok(tool.description.trim().length > 0, `${tool.name} has a description`);
      assert.equal(typeof tool.category, 'string');
      assert.ok(tool.inputSchema, `${tool.name} has an inputSchema`);
      assert.equal(typeof tool.inputSchema.type, 'string');
      assert.ok(tool.inputSchema.properties, `${tool.name} schema has properties`);
    }
  });

  it('tool names are unique', () => {
    const seen = new Set<string>();
    for (const tool of MCP_TOOLS) {
      assert.ok(!seen.has(tool.name), `duplicate tool name ${tool.name}`);
      seen.add(tool.name);
    }
  });

  it('every tool category maps to a defined category id', () => {
    const catIds = CATEGORIES.map((c) => c.id);
    for (const tool of MCP_TOOLS) {
      assert.ok(catIds.includes(tool.category), `${tool.name} -> ${tool.category}`);
    }
  });

  it('every category is reachable and counted correctly', () => {
    const counts = toolCountByCategory();
    for (const cat of CATEGORIES) {
      const actual = MCP_TOOLS.filter((t) => t.category === cat.id).length;
      assert.equal(counts[cat.id], actual, `count for ${cat.id}`);
      assert.ok(actual > 0, `${cat.id} has at least one tool`);
    }
  });

  it('findTool resolves a registered tool and rejects an unknown one', () => {
    assert.ok(findTool('list_instances'));
    assert.equal(findTool('definitely_not_a_tool'), undefined);
  });

  it('the documentation category and tool are present', () => {
    assert.ok(CATEGORIES.some((c) => c.id === 'documentation'));
    assert.ok(findTool('get_documentation'), 'get_documentation tool is registered');
  });
});

describe('Tool Registry — Handler Coverage', () => {
  it('every registered tool has a corresponding switch case', () => {
    const cases = extractSwitchCases(readExecutorSource());
    for (const tool of MCP_TOOL_NAMES) {
      assert.ok(cases.includes(tool), `handler for ${tool}`);
    }
  });

  it('no case statement references an unknown tool', () => {
    const cases = extractSwitchCases(readExecutorSource());
    for (const c of cases) {
      assert.ok(MCP_TOOL_NAMES.includes(c), `unknown tool in a case: ${c}`);
    }
  });
});

describe('Scope Map', () => {
  it('TOOL_SCOPES has an entry for every tool', () => {
    for (const tool of MCP_TOOL_NAMES) {
      assert.ok(TOOL_SCOPES[tool], `scope entry for ${tool}`);
      assert.ok(Array.isArray(TOOL_SCOPES[tool]));
      assert.ok(TOOL_SCOPES[tool].length > 0, `${tool} has at least one scope`);
    }
  });

  it('every scope is a known scope string', () => {
    const known = new Set(Object.values(TOOL_SCOPES).flat());
    for (const scope of known) {
      assert.match(scope, /^[a-z_]+:(read|write|send)$/, `scope shape: ${scope}`);
    }
  });

  it('the scope check grants access on the wildcard scope', () => {
    const source = readSource('src/platform/mcp/scopes.ts');
    const fnSlice = source.slice(
      source.indexOf('export function checkToolScopes'),
      source.indexOf('export function checkToolScopes') + 900,
    );
    assert.match(fnSlice, /\.\s*includes\s*\(\s*['"]\*['"]\s*\)/);
    assert.match(fnSlice, /return true/);
  });
});

describe('API Key Security — Code Inspection', () => {
  it('list_api_keys never returns plaintextKey', () => {
    const block = sliceCase(readExecutorSource(), 'list_api_keys', 'create_api_key');
    assert.doesNotMatch(block, /\bplaintextKey\b/);
  });

  it('create_api_key returns the plaintext key (one-time display)', () => {
    const block = sliceCase(readExecutorSource(), 'create_api_key', 'revoke_api_key');
    assert.match(block, /\bplaintextKey\b/);
  });

  it('revoke_api_key does not return plaintextKey', () => {
    const block = sliceCase(readExecutorSource(), 'revoke_api_key', 'bind_api_key_instance');
    assert.doesNotMatch(block, /\bplaintextKey\b/);
  });

  it('health_check never exposes error.stack', () => {
    const block = sliceCase(readExecutorSource(), 'health_check', 'get_instance_logs');
    assert.doesNotMatch(block, /error\.stack/);
  });

  it('send_message never references a hardcoded host', () => {
    const block = sliceCase(readExecutorSource(), 'send_message', 'send_media');
    assert.doesNotMatch(block, /127\.0\.0\.1/);
    assert.doesNotMatch(block, /localhost(?::\d+)?(?=\/)/);
  });
});

describe('JSON-RPC Protocol', () => {
  it('error constants match the JSON-RPC 2.0 spec', () => {
    assert.equal(JSONRPC_INVALID_REQUEST, -32600);
    assert.equal(JSONRPC_METHOD_NOT_FOUND, -32601);
    assert.equal(JSONRPC_INVALID_PARAMS, -32602);
    assert.equal(JSONRPC_INTERNAL_ERROR, -32603);
  });

  it('the transport answers the standard MCP handshake', () => {
    const source = readSource('src/platform/mcp/mcp-server.ts');
    assert.match(source, /ListToolsRequestSchema/);
    assert.match(source, /CallToolRequestSchema/);
  });

  it('the transport is a real MCP Streamable HTTP transport', () => {
    const source = readSource('src/platform/mcp/transport.ts');
    assert.match(source, /StreamableHTTPServerTransport/);
  });

  it('jsonRpcError always returns HTTP 200 with an error envelope', () => {
    const source = readRouteSource();
    const fn = source.slice(
      source.indexOf('function jsonRpcError'),
      source.indexOf('function jsonRpcResult'),
    );
    assert.match(fn, /res\.status\(200\)\.json\(\{ error:/);
  });

  it('jsonRpcResult always returns HTTP 200 with a result envelope', () => {
    const source = readRouteSource();
    const fn = source.slice(
      source.indexOf('function jsonRpcResult'),
      source.indexOf('async function resolveInstance'),
    );
    assert.match(fn, /res\.status\(200\)\.json\(\{ result/);
  });
});

describe('Route Structure', () => {
  it('GET /tools returns category metadata, not full tool schemas', () => {
    const handler = sliceByComment(readRouteSource(), '// GET /tools', '// GET /tools/:category');
    assert.match(handler, /CATEGORIES\.map/);
    assert.match(handler, /res\.json\(\{ categories \}\)/);
  });

  it('GET /tools/:category returns filtered tools and the category id', () => {
    const handler = sliceByComment(readRouteSource(), '// GET /tools/:category', '// POST /invoke');
    assert.match(handler, /MCP_TOOLS\.filter/);
    assert.match(handler, /const\s*\{\s*category\s*\}\s*=\s*req\.params/);
  });

  it('POST /invoke uses hybridAuth and tenantResolveMiddleware', () => {
    const handler = sliceByComment(readRouteSource(), '// POST /invoke', '// --- Tool handler');
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

    it('GET /tools/nonexistent returns a -32001 error', async () => {
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

    it('health_check returns a result with a status field', async () => {
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

    it('scope enforcement: a key with only messages:send cannot call delete_instance', async () => {
      const express = (await import('express')).default;
      const { mcpRouter } = await import('../src/platform/routes/mcp.routes');
      const a = express();
      a.use(express.json());
      a.use('/api/v1/platform/mcp', (req: any, _res: any, next: any) => {
        req.platformTenant = {
          accountId: 'acct_limited',
          publicId: 'pub_ltd',
          status: 'ACTIVE',
          plan: { planId: 'p', name: 'n', monthlyMessageLimit: null },
          defaultApp: { id: 'a_1', publicId: 'app_1', projectId: 'p_1' },
        };
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
