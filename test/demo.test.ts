// `qamcp-cli --demo`: the demo server shipped with the tool, and what QAmcp finds on it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDemoServer } from '../src/demoServer.js';
import { runTest } from '../src/runTest.js';

test('demo: every planted problem is caught, and no tool that changes data is ever called', async () => {
  const demo = await startDemoServer();
  try {
    const r = await runTest(demo.url, { timeoutMs: 5_000 });
    const msgs = r.checks.flatMap((c) => c.findings.map((f) => `${f.status} ${f.tool ?? ''} ${f.message}`)).join('\n');
    assert.match(msgs, /fail fetch_notes .*hidden <IMPORTANT> block/);
    assert.match(msgs, /fail search_users .*database password/);
    assert.match(msgs, /fail slow_report .*No answer within the time limit/);
    assert.match(msgs, /fail slow_report .*Has no description/);
    assert.match(msgs, /warn delete_account .*not labeled dangerous/);
    assert.ok(r.score < 50, `score ${r.score}`);
    assert.equal(demo.dangerousCalls(), 0, 'a tool that changes data was called');
  } finally {
    demo.close();
  }
});

test('demo: it only listens on this computer', async () => {
  const demo = await startDemoServer();
  try {
    assert.match(demo.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  } finally {
    demo.close();
  }
});
