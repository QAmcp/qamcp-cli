// "Follows MCP best practices": tips from Anthropic's MCP guide, checked as facts, never scored.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tool } from '@modelcontextprotocol/client';
import { bestPracticesCheck, nameStyle } from '../src/bestPractices.js';
import { compareReports } from '../src/ci.js';
import { topFixes } from '../src/report.js';
import { scoreOf } from '../src/score.js';
import type { CheckResult, Report } from '../src/types.js';

const tool = (name: string, annotations?: Tool['annotations'], description = 'Does one thing well, described here.'): Tool => ({ name, description, inputSchema: { type: 'object' }, annotations });
const allLabels = { readOnlyHint: true, openWorldHint: false };

test('best practices: name styles', () => {
  assert.equal(nameStyle('github_create_issue'), 'snake_case');
  assert.equal(nameStyle('createIssue'), 'camelCase');
  assert.equal(nameStyle('create-issue'), 'kebab-case');
  assert.equal(nameStyle('search'), undefined);
});

test('best practices: common names and mixed styles are tips', () => {
  const c = bestPracticesCheck([tool('search', allLabels), tool('get_user', allLabels), tool('listOrders', allLabels)]);
  assert.equal(c.status, 'warn');
  const text = c.findings.map((f) => f.message).join('\n');
  assert.match(text, /Very common tool name: search/);
  assert.match(text, /mix styles: snake_case \(get_user\), camelCase \(listOrders\)/);
});

test('best practices: the two extra labels, asked only where they matter', () => {
  const c = bestPracticesCheck([tool('gh_get_issue', { readOnlyHint: true }), tool('gh_close_issue', { destructiveHint: false, openWorldHint: true })]);
  const text = c.findings.map((f) => f.message).join('\n');
  // read-only tools are naturally safe to repeat, so only the changing tool is asked about it
  assert.match(text, /1 tool not labeled read-only doesn't say whether running it twice is safe \(idempotentHint\): gh_close_issue/);
  assert.match(text, /1 tool doesn't say whether it reaches outside services .*: gh_get_issue/);
});

test('best practices: a huge tool list is called out with its size', () => {
  const tools = Array.from({ length: 30 }, (_, i) => tool(`acme_tool_${i}`, { ...allLabels, idempotentHint: true }, 'x'.repeat(2_000)));
  const c = bestPracticesCheck(tools);
  assert.match(c.findings[0].message, /The tool list is about \d+ KB \(roughly \d+k tokens\)/);
});

test('best practices: structured answers with no declared shape are named', () => {
  const tools = [tool('acme_get_order', allLabels), { ...tool('acme_get_user', allLabels), outputSchema: { type: 'object' } } as Tool, tool('acme_hello', allLabels)];
  const call = (t: string, text: string) => ({ tool: t, why: 'labeled read-only', kind: 'good-input', arguments: {}, ms: 5, outcome: 'ok', text }) as any;
  const c = bestPracticesCheck(tools, [call('acme_get_order', '{"id":1,"total":9}'), call('acme_get_user', '{"id":2}'), call('acme_hello', 'Hello there')]);
  const text = c.findings.map((f) => f.message).join('\n');
  assert.match(text, /1 tool answers with structured data but doesn't declare its shape \(outputSchema\): acme_get_order\./);
  assert.doesNotMatch(text, /acme_get_user|acme_hello/);
});

test('best practices: a tidy server passes', () => {
  const c = bestPracticesCheck([tool('acme_get_order', allLabels), tool('acme_cancel_order', { destructiveHint: true, idempotentHint: true, openWorldHint: false })]);
  assert.equal(c.status, 'pass');
});

test('best practices: never scored, never a CI regression, never a top fix', () => {
  const tips = bestPracticesCheck([tool('search')]);
  const ok: CheckResult = { id: 'connect', title: 'Connects', status: 'pass', summary: '', weight: 15, findings: [{ status: 'pass', message: 'ok' }] };
  assert.equal(scoreOf([ok, tips]).score, 100);
  const report = (checks: CheckResult[]) => ({ checks }) as Report;
  const before = report([ok, { ...tips, status: 'pass', findings: [] }]);
  assert.deepEqual(compareReports(report([ok, tips]), before).worse, []);
  assert.deepEqual(topFixes(report([ok, tips])), []);
});
