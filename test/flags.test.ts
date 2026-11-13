// The three questions before the score, and the separate "tools run" line with its one reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportFlags } from '../src/flags.js';
import { toHtml } from '../src/htmlReport.js';
import { formatReport } from '../src/report.js';
import type { CheckResult, Finding, Report, Status } from '../src/types.js';

const check = (id: string, status: Status, findings: Finding[]): CheckResult => ({ id, title: id, status, summary: '', weight: 10, findings });
const call = (tool: string, extra: any = {}) => ({ tool, kind: 'good-input', why: 'labeled read-only', arguments: {}, ms: 5, outcome: 'ok', text: 'ok', ...extra });
const report = (extra: Partial<Report> = {}): Report =>
  ({
    url: 'https://mcp.example.com/mcp', testedAt: '2026-11-12T10:00:00Z', score: 80, toolCount: 3,
    coverage: { checksRun: 8, checksTotal: 10, toolsRun: 3, toolsTotal: 3 }, skippedTools: [], calls: [call('a'), call('b'), call('c')],
    server: { name: 'example' }, protocol: { version: '2026-07-28', transport: 'streamable-http' },
    checks: [
      check('connect', 'pass', [{ status: 'pass', message: 'Connected in 80 ms' }]),
      check('tools', 'pass', [{ status: 'pass', message: 'Found 3 tools' }]),
      check('descriptions', 'pass', [{ status: 'pass', message: 'All 3 tools and their inputs are described' }]),
      check('labels', 'pass', [{ status: 'pass', message: 'Every tool has a safety label' }]),
    ],
    ...extra,
  }) as Report;

test('a clean server: no reason found, read-only labels counted, tools seen without a login, every tool ran', () => {
  const f = reportFlags(report());
  assert.equal(f.wrongTool.answer, 'No reason found');
  assert.equal(f.readOnly.answer, 'Yes, 3 of 3');
  assert.equal(f.noLogin.answer, 'Yes');
  assert.equal(f.toolsRun.answer, '3 of 3');
});

test('wrong-tool answers come only from the description findings that affect picking, each with its evidence', () => {
  const r = report();
  r.checks[2] = check('descriptions', 'warn', [
    { status: 'warn', tool: 'a', message: 'Inputs with no description: q' },
    { status: 'warn', tool: 'b', message: 'b and c have nearly the same description (80% of their words are shared), so an AI may not know which to pick' },
    { status: 'warn', tool: 'c', message: 'Description uses vague words ("various") instead of saying what it does and returns: "x"' },
    { status: 'warn', tool: 'c', message: 'Description is very long (5000 characters), which uses up the AI\'s memory' },
  ]);
  const f = reportFlags(r).wrongTool;
  assert.equal(f.answer, 'Yes, 3 places', 'a very long description is about memory, not about picking');
  assert.deepEqual(f.evidence.map((e) => e.tool), ['a', 'b', 'c']);
  assert.ok(f.evidence.every((e) => e.check === 'descriptions'));
});

test('no tool labeled read-only: says No, and the tools-run line gives that reason, not a login or an outage', () => {
  const f = reportFlags(report({
    coverage: { checksRun: 8, checksTotal: 11, toolsRun: 0, toolsTotal: 3 }, calls: [],
    skippedTools: ['a', 'b', 'c'].map((tool) => ({ tool, why: 'no safety label (if you own this server, test again in owner mode)' })),
    checks: [report().checks[0], report().checks[1], report().checks[2], check('labels', 'warn', [{ status: 'warn', message: '3 of 3 tools have no safety label (read-only or dangerous): a, b, c' }])],
  }));
  assert.equal(f.readOnly.answer, 'No');
  assert.equal(f.toolsRun.answer, '0 of 3');
  assert.match(f.toolsRun.evidence[0].text, /Why: no tool is labeled read-only/);
  assert.doesNotMatch(f.toolsRun.evidence[0].text, /login|answer/);
});

test('a login wall: the tool questions are not checked yet, and it is never marked as a fault', () => {
  const f = reportFlags(report({
    notScored: 'needs a login', toolCount: 0, calls: [], coverage: { checksRun: 0, checksTotal: 11, toolsRun: 0, toolsTotal: 0 },
    checks: [check('connect', 'fail', [{ status: 'fail', message: 'The server needs a login (HTTP 401).' }])],
  }));
  assert.equal(f.wrongTool.answer, 'Not checked yet');
  assert.equal(f.readOnly.answer, 'Not checked yet');
  assert.equal(f.noLogin.answer, 'No');
  assert.match(f.toolsRun.evidence[0].text, /Why: a login wall/);
  for (const x of Object.values(f)) assert.notEqual(x.tone, 'bad');
});

