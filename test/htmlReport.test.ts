// The report page: safe against hostile servers, fully offline, and honest in every state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toHtml } from '../src/htmlReport.js';
import type { Report } from '../src/types.js';

const check = (id: string, title: string, status: string, findings: any[]) => ({ id, title, status, summary: '', weight: 10, findings });
const report = (checks: any[], extra: Partial<Report> = {}): Report =>
  ({ url: 'https://mcp.example.com/mcp', testedAt: '2026-10-14T20:00:00Z', score: 72, toolCount: 3, coverage: { checksRun: 3, checksTotal: 10, toolsRun: 2, toolsTotal: 3 }, skippedTools: [], checks, calls: [], server: { name: 'example', version: '1.0' }, protocol: { version: '2025-11-25', transport: 'streamable-http' }, ...extra }) as Report;

test('a hostile server cannot inject anything into the page: every server string is escaped', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = toHtml(
    report([check('hidden', 'No hidden instructions', 'fail', [{ status: 'fail', tool: `bad"tool${evil}`, message: `Description contains ${evil}` }])], {
      server: { name: `srv${evil}`, version: evil },
      skippedTools: [{ tool: evil, why: evil }],
      url: `https://x.example/mcp?q=${evil}`,
    }),
  );
  // No real tag survives: the words may appear, but only as escaped, inert text.
  assert.doesNotMatch(html, /<script|<img\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
  // a quote in a tool name can't break out of an attribute either
  assert.doesNotMatch(html, /bad"tool/);
});

test('fully offline: no scripts, no stylesheets or fonts fetched, fonts built in', () => {
  const html = toHtml(report([check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'Connected in 80 ms' }])]));
  assert.doesNotMatch(html, /<script|<link\b|@import|src="https?:|url\(https?:/i);
  assert.match(html, /data:font\/woff2;base64,/);
  // the only web addresses are plain links a reader may choose to click
  for (const m of html.matchAll(/https?:\/\/[^"'\s<)]+/g)) assert.ok(/github\.com\/QAmcp\/qamcp-cli|mcp\.example\.com/.test(m[0]), m[0]);
});

test('a failing server: FAIL stamp, failures listed apart from advisories, numbered test items', () => {
  const html = toHtml(
    report([
      check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'Connected in 80 ms' }]),
      check('protocol', 'Ready for the newest MCP version', 'warn', [{ status: 'warn', message: 'Uses an older MCP version (2025-11-25)' }]),
      check('leaks', 'No secrets leaked', 'fail', [{ status: 'fail', tool: 'search', message: 'Error message shows what looks like a password' }]),
      check('speed', 'Fast enough', 'warn', [{ status: 'warn', tool: 'search', message: 'Slowest tool: search (3.0 s)' }]),
    ]),
  );
  assert.match(html, /class="stamp fail">FAIL</);
  const failures = html.slice(html.indexOf('Failures: fix these first'), html.indexOf('Notes: worth fixing'));
  assert.match(failures, /looks like a password/);
  assert.doesNotMatch(failures, /Slowest tool/);
  // the version advisory, true but the least useful, comes after the others
  const adv = html.slice(html.indexOf('Notes: worth fixing'), html.indexOf('All test items'));
  assert.ok(adv.indexOf('Slowest tool') < adv.indexOf('older MCP version'));
  assert.match(html, /T-3\.1/);
  assert.match(html, /<span class="num">3\.0 s<\/span>/); // measurements in lined-up digits with their unit
});

test('a perfect server: PASS, and "nothing failed" rather than an empty column', () => {
  const html = toHtml(report([check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'Connected in 80 ms' }])], { score: 100 }));
  assert.match(html, /class="stamp pass">PASS</);
  assert.match(html, /Nothing failed\./);
});

