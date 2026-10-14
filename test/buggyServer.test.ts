// Proves the tester catches every problem planted in the buggy server,
// and never runs a tool that could change data. Run: npm test
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runTest } from '../src/runTest.js';
import type { Report } from '../src/types.js';
import { startBuggyServer } from './buggyServer.js';

const PORT = 4199;
let http: Awaited<ReturnType<typeof startBuggyServer>>;
let report: Report;

before(async () => {
  http = await startBuggyServer(PORT);
  // We own this server, so owner mode is allowed.
  report = await runTest(`http://127.0.0.1:${PORT}/mcp`, { timeoutMs: 4_000, safety: 'owner' });
});
after(() => {
  http.closeAllConnections();
  http.close();
});

const check = (id: string) => {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `missing check ${id}`);
  return c;
};
const has = (id: string, status: string, tool: string | undefined, text: RegExp) =>
  assert.ok(
    check(id).findings.some((f) => f.status === status && (tool === undefined || f.tool === tool) && text.test(f.message)),
    `expected ${status} on ${tool ?? '-'} matching ${text} in "${id}": ${JSON.stringify(check(id).findings, null, 1)}`,
  );

test('never runs a tool that could change data', async () => {
  const calls = await (await fetch(`http://127.0.0.1:${PORT}/dangerous-calls`, { headers: { connection: 'close' } })).text();
  assert.equal(calls, '0');
  for (const name of ['delete_account', 'team_digest', 'get_or_create_user']) {
    assert.ok(!report.calls.some((c) => c.tool === name), `ran ${name}`);
    assert.ok(report.skippedTools.some((s) => s.tool === name), `${name} not listed as skipped`);
  }
});

test('runs an unlabeled tool whose name clearly only reads', () => {
  assert.ok(report.calls.some((c) => c.tool === 'list_projects' && c.why === 'name says read-only'));
  has('respond', 'pass', undefined, /ran because the name says it only reads: list_projects/);
});

test('reports how much was tested', () => {
  assert.deepEqual(report.coverage, { checksRun: 10, checksTotal: 10, toolsRun: 6, toolsTotal: 9 });
});

test('connects and lists all 9 tools', () => {
  assert.equal(check('connect').status, 'pass');
  assert.equal(report.toolCount, 9);
});

test('flags missing descriptions', () => {
  has('descriptions', 'fail', 'slow_report', /no description/);
  has('descriptions', 'warn', 'search_users', /Inputs with no description: name/);
});

test('flags the dangerous-sounding tool without a label', () => {
  has('labels', 'warn', 'delete_account', /not labeled dangerous/);
});

test('flags hidden instructions', () => {
  has('hidden', 'fail', 'fetch_notes', /IMPORTANT/);
  assert.ok(!check('hidden').findings.some((f) => f.tool === 'get_weather'));
});

test('flags the tool that hangs', () => {
  has('respond', 'fail', 'slow_report', /No answer/);
  has('respond', 'pass', 'get_weather', /Worked/);
});

test('judges bad-input handling', () => {
  has('bad-input', 'pass', 'get_weather', /Refused missing required input "city"/);
  has('bad-input', 'warn', 'fetch_notes', /Accepted/);
  has('bad-input', 'fail', 'slow_report', /Hung/);
});

test('a clean error sent with HTTP 400 counts as a refusal, plus a note, not a crash', () => {
  has('bad-input', 'pass', 'strict_lookup', /Refused missing required input "code" with a clear error/);
  has('bad-input', 'warn', undefined, /HTTP error status.*strict_lookup/);
  assert.ok(!check('bad-input').findings.some((f) => f.tool === 'strict_lookup' && f.status === 'fail'));
});

test('flags the slow tool', () => {
  has('speed', 'warn', 'search_users', /Slowest tool/);
});

test('flags the leaked database password', () => {
  has('leaks', 'fail', 'search_users', /database password/);
});

test('score reflects the problems', () => {
  assert.ok(report.score <= 40, `score was ${report.score}`);
  assert.ok(report.scoreCaps?.some((c) => c.max === 40 && /hidden/.test(c.reason)));
});

test('a dead address fails cleanly with a plain message', async () => {
  const dead = await runTest('http://127.0.0.1:4198/mcp', { timeoutMs: 3_000 });
  assert.equal(dead.score, 0);
  assert.equal(dead.checks[0].status, 'fail');
  assert.match(dead.checks[0].findings[0].message, /Nothing is running|Could not connect/);
});

import { formatReport } from '../src/report.js';

test('the printed report never says "All passed" next to a problem in the same check', () => {
  const text = formatReport(report);
  const badInput = text.split('\n').filter((l) => /passed/.test(l) && /^\s+✅/.test(l));
  assert.ok(badInput.length, 'a collapsed pass line is printed');
  assert.match(text, /✅ \d+ of \d+ passed \(the problems are listed below\)/);
  // every "All N passed" line belongs to a check with no warnings or failures
  const blocks = text.split(/\n(?=[✅⚠️❌➖])/u);
  for (const b of blocks) if (/All \d+ passed/.test(b)) assert.doesNotMatch(b, /⚠️|❌/u, b);
});
