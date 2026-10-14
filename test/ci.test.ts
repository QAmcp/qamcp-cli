// CI: comparing with a baseline, the pass/fail decision, and the JUnit and markdown outputs. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareReports, evaluateGates, toJUnit, toMarkdown, toolFingerprints } from '../src/ci.js';
import type { Report } from '../src/types.js';

const check = (id: string, status: any, message = 'm', weight = 10) => ({ id, title: `Check ${id}`, status, summary: status === 'pass' ? 'All good' : '1 failed', weight, findings: [{ status, message }] });
const report = (score: number, checks: any[], extra: Partial<Report> = {}): Report =>
  ({ url: 'https://mcp.acme.ai/mcp', testedAt: '2026-10-14T06:00:00Z', score, toolCount: 3, coverage: { checksRun: checks.length, checksTotal: 12, toolsRun: 2, toolsTotal: 3 }, skippedTools: [], checks, calls: [], ...extra }) as Report;

const tools = (o: Record<string, string>): any => Object.entries(o).map(([name, description]) => ({ name, description, inputSchema: { type: 'object' } }));

test('fingerprints change when a description or input changes, and only for that tool', () => {
  const a = toolFingerprints(tools({ get_order: 'Get an order', search: 'Search things' }));
  const b = toolFingerprints(tools({ get_order: 'Get an order, with items', search: 'Search things' }));
  assert.notEqual(a.get_order, b.get_order);
  assert.equal(a.search, b.search);
});

test('compare: score drop, checks that got worse or better, tools added/removed/changed', () => {
  const base = report(90, [check('connect', 'pass'), check('leaks', 'pass'), check('speed', 'warn'), check('ai', 'skip')], { toolFingerprints: { a: '1', b: '2', c: '3' } });
  const now = report(70, [check('connect', 'pass'), check('leaks', 'fail'), check('speed', 'pass'), check('ai', 'pass')], { toolFingerprints: { a: '1', b: 'X', d: '4' } });
  const c = compareReports(now, base);
  assert.equal(c.scoreDelta, -20);
  assert.deepEqual(c.worse.map((w) => [w.id, w.from, w.to]), [['leaks', 'pass', 'fail']]);
  assert.deepEqual(c.better.map((w) => w.id), ['speed']); // "ai" was skipped before, so it isn't an improvement
  assert.deepEqual(c.tools, { added: ['d'], removed: ['c'], changed: ['b'], unchanged: false });
});

test('compare: identical tools are reported as unchanged', () => {
  const r = report(80, [check('connect', 'pass')], { toolFingerprints: { a: '1' } });
  assert.equal(compareReports(r, r).tools?.unchanged, true);
});

test('gates: nothing asked means pass; each gate fails for its own reason', () => {
  const r = report(72, [check('connect', 'pass'), check('leaks', 'fail', 'Error shows an API key')]);
  assert.deepEqual(evaluateGates(r, {}), { exitCode: 0, reasons: [] });
  assert.match(evaluateGates(r, { failUnder: 80 }).reasons[0], /score 72 is below the required 80/);
  assert.equal(evaluateGates(r, { failUnder: 70 }).exitCode, 0);
  assert.match(evaluateGates(r, { failOnFail: true }).reasons[0], /failed: Check leaks/);
});

test('gates: baseline drop beyond the allowance, a check turning to fail, and removed tools each fail the build', () => {
  const base = report(90, [check('connect', 'pass'), check('leaks', 'pass')], { toolFingerprints: { a: '1', b: '2' } });
  const small = report(87, [check('connect', 'pass'), check('leaks', 'pass')], { toolFingerprints: { a: '1', b: '2' } });
  assert.equal(evaluateGates(small, { maxDrop: 5 }, compareReports(small, base)).exitCode, 0);
  assert.equal(evaluateGates(small, { maxDrop: 2 }, compareReports(small, base)).exitCode, 1);

  const worse = report(89, [check('connect', 'pass'), check('leaks', 'fail')], { toolFingerprints: { a: '1' } });
  const g = evaluateGates(worse, {}, compareReports(worse, base));
  assert.equal(g.exitCode, 1);
  assert.ok(g.reasons.some((r) => /"Check leaks" got worse: pass → fail/.test(r)));
  assert.ok(g.reasons.some((r) => /tools were removed.*: b/.test(r)));
});

