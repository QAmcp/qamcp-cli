// The spec exam: for each case from the MCP specification, the verdict QAmcp must give.
// Best cases must pass with no complaint, worst cases must be caught with the right reason,
// weird-but-OK cases must not be blamed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runTest } from '../src/runTest.js';
import type { Report } from '../src/types.js';
import { startSpecServer, VARIANTS } from './specServer.js';

const PORT = 4840;
const base = `http://127.0.0.1:${PORT}`;
let srv: Awaited<ReturnType<typeof startSpecServer>>;
const R: Record<string, Report> = {};

before(async () => {
  srv = await startSpecServer(PORT);
  for (const v of [...Object.keys(VARIANTS), 'sse', 'redirect']) R[v] = await runTest(`${base}/${v}/mcp`, { timeoutMs: 6_000 });
});
after(() => {
  srv.closeAllConnections();
  srv.close();
});

const check = (v: string, id: string) => R[v].checks.find((c) => c.id === id);
const all = (v: string) => R[v].checks.flatMap((c) => c.findings.map((f) => ({ ...f, check: c.id })));
const about = (v: string, tool: string) => all(v).filter((f) => f.tool === tool);
const bad = (v: string) => all(v).filter((f) => f.status === 'fail' || f.status === 'warn');

// ---------- listing tools ----------
test('best: a tool list in 3 pages is read completely (8 tools)', () => {
  assert.equal(R.pages3.toolCount, 8);
  assert.equal(check('pages3', 'tools')!.status, 'pass');
});

test('worst: a server that hands back the same page forever is stopped, and named', () => {
  assert.ok(R.pageloop.toolCount < 50, `read ${R.pageloop.toolCount} tools`);
  assert.ok(all('pageloop').some((f) => f.status !== 'pass' && /same next page|never ends/i.test(f.message)), JSON.stringify(all('pageloop').map((f) => f.message)));
});

test('names: spaces, too long and duplicates are flagged; dots and capitals are fine', () => {
  const msgs = bad('names').filter((f) => f.check === 'tools').map((f) => f.message).join(' | ');
  assert.match(msgs, /get user/);
  assert.match(msgs, /x{20}/);
  assert.match(msgs, /get_dup/);
  assert.doesNotMatch(msgs, /admin\.tools\.list|DATA_EXPORT_v2/);
});

test('best: valid schemas (no inputs, draft-07, $ref, oneOf, icons, title) raise no complaint', () => {
  for (const t of ['get_time', 'get_old_style', 'get_with_refs', 'get_fancy', 'get_entities']) {
    const b = about('schemas', t).filter((f) => f.status === 'fail' || (f.status === 'warn' && f.check !== 'labels' && !/nearly the same description/.test(f.message)));
    assert.deepEqual(b, [], t);
  }
  assert.equal(check('schemas', 'respond')!.status, 'pass');
});

test('weird but OK: a tool that may only run as a background task is not run, and not blamed', () => {
  const f = about('tasks', 'get_report_job').filter((x) => !/nearly the same description/.test(x.message));
  assert.ok(f.every((x) => x.status !== 'fail' && x.status !== 'warn'), JSON.stringify(f));
  assert.ok(f.some((x) => /background task|task mode/i.test(x.message)), JSON.stringify(f));
});

// ---------- what tools send back ----------
test('best: images, audio, links, embedded resources and structured output all count as real answers', () => {
  for (const t of ['get_image', 'get_audio', 'get_link', 'get_embedded', 'get_structured', 'get_struct_only']) {
    const f = about('rich', t).filter((x) => x.check === 'respond');
    assert.equal(f[0]?.status, 'pass', `${t}: ${JSON.stringify(f)}`);
  }
});

test('worst: a tool that breaks its own promised output shape is caught', () => {
  assert.match(about('outputbad', 'get_missing_struct').map((f) => `${f.status} ${f.message}`).join(' | '), /fail.*(output|structured)/i);
  assert.match(about('outputbad', 'get_wrong_struct').map((f) => `${f.status} ${f.message}`).join(' | '), /fail.*(output|structured|temp)/i);
});

test('worst: content that breaks the rules is caught, not called empty or a crash', () => {
  for (const t of ['get_textless', 'get_unknown_type']) {
    const f = about('badcontent', t).filter((x) => x.check === 'respond');
    assert.equal(f[0]?.status, 'fail', `${t}: ${JSON.stringify(f)}`);
    assert.match(f[0].message, /breaks the MCP rules/, t);
  }
});

// ---------- hidden instructions ----------
test('weird but OK: emoji, Persian, Chinese and flags are not hidden characters', () => {
  assert.equal(check('unicode', 'hidden')!.status, 'pass', JSON.stringify(check('unicode', 'hidden')!.findings));
});