test('a login wall in a report saved before "not scored" existed is still a login wall', () => {
  const f = reportFlags(report({ toolCount: 0, calls: [], coverage: { checksRun: 1, checksTotal: 11, toolsRun: 0, toolsTotal: 0 }, checks: [check('connect', 'fail', [{ status: 'fail', message: 'The server needs a login key. Add it and test again.' }])] }));
  assert.equal(f.noLogin.answer, 'No');
  assert.match(f.toolsRun.evidence[0].text, /login wall/);
});

test('a server that does not answer: we could not tell about the login, and the reason says the server did not answer', () => {
  const f = reportFlags(report({ toolCount: 0, calls: [], coverage: { checksRun: 1, checksTotal: 11, toolsRun: 0, toolsTotal: 0 }, checks: [check('connect', 'fail', [{ status: 'fail', message: 'No answer within 20 s' }])] }));
  assert.equal(f.noLogin.answer, "Couldn't tell");
  assert.equal(f.wrongTool.answer, 'Not checked');
  assert.match(f.toolsRun.evidence[0].text, /Why: the server did not answer/);
  assert.equal(f.toolsRun.evidence[1].text, 'No answer within 20 s');
});

test('look-only mode is said plainly, not counted as a problem', () => {
  const f = reportFlags(report({ testedAs: { safety: 'none', loggedIn: false }, calls: [], coverage: { checksRun: 6, checksTotal: 10, toolsRun: 0, toolsTotal: 3 }, skippedTools: ['a', 'b', 'c'].map((tool) => ({ tool, why: 'look-only mode: no tools are called' })) }));
  assert.equal(f.toolsRun.tone, 'none');
  assert.match(f.toolsRun.evidence[0].text, /Look-only mode/);
});

test('a tool that breaks the tool list is counted apart: its label could not be read, and it could not be called', () => {
  const r = report({ toolCount: 4, coverage: { checksRun: 8, checksTotal: 10, toolsRun: 3, toolsTotal: 4 } });
  r.checks[1] = check('tools', 'fail', [{ status: 'fail', tool: 'd', message: 'Breaks the tool list: has no input definition (inputSchema)' }, { status: 'pass', message: 'Found 4 tools' }]);
  const f = reportFlags(r);
  assert.equal(f.readOnly.answer, 'Yes, 3 of 3');
  assert.ok(f.readOnly.evidence.some((e) => /could not be read/.test(e.text)));
  assert.equal(f.toolsRun.answer, '3 of 4');
  assert.match(f.toolsRun.evidence[0].text, /breaks the tool list, so it could not be called/);
  assert.doesNotMatch(f.toolsRun.evidence.map((e) => e.text).join(' '), /Tools not run, and why/, 'nothing was skipped, so that list is not on the page');
});

test('newer reports count the labels from each tool\'s own definition', () => {
  const f = reportFlags(report({ toolDefs: [{ name: 'a', annotations: { readOnlyHint: true } }, { name: 'b', annotations: { readOnlyHint: false } }, { name: 'c' }] }));
  assert.equal(f.readOnly.answer, 'Yes, 1 of 3');
});

test('older reports: tools skipped for a reason that hides their label make the count "at least"', () => {
  const f = reportFlags(report({ calls: [call('a')], skippedTools: [{ tool: 'b', why: 'we test at most 25 tools' }, { tool: 'c', why: 'labeled dangerous' }], coverage: { checksRun: 8, checksTotal: 10, toolsRun: 1, toolsTotal: 3 } }));
  assert.equal(f.readOnly.answer, 'Yes, at least 1 of 3');
});

test('the page shows the questions before the score, links each to its test item, and escapes server text', () => {
  const r = report();
  r.checks[2] = check('descriptions', 'warn', [{ status: 'warn', tool: '<img src=x>', message: 'Inputs with no description: <script>' }]);
  const html = toHtml(r);
  const flags = html.indexOf('Could a description make the AI pick the wrong tool?');
  assert.ok(flags > 0 && flags < html.indexOf('class="score"'), 'the questions come before the score');
  assert.ok(html.indexOf('Tools run') < html.indexOf('class="score"'));
  assert.match(html, /<a class="code" href="#T-3">T-3<\/a>/);
  assert.match(html, /<details class="row warn" id="T-3">/);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
  assert.doesNotMatch(html, /<script/i, 'a saved report still has no scripts');
});

test('the terminal report gives the same answers before the score', () => {
  const text = formatReport(report());
  const q = text.indexOf('Could a description make the AI pick the wrong tool? No reason found');
  assert.ok(q > 0 && q < text.indexOf('SCORE:'));
  assert.match(text, /Is anything marked read-only\? Yes, 3 of 3/);
  assert.match(text, /Tools run: 3 of 3/);
});