test('a login wall: NOT SCORED, no score shown, and the login is not listed as a failure to fix', () => {
  const html = toHtml(report([check('connect', 'Connects', 'fail', [{ status: 'fail', message: 'The server needs a login key. Add it and test again.' }])], { notScored: 'needs a login', score: 0 }));
  assert.match(html, /class="stamp skip">NOT SCORED</);
  assert.doesNotMatch(html, /class="n">0</);
  const failures = html.slice(html.indexOf('Failures: fix these first'), html.indexOf('Notes: worth fixing'));
  assert.doesNotMatch(failures, /login key/);
  assert.match(html, /A login wall is not a fault/);
  // reaching a login is not a failed connection, and every check behind it is listed as not tested
  assert.doesNotMatch(html, /class="st">FAIL</);
  assert.doesNotMatch(html, /Could not connect/);
  assert.match(html, /Tools work with good inputs<\/span><span class="lead">Behind the login/);
  assert.equal(html.match(/class="st">NEEDS LOGIN</g)?.length, 11); // Connects + the 10 checks behind the login
  assert.match(html, /npx qamcp-cli https:\/\/mcp\.example\.com\/mcp --login --html report\.html/);
});

test('noindex only when asked: a page shared by link stays out of search engines', () => {
  const r = report([check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'ok' }])]);
  assert.doesNotMatch(toHtml(r), /noindex/);
  assert.match(toHtml(r, { noindex: true }), /<meta name="robots" content="noindex, nofollow">/);
});

test('a login wall shows what passed from outside and what is behind the login, never empty columns', () => {
  const oauth = check('oauth', 'Login setup follows the spec', 'pass', [{ status: 'pass', message: 'PKCE with S256 is supported.' }, { status: 'pass', message: 'AI apps can register themselves.' }]);
  const html = toHtml(report([check('connect', 'Connects', 'fail', [{ status: 'fail', message: 'needs a login' }]), oauth], { notScored: 'needs a login', score: 0 }));
  assert.match(html, /Login setup: passed all 2 checks/);
  assert.match(html, /Checked from outside <span class="count">2<\/span>/);
  assert.match(html, /Behind the login: not tested yet <span class="count">10<\/span>/);
  assert.doesNotMatch(html, /Failures: fix these first|Nothing failed\./);
});

test('a normal report has no login box and no NEEDS LOGIN rows', () => {
  const html = toHtml(report([check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'Connected in 80 ms' }])]));
  assert.doesNotMatch(html, /NEEDS LOGIN|Test everything behind the login/);
  // a fully tested server keeps the normal layout
  assert.match(html, /Failures: fix these first/);
  assert.doesNotMatch(html, /Checked from outside/);
});

test('every result has a drawn mark and a word, so colour is never the only signal', () => {
  const html = toHtml(report([check('connect', 'Connects', 'pass', [{ status: 'pass', message: 'ok' }]), check('leaks', 'No secrets leaked', 'skip', [{ status: 'skip', message: 'No error messages to check' }])]));
  assert.match(html, /aria-label="Passed"/);
  assert.match(html, /aria-label="Not tested"/);
  assert.match(html, /NOT TESTED/);
});

test('a capped score explains its ceiling', () => {
  const html = toHtml(report([check('hidden', 'No hidden instructions', 'fail', [{ status: 'fail', message: 'x' }])], { score: 40, scoreBeforeCaps: 85, scoreCaps: [{ max: 40, reason: 'hidden instructions in tool descriptions' }] }));
  assert.match(html, /Would be <span class="num">85<\/span>, but capped at <span class="num">40<\/span> because hidden instructions/);
});

test('a score from only some of the checks is marked partial; a full one is not', () => {
  assert.match(toHtml(report([])), /Partial score: 3 of 10 checks/);
  assert.doesNotMatch(toHtml(report([], { coverage: { checksRun: 10, checksTotal: 10, toolsRun: 3, toolsTotal: 3 } })), /Partial score/);
});

test('the terminal score line says partial when not every check could run', async () => {
  const { formatReport } = await import('../src/report.js');
  assert.match(formatReport(report([], { score: 100, coverage: { checksRun: 7, checksTotal: 10, toolsRun: 0, toolsTotal: 1 } })), /SCORE: 100\/100 · partial: 7 of 10 checks, 0 of 1 tools ran/);
  assert.match(formatReport(report([], { score: 100, coverage: { checksRun: 10, checksTotal: 10, toolsRun: 1, toolsTotal: 1 } })), /SCORE: 100\/100\n/);
});