test('gates: a server that could not be tested is exit 3, not a quality failure', () => {
  const r = report(0, [check('connect', 'fail', 'The server needs a login key.')], { notScored: 'needs a login' });
  assert.equal(evaluateGates(r, { failUnder: 80 }).exitCode, 3);
  const down = report(0, [check('connect', 'fail', 'Nothing is running at that address.')]);
  const g = evaluateGates(down, {});
  assert.equal(g.exitCode, 3);
  assert.match(g.reasons[0], /Nothing is running/);
});

// A small well-formedness check: every opened tag is closed in order, with no stray "<" or "&".
function wellFormed(xml: string): boolean {
  const body = xml.replace(/<\?xml[^>]*\?>/, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === '/') continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]);
  }
  const text = body.replace(/<[^>]*>/g, '');
  return stack.length === 0 && !/[<]/.test(text) && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(text);
}

test('JUnit: failures, skips and warnings in the right places, and special characters are escaped', () => {
  const r = report(60, [
    check('connect', 'pass'),
    check('leaks', 'fail', 'Error shows <script> & a "key" (sk-test)'),
    check('speed', 'warn', 'Slow: 8.0 s'),
    check('ai', 'skip', 'Not run (no AI key)'),
  ]);
  const xml = toJUnit(r);
  assert.ok(wellFormed(xml), xml);
  assert.match(xml, /<testsuite name="QAmcp: https:\/\/mcp.acme.ai\/mcp" tests="4" failures="1" skipped="1"/);
  assert.match(xml, /<failure message="1 failed">FAIL: Error shows &lt;script&gt; &amp; a &quot;key&quot; \(sk-test\)<\/failure>/);
  assert.match(xml, /<skipped message="Not run \(no AI key\)"\/>/);
  assert.match(xml, /<system-out>WARN: Slow: 8.0 s<\/system-out>/);
});

test('JUnit: control characters from a server never break the XML', () => {
  const r = report(50, [check('leaks', 'fail', 'bad \u0000 \u0007 char \u001b[31m')]);
  assert.ok(wellFormed(toJUnit(r)));
});

test('markdown: score, why it failed, the comparison, a table, and the fixes', () => {
  const base = report(90, [check('connect', 'pass'), check('leaks', 'pass')], { toolFingerprints: { a: '1' } });
  const now = report(70, [check('connect', 'pass'), check('leaks', 'fail', 'Error shows a key')], {
    toolFingerprints: { a: '2' },
    scoreBeforeCaps: 80,
    scoreCaps: [{ max: 70, reason: 'a tool crashes or hangs' }],
    dataFlow: { summary: 'Privacy: nothing was sent anywhere except to the server being tested.' },
  });
  const cmp = compareReports(now, base);
  const md = toMarkdown(now, cmp, evaluateGates(now, { failUnder: 80 }, cmp));
  assert.match(md, /^## QAmcp: 70\/100 ❌ failed/);
  assert.match(md, /Would be 80, capped at 70 because a tool crashes or hangs/);
  assert.match(md, /score 70 is below the required 80/);
  assert.match(md, /90 → 70 \(-20\)/);
  assert.match(md, /Tools changed: changed a/);
  assert.match(md, /\| ❌ \| Check leaks \|/);
  assert.match(md, /\*\*Fix these first\*\*\n1\. Error shows a key/);
  assert.match(md, /Privacy: nothing was sent anywhere/);
});

test('markdown stays under the pull-request comment size limit', () => {
  const many = Array.from({ length: 400 }, (_, i) => check(`c${i}`, 'warn', 'x'.repeat(300)));
  assert.ok(toMarkdown(report(50, many)).length <= 60_100);
});
