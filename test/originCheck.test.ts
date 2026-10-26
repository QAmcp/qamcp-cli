// "Blocks requests from other websites": local servers must check the Origin header (MCP spec).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalUrl, originCheck } from '../src/originCheck.js';

// A pretend server: answers the plain hello with `plain`, and one with an Origin header with `withOrigin`.
const server = (plain: number, withOrigin: number) => {
  const seen: { method: string; origin?: string; session?: string }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({ method: init.method!, origin: h.origin, session: h['mcp-session-id'] });
    const status = init.method === 'DELETE' ? 200 : h.origin ? withOrigin : plain;
    return new Response('{}', { status, headers: status < 300 ? { 'mcp-session-id': 's1' } : {} });
  }) as typeof fetch;
  return { f, seen };
};

test('origin: only servers on this computer are checked', async () => {
  for (const u of ['http://localhost:3000/mcp', 'http://127.0.0.1:8080/mcp', 'http://[::1]:3000/mcp', 'http://app.localhost/mcp']) assert.ok(isLocalUrl(u), u);
  assert.ok(!isLocalUrl('https://mcp.context7.com/mcp'));
  assert.equal(await originCheck('https://mcp.context7.com/mcp', {}, undefined, 1000, server(200, 200).f), undefined);
});

test('origin: a server that answers a strange website is a tip, and our sessions are closed', async () => {
  const s = server(200, 200);
  const c = (await originCheck('http://localhost:3000/mcp', {}, '2025-06-18', 1000, s.f))!;
  assert.equal(c.status, 'warn');
  assert.equal(c.weight, 0);
  assert.match(c.findings[0].message, /Accepted a request claiming to come from another website/);
  assert.equal(s.seen.filter((r) => r.method === 'DELETE' && r.session === 's1').length, 2);
});

test('origin: refusing the strange website passes; no normal answer means we can\'t tell', async () => {
  assert.equal((await originCheck('http://localhost:3000/mcp', {}, undefined, 1000, server(200, 403).f))!.status, 'pass');
  const unclear = (await originCheck('http://localhost:3000/mcp', {}, undefined, 1000, server(401, 403).f))!;
  assert.equal(unclear.status, 'skip');
  assert.match(unclear.findings[0].message, /Couldn't tell/);
});
