// Resources and prompts, against a pretend server with every kind of mistake planted, and a
// clean version that must pass. No AI.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runTest } from '../src/runTest.js';
import type { Report } from '../src/types.js';
import { startResourceServer } from './resourceServer.js';

const PORT = 4810;
let srv: Awaited<ReturnType<typeof startResourceServer>>;
const reports: Record<string, Report> = {};

before(async () => {
  srv = await startResourceServer(PORT);
  for (const v of ['clean', 'faulty', 'many', 'evil', 'empty', 'tools']) reports[v] = await runTest(`http://127.0.0.1:${PORT}/${v}/mcp`, { timeoutMs: 10_000 });
});
after(() => {
  srv.closeAllConnections();
  srv.close();
});

const rc = (v: string) => reports[v].checks.find((c) => c.id === 'resources');
const msgs = (v: string, status: string, where?: string) =>
  rc(v)!.findings.filter((f) => f.status === status && (!where || f.tool === where)).map((f) => f.message).join(' | ');

test('a server that does it all right gets a clean pass, and counts the new check', () => {
  const c = rc('clean')!;
  assert.equal(c.status, 'pass', JSON.stringify(c.findings, null, 1));
  // includes a file named .env.example, code with c.env, and Persian text: none of it is a trick
  assert.match(c.summary, /5 resources, 1 template, 1 prompt/);
  assert.match(msgs('clean', 'pass'), /Opened 5 of 5 resources/);
  assert.match(msgs('clean', 'pass'), /Opened 1 of 1 prompts/);
  assert.match(msgs('clean', 'pass'), /does not exist gets a clean "not found"/);
  assert.equal(reports.clean.coverage.checksTotal, 11);
  // Good resources and prompts never cost points: the same server without them scores no higher.
  assert.ok(reports.clean.score >= reports.tools.score, `${reports.clean.score} vs ${reports.tools.score}`);
});

test('no resources or prompts: no check, nothing changes', () => {
  assert.equal(rc('tools'), undefined);
  assert.equal(reports.tools.coverage.checksTotal, 10);
  assert.equal(rc('empty'), undefined, 'declared but empty is not a check either');
});

test('resources: every planted mistake is caught', () => {
  assert.equal(rc('faulty')!.status, 'fail');
  assert.match(msgs('faulty', 'warn', 'data://bad.json'), /Says it is application\/json, but the content is not valid JSON/);
  assert.match(msgs('faulty', 'warn', 'notes://empty'), /opening it returns nothing/);
  assert.match(msgs('faulty', 'fail', 'notes://crash'), /opening it (crashed|fails)/);
  assert.match(msgs('faulty', 'warn', 'notes://inject'), /"ignore previous instructions".*may follow it/);
  assert.match(msgs('faulty', 'warn', 'notes://smuggle'), /invisible tag characters/);
  assert.match(msgs('faulty', 'warn'), /listed more than once: notes:\/\/shopping/);
  assert.match(msgs('faulty', 'warn'), /resources have no description/);
  assert.match(msgs('faulty', 'warn'), /doesn't exist .* returns content instead of a "not found" error/);
  assert.match(msgs('faulty', 'warn', 'notes://boom/{id}'), /internal error instead of a clean "not found"/);
});

test('prompts: every planted mistake is caught', () => {
  assert.match(msgs('faulty', 'warn', 'greet'), /Ignores its input \(person\)/);
  assert.match(msgs('faulty', 'fail', 'welcome'), /Leaves the placeholder for user unfilled/);
  assert.match(msgs('faulty', 'fail', 'broken'), /crashed/);
  assert.match(msgs('faulty', 'warn', 'lenient'), /Doesn't complain when the required input topic is missing/);
  assert.match(msgs('faulty', 'warn', 'lenient'), /Inputs with no description: topic/);
  assert.match(msgs('faulty', 'fail', 'weird_role'), /breaks the MCP rules.*role other than "user" or "assistant"/);
  assert.doesNotMatch(msgs('faulty', 'warn', 'welcome'), /Ignores/, 'one clear finding, not two');
  assert.match(msgs('faulty', 'warn', 'picky'), /sample inputs get an internal error instead of an "invalid input" error/);
  assert.equal(msgs('faulty', 'fail', 'picky'), '', 'rejecting our made-up value is not a crash');
  assert.match(msgs('faulty', 'warn'), /Opened \d of 7 prompts/);
});

test('prompts done right are not accused: summarize uses its input and rejects a missing one', () => {
  assert.equal(msgs('faulty', 'warn', 'summarize'), '');
  assert.equal(msgs('faulty', 'fail', 'summarize'), '');
});

test('many resources: a sample is opened, and the report says so', () => {
  assert.match(msgs('many', 'pass'), /Opened 10 of 10 resources \(a sample of 10 of 200\)/);
  assert.equal(rc('many')!.status, 'pass');
});

test('hidden instructions in a resource description fail and cap the score; a leaked key in an error is caught', () => {
  assert.match(msgs('evil', 'fail', 'notes://evil'), /hidden <IMPORTANT> block/);
  assert.match(msgs('evil', 'fail', 'notes://locked'), /looks like an? .*key/i);
  assert.ok(reports.evil.score <= 40, `score ${reports.evil.score}`);
  assert.ok(reports.evil.scoreCaps?.some((c) => /resource or prompt descriptions/.test(c.reason)));
});

test('the faulty server loses points, the clean one does not', () => {
  assert.ok(reports.faulty.score < reports.clean.score, `${reports.faulty.score} vs ${reports.clean.score}`);
});