test('weird but OK: developer tools that mention .env or ~/.ssh, and the word "Important", are not tricks', () => {
  assert.equal(check('devtools', 'hidden')!.status, 'pass', JSON.stringify(check('devtools', 'hidden')!.findings));
});

test('worst: the real tricks are still caught', () => {
  for (const t of ['get_notes', 'get_mail', 'get_files']) assert.ok(about('tricks', t).some((f) => f.check === 'hidden' && f.status === 'fail'), t);
});

// ---------- servers that are not tool servers ----------
test('weird but OK: a resources-only server is not blamed for having no tools', () => {
  assert.ok(!all('resonly').some((f) => f.status === 'fail'), JSON.stringify(bad('resonly')));
  assert.equal(check('resonly', 'resources')?.status, 'pass');
});

test('worst: a server that says it has tools but cannot list them fails that check', () => {
  assert.equal(check('notools', 'tools')!.status, 'fail');
});

test('weird but OK: a server with the tools feature but zero tools right now is a warning, not a failure', () => {
  assert.notEqual(check('emptytools', 'tools')!.status, 'fail', JSON.stringify(check('emptytools', 'tools')));
});

// ---------- connection styles ----------
test('best: a server that keeps a session id works normally', () => {
  assert.equal(check('session', 'connect')!.status, 'pass');
  assert.equal(check('session', 'respond')!.status, 'pass');
});

test('weird but OK: an old SSE-only server connects, works, and gets a "switch transports" warning', () => {
  assert.equal(check('sse', 'connect')!.status, 'pass', JSON.stringify(check('sse', 'connect')));
  assert.equal(R.sse.protocol?.transport, 'sse');
  assert.match(check('sse', 'protocol')!.findings.map((f) => f.message).join(' '), /old SSE/);
  assert.equal(check('sse', 'respond')!.status, 'pass');
});

test('weird but OK: an address that redirects to the real server works', () => {
  assert.equal(check('redirect', 'connect')!.status, 'pass', JSON.stringify(check('redirect', 'connect')));
});

// ---------- round 2: real-world behaviour ----------

const STDIO = (mode: string) => ({ command: process.execPath, args: ['--import', 'tsx', 'test/stdioVariants.ts', mode] });
const r2: Record<string, Report> = {};
before(async () => {
  for (const v of ['streamed', 'huge', 'futureversion']) r2[v] = await runTest(`${base}/${v}/mcp`, { timeoutMs: 8_000 });
  for (const m of ['banner', 'crashcall', 'needsenv', 'noisy']) r2[m] = await runTest(`stdio:${m}`, { stdio: STDIO(m), timeoutMs: 20_000 });
});
const f2 = (v: string, id: string) => r2[v].checks.find((c) => c.id === id)!.findings;

test('best: an answer streamed with progress and log messages first works', () => {
  assert.equal(f2('streamed', 'respond')[0].status, 'pass');
});

test('a very large answer gets a warning that AI apps may cut it off', () => {
  assert.match(f2('huge', 'respond').map((f) => `${f.status} ${f.message}`).join(' '), /warn Answered with about \d+ KB/);
});

test('worst: a server answering with an MCP version no app supports is explained plainly', () => {
  assert.match(f2('futureversion', 'connect')[0].message, /answered with MCP version "2099-01-01", which AI apps don't support/);
});

test('worst: a program printing a welcome line where only MCP messages may go is caught', () => {
  assert.match(f2('banner', 'protocol').map((f) => f.message).join(' '), /prints text that isn't an MCP message.*Weather MCP server v1\.2 starting/);
});

test('best: a program that only logs to stderr (allowed) gets no such warning', () => {
  assert.doesNotMatch(f2('noisy', 'protocol').map((f) => f.message).join(' '), /isn't an MCP message/);
  assert.equal(f2('noisy', 'respond')[0].status, 'pass');
});

test('worst: a program that dies during a call is a crash, and later calls are "not tested", not blamed', () => {
  assert.match(f2('crashcall', 'respond')[0].message, /Crashed: the program stopped/);
  assert.ok(f2('crashcall', 'bad-input').every((f) => f.status === 'skip'), JSON.stringify(f2('crashcall', 'bad-input')));
});

test('worst: a program that quits at start shows its own reason', () => {
  assert.match(f2('needsenv', 'connect')[0].message, /The program stopped before it could connect\. Its last message: "Error: API_KEY environment variable is required/);
});

test('weird but OK: a local program showing paths on your own computer is not a leak (real filesystem-server case)', async () => {
  const r = await runTest('stdio:paths', { stdio: STDIO('paths'), timeoutMs: 20_000 });
  const leaks = r.checks.find((c) => c.id === 'leaks')!;
  assert.ok(!leaks.findings.some((f) => /shows internal details/.test(f.message)), JSON.stringify(leaks.findings));
});
