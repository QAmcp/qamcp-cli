// Programs on this computer (stdio), the plug-in slot, and proof that nothing is sent anywhere
// except to the server being tested.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runTest } from '../src/runTest.js';
import type { Report } from '../src/types.js';
import { startFaultServer } from './faultServer.js';

const STDIO = { command: process.execPath, args: ['--import', 'tsx', 'test/stdioServer.ts'] };
const PORT = 4711;
let fault: Awaited<ReturnType<typeof startFaultServer>>;

before(async () => {
  fault = await startFaultServer(PORT);
});
after(() => {
  fault.closeAllConnections();
  fault.close();
});

const check = (r: Report, id: string) => r.checks.find((c) => c.id === id)!;

test('stdio: a program on this computer is tested like any server', async () => {
  const r = await runTest('stdio:test', { stdio: STDIO, timeoutMs: 30_000 });
  assert.equal(r.protocol?.transport, 'stdio');
  assert.equal(r.server?.name, 'stdio-test-server');
  assert.equal(r.toolCount, 2);
  assert.equal(check(r, 'connect').status, 'pass');
  assert.equal(check(r, 'respond').status, 'pass');
  assert.equal(check(r, 'oauth'), undefined, 'no login check for a program');
  assert.match(check(r, 'speed').findings.map((f) => f.message).join(' | '), /Started in .* isn't judged/);
  assert.equal(r.coverage.checksTotal, 10);
});

test('stdio: a program that cannot start is a plain failure, not a crash', async () => {
  const r = await runTest('stdio:missing', { stdio: { command: process.execPath, args: ['--import', 'tsx', 'test/does-not-exist.ts'] }, timeoutMs: 8_000 });
  assert.equal(r.checks[0].id, 'connect');
  assert.equal(r.checks[0].status, 'fail');
});

// Record every address the program reaches over the network.
async function spyOnNetwork<T>(work: () => Promise<T>): Promise<{ result: T; hosts: string[] }> {
  const real = globalThis.fetch;
  const hosts = new Set<string>();
  globalThis.fetch = ((input: any, init?: any) => {
    try {
      hosts.add(new URL(typeof input === 'string' ? input : (input.url ?? String(input))).host);
    } catch {
      hosts.add('unknown');
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    return { result: await work(), hosts: [...hosts].sort() };
  } finally {
    globalThis.fetch = real;
  }
}

test('nothing is sent anywhere except to the server being tested (no AI, no tracking)', async () => {
  const { hosts, result } = await spyOnNetwork(() => runTest(`http://127.0.0.1:${PORT}/mcp`, { timeoutMs: 30_000 }));
  assert.deepEqual(hosts, [`127.0.0.1:${PORT}`]);
  assert.equal(result.checks[0].status, 'pass');
  assert.match(result.dataFlow!.summary, /nothing was sent anywhere except to the server being tested/);
});

test('plug-in checks run after the built-in ones, count toward the score, and a broken one is ignored', async () => {
  const r = await runTest('stdio:plugins', {
    stdio: STDIO,
    timeoutMs: 30_000,
    extraChecks: [
      async ({ tools }) => ({ id: 'custom', title: 'My own check', status: 'fail', summary: '1 failed', weight: 10, findings: [{ status: 'fail', message: `saw ${tools.length} tools` }] }),
      async () => {
        throw new Error('broken plug-in');
      },
      async () => null,
    ],
  });
  assert.equal(r.checks.at(-1)!.id, 'custom');
  assert.match(r.checks.at(-1)!.findings[0].message, /saw 2 tools/);
  assert.equal(r.coverage.checksTotal, 11);
  const without = await runTest('stdio:plugins-off', { stdio: STDIO, timeoutMs: 30_000 });
  assert.ok(r.score < without.score, 'the plug-in check counted');
});
