// The root rule: a failure needs evidence. Every way a server can answer with an error, and the
// verdict QAmcp must give. "Sign in", "slow down" and errors we can't interpret are never
// counted against the server (real AgentMart case: "sign in first" was once called a crash).
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { after, before, test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';
import { runTest } from '../src/runTest.js';
import type { Finding, Report } from '../src/types.js';

const PORT = 4831;
type Answer = (res: any, id: unknown) => void;
const json = (status: number, body: unknown, headers = {}): Answer => (r) => r.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const text = (status: number, body: string, type = 'text/plain'): Answer => (r) => r.writeHead(status, { 'content-type': type }).end(body);

// name → [how the server answers, the status QAmcp must give, words the finding must contain]
const CASES: Record<string, [Answer, Finding['status'], RegExp]> = {
  http401: [json(401, { error: 'unauthorized' }), 'skip', /Needs you to sign in/],
  http403: [text(403, 'Forbidden'), 'skip', /Needs you to sign in/],
  http429: [json(429, { error: 'rate_limited' }, { 'retry-after': '30' }), 'skip', /limited our requests \(HTTP 429\)/],
  http418: [text(418, "I'm a teapot"), 'skip', /could not interpret, so it was not counted/],
  http400: [text(400, 'bad request: missing field'), 'pass', /Answered with an error/],
  http404: [text(404, 'Not Found'), 'pass', /Answered with an error/],
  http413: [text(413, 'Payload Too Large'), 'pass', /Answered with an error/],
  http503: [text(503, 'Service Unavailable'), 'warn', /temporarily unavailable \(HTTP 503\)/],
  http500: [text(500, '<html>Internal Server Error</html>', 'text/html'), 'fail', /Crashed: server error \(HTTP 500\)/],
  http502: [text(502, '<html>Bad Gateway</html>', 'text/html'), 'fail', /Crashed: server error \(HTTP 502\)/],
  dropped: [(r) => r.socket.destroy(), 'fail', /Crashed: the connection was cut/],
  notJson: [text(200, 'this is not json', 'application/json'), 'fail', /breaks the MCP rules.*not valid JSON/],
  emptyBody: [text(200, '', 'application/json'), 'fail', /breaks the MCP rules.*empty reply/],
  htmlPage: [text(200, '<html>Login page</html>', 'text/html'), 'fail', /breaks the MCP rules.*web page/],
  wrongShape: [(r, id) => json(200, { jsonrpc: '2.0', id, result: { content: 'not an array' } })(r, id), 'fail', /breaks the MCP rules.*"content" should be an array/],
};
const TOOLS = Object.keys(CASES).map((name) => ({ name, description: `Test tool that answers like ${name}. Returns text.`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }));
// Resources that fail in the same ways, by address.
const RES = ['http401', 'http429', 'http418', 'http500', 'notJson'];

const http = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : undefined;
  const name = body?.method === 'tools/call' ? body.params?.name : body?.method === 'resources/read' ? String(body.params?.uri).replace('cases://', '') : undefined;
  if (name && CASES[name]) return CASES[name][0](res, body.id);
  const server = new Server({ name: 'error-kinds', version: '0.0.1' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS as any }));
  server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: 'cases://fine', name: 'Fine', description: 'Opens fine', mimeType: 'text/plain' }, ...RES.map((r) => ({ uri: `cases://${r}`, name: r, description: `Answers like ${r}`, mimeType: 'text/plain' }))] }));
  server.setRequestHandler('resources/read', async (r) => ({ contents: [{ uri: (r.params as any).uri, mimeType: 'text/plain', text: 'hello' }] }));
  const t = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(t);
  await t.handleRequest(req, res, body);
});

let report: Report;
before(async () => {
  await new Promise<void>((r) => http.listen(PORT, '127.0.0.1', () => r()));
  report = await runTest(`http://127.0.0.1:${PORT}/mcp`, { timeoutMs: 5_000 });
});
after(() => {
  http.closeAllConnections();
  http.close();
});

for (const [name, [, status, words]] of Object.entries(CASES)) {
  test(`tool answering like ${name}: ${status}`, () => {
    const f = report.checks.find((c) => c.id === 'respond')!.findings.filter((x) => x.tool === name);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].status, status, f[0].message);
    assert.match(f[0].message, words);
  });
}

test('only real breakage caps the score; sign-in, slow-down and unclear answers never do', () => {
  assert.ok(report.scoreCaps?.some((c) => /crashes or hangs/.test(c.reason)), 'the 500s and the dropped connection do cap it');
  // tools that were not really tested don't count as run
  assert.equal(report.coverage.toolsRun, Object.values(CASES).filter(([, s]) => s !== 'skip').length);
});

test('nothing unrecognized is ever called a crash', () => {
  const crashed = report.checks.flatMap((c) => c.findings).filter((f) => /Crashed/.test(f.message)).map((f) => f.tool);
  assert.deepEqual([...new Set(crashed)].sort(), ['dropped', 'http500', 'http502']);
});

test('resources follow the same rule, and the count says how many could not be checked', () => {
  const f = report.checks.find((c) => c.id === 'resources')!.findings;
  const on = (uri: string) => f.filter((x) => x.tool === `cases://${uri}`);
  assert.equal(on('http401')[0].status, 'skip');
  assert.equal(on('http429')[0].status, 'skip');
  assert.equal(on('http418')[0].status, 'skip');
  assert.match(on('http500')[0].message, /crashed: server error \(HTTP 500\)/);
  assert.match(on('notJson')[0].message, /breaks the MCP rules/);
  assert.ok(f.some((x) => /Opened 1 of 3 resources; 3 could not be checked/.test(x.message)), f.map((x) => x.message).join(' | '));
});
