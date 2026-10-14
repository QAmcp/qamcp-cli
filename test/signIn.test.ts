// A tool that answers "sign in first" is working as designed: never call it a crash
// (real AgentMart case). A tool that really breaks must still be called a crash.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { after, before, test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';
import { formatReport } from '../src/report.js';
import { runTest } from '../src/runTest.js';
import type { Report } from '../src/types.js';

const PORT = 4820;
const TOOLS: any[] = [
  { name: 'get_catalog', description: 'List the public catalog items. Returns names and prices.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'whoami', description: 'Tell who is signed in. Returns the account name.', inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Session token' } } }, annotations: { readOnlyHint: true } },
  { name: 'get_report', description: 'Get the daily report. Returns the report text.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];

const http = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : undefined;
  const tool = body?.method === 'tools/call' ? body.params?.name : undefined;
  // Like AgentMart: the whole HTTP request is refused with 401 and a sign-in message.
  if (tool === 'whoami')
    return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', error_description: 'Only the public tools work without sign-in', next: 'Sign in through the website' }));
  // A real breakage: HTTP 500 with an HTML error page.
  if (tool === 'get_report') return void res.writeHead(500, { 'content-type': 'text/html' }).end('<html><body>Internal Server Error</body></html>');
  const server = new Server({ name: 'sign-in-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text' as const, text: JSON.stringify([{ name: 'Mug', price: 12 }]) }] }));
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

let report: Report;
before(async () => {
  await new Promise<void>((r) => http.listen(PORT, '127.0.0.1', () => r()));
  report = await runTest(`http://127.0.0.1:${PORT}/mcp`, { timeoutMs: 8_000 });
});
after(() => {
  http.closeAllConnections();
  http.close();
});

const findings = (id: string, tool: string) => report.checks.find((c) => c.id === id)!.findings.filter((f) => f.tool === tool);

test('a tool that asks you to sign in is "not tested", never "crashed"', () => {
  const r = findings('respond', 'whoami');
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'skip');
  assert.match(r[0].message, /Needs you to sign in/);
  for (const id of ['respond', 'bad-input']) assert.ok(!findings(id, 'whoami').some((f) => f.status === 'fail' || /Crash/.test(f.message)), id);
});

test('it does not count against the server, and the report says so plainly', () => {
  assert.equal(report.coverage.toolsRun, 2, 'whoami was not really run');
  const text = formatReport(report);
  assert.match(text, /1 tool asked us to sign in first, so it was not tested: whoami/);
});

test('a tool that really breaks is still a crash, and still caps the score', () => {
  const r = findings('respond', 'get_report');
  assert.equal(r[0].status, 'fail');
  assert.match(r[0].message, /Crashed/);
  assert.ok(report.scoreCaps?.some((c) => /crashes or hangs/.test(c.reason)));
});

test('the working tool still works', () => {
  assert.equal(findings('respond', 'get_catalog')[0].status, 'pass');
});
