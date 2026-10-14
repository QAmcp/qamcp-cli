// Every common way a link can be wrong gets plain words, never "fetch failed {cause}".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { runTest } from '../src/runTest.js';

const PORT = 4800;
const site = createServer((req, res) => {
  if (req.url === '/page') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><title>Hi</title></head><body>A website</body></html>');
  if (req.url === '/broken') return void res.writeHead(500, { 'content-type': 'text/plain' }).end('oops');
  res.writeHead(404).end();
});
before(() => new Promise<void>((r) => site.listen(PORT, '127.0.0.1', () => r())));
after(() => {
  site.closeAllConnections();
  site.close();
});

const reason = async (url: string) => (await runTest(url, { timeoutMs: 8_000 })).checks.find((c) => c.id === 'connect')!.findings[0].message;

test('a name that does not exist', async () => {
  assert.match(await reason('https://no-such-host.invalid/mcp'), /does not exist/);
});
test('nothing running there', async () => {
  assert.match(await reason('http://127.0.0.1:59998/mcp'), /Nothing is running at that address/);
});
test('a normal web page, not an MCP server', async () => {
  assert.match(await reason(`http://127.0.0.1:${PORT}/page`), /normal web page, not an MCP server/);
});
test('a server error', async () => {
  assert.match(await reason(`http://127.0.0.1:${PORT}/broken`), /answered with an error \(HTTP 500\)/);
});
test('no message ever shows the raw "{cause}" text', async () => {
  for (const u of ['https://no-such-host.invalid/mcp', 'http://127.0.0.1:59998/mcp', `http://127.0.0.1:${PORT}/broken`]) assert.doesNotMatch(await reason(u), /\{"cause"|fetch failed/);
});
