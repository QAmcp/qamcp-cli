// The real command, run as a separate program, exactly as someone's CI would run it:
// exit codes, the CI gates, JUnit and markdown files, baselines, and the GitHub summary.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const PORT = 4730;
const STDIO = `"${process.execPath}" --import tsx test/stdioServer.ts`;
const dir = mkdtempSync(join(tmpdir(), 'qamcp-cli-'));
let leaky: ChildProcess;

// The pretend server runs as its own program: the tests below wait on other programs, which
// would freeze a server living in the same process.
before(async () => {
  leaky = spawn(process.execPath, ['--import', 'tsx', 'test/leakyServer.ts', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the pretend server did not start')), 30_000);
    leaky.stdout!.on('data', (d) => {
      if (String(d).includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    leaky.on('exit', () => reject(new Error('the pretend server exited')));
  });
});
after(() => {
  leaky.kill();
});

// Runs the real command as a separate program.
function qamcp(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const stdio = ['--stdio', STDIO, '--timeout', '30'];
const leakyUrl = [`http://127.0.0.1:${PORT}/mcp`, '--timeout', '10'];

test('exit 2 for wrong options, with a plain message', () => {
  const r = qamcp([]);
  assert.equal(r.code, 2);
  assert.match(r.out, /Give a server link, or --stdio/);
  assert.match(r.out, /Run with --help/);
  assert.equal(qamcp(['https://x.io', '--fail-under', 'high']).code, 2);
});

test('--help prints every option and the exit codes, exit 0', () => {
  const r = qamcp(['--help']);
  assert.equal(r.code, 0);
  for (const word of ['--stdio', '--fail-under', '--baseline', '--junit', '--login', '--owner', 'Exit codes']) assert.ok(r.out.includes(word), word);
});

test('exit 3 when the server cannot be reached', () => {
  const r = qamcp(['http://127.0.0.1:1/mcp', '--timeout', '3']);
  assert.equal(r.code, 3);
  assert.match(r.out, /COULD NOT TEST/);
});

test('no gates: a healthy run exits 0 and a problem on its own does not fail the command', () => {
  assert.equal(qamcp(stdio).code, 0);
  assert.equal(qamcp(leakyUrl).code, 0);
});

test('--fail-under: below the line exits 1 and says why; at or above exits 0', () => {
  const low = qamcp([...stdio, '--fail-under', '100']);
  assert.equal(low.code, 1);
  assert.match(low.out, /CI gate: FAILED/);
  assert.match(low.out, /below the required 100/);
  const ok = qamcp([...stdio, '--fail-under', '80']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /CI gate: PASSED/);
});

test('--fail-on-fail: a leaked key fails the build, naming the check', () => {
  const r = qamcp([...leakyUrl, '--fail-on-fail']);
  assert.equal(r.code, 1);
  assert.match(r.out, /failed: .*No secrets leaked/);
  assert.match(r.out, /API key/);
});

test('files: JSON, JUnit, markdown, baseline, and the GitHub summary', () => {
  const summary = join(dir, 'summary.md');
  const r = qamcp(
    [...leakyUrl, '--json', join(dir, 'r.json'), '--junit', join(dir, 'r.xml'), '--markdown', join(dir, 'r.md'), '--html', join(dir, 'r.html'), '--save-baseline', join(dir, 'nested', 'base.json')],
    { GITHUB_STEP_SUMMARY: summary },
  );
  assert.equal(r.code, 0);
  for (const f of ['r.json', 'r.xml', 'r.md', 'r.html', join('nested', 'base.json'), 'summary.md']) assert.ok(existsSync(join(dir, f)), f);
  // the report page: the real result, fonts built in, nothing fetched
  const html = readFileSync(join(dir, 'r.html'), 'utf8');
  assert.match(html, /Test certificate: leaky-test-server/);
  assert.match(html, /class="stamp fail">FAIL</);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /<script|<link\b/);

  const json = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert.equal(json.server.name, 'leaky-test-server');
  assert.ok(json.toolboxHash && json.toolFingerprints.get_item);
  assert.match(json.dataFlow.summary, /nothing was sent anywhere/);

  const xml = readFileSync(join(dir, 'r.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<failure message="1 failed">/);
  assert.match(xml, /<testsuite name="QAmcp: http:\/\/127.0.0.1:4730\/mcp"/);

  assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /^## QAmcp: \d+\/100/);
  assert.equal(readFileSync(join(dir, 'summary.md'), 'utf8'), readFileSync(join(dir, 'r.md'), 'utf8') + '\n');
});

test('baseline: the same server again passes, and says the tools are unchanged', () => {
  const base = join(dir, 'same.json');
  assert.equal(qamcp([...leakyUrl, '--save-baseline', base]).code, 0);
  const r = qamcp([...leakyUrl, '--baseline', base, '--markdown', join(dir, 'same.md')]);
  assert.equal(r.code, 0);
  // Same tools; the score may move a point or two with speed (a busy computer), never more.
  const delta = Number(r.out.match(/Compared with the baseline: \d+ → \d+ \(([+-]?\d+)\)/)?.[1]);
  assert.ok(Math.abs(delta) <= 5, `score moved by ${delta}`);
  assert.match(r.out, /CI gate: PASSED/);
  assert.match(readFileSync(join(dir, 'same.md'), 'utf8'), /Tools unchanged since the baseline/);
});

test('baseline: a healthy baseline versus a server that now leaks and lost its tools fails the build', () => {
  const base = join(dir, 'healthy.json');
  assert.equal(qamcp([...stdio, '--save-baseline', base]).code, 0);
  const r = qamcp([...leakyUrl, '--baseline', base]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CI gate: FAILED/);
  assert.match(r.out, /"No secrets leaked" got worse: pass → fail/);
  assert.match(r.out, /tools were removed.*get_note.*search_notes|tools were removed.*search_notes.*get_note/);
});

test('baseline: a baseline file that does not exist yet is fine (the first CI run)', () => {
  const r = qamcp([...stdio, '--baseline', join(dir, 'not-yet.json'), '--fail-under', '50']);
  assert.equal(r.code, 0);
  assert.match(r.out, /No baseline at .* yet/);
});

test('baseline: a file that is not a QAmcp report is refused with exit 2', () => {
  const junk = join(dir, 'junk.json');
  writeFileSync(junk, JSON.stringify({ hello: 'world' }));
  const r = qamcp([...stdio, '--baseline', junk]);
  assert.equal(r.code, 2);
  assert.match(r.out, /is not a QAmcp report/);
});

test('says plainly that nothing is sent anywhere else, and never asks for a key', () => {
  const r = qamcp(['--stdio', STDIO, '--timeout', '30']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing was sent anywhere except to the server being tested/);
  assert.doesNotMatch(r.out, /AI key|GROQ|OPENAI/i);
});


test('--demo: one command, no server needed, writes the report page', () => {
  const page = join(dir, 'demo.html');
  const r = qamcp(['--demo', '--html', page]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Demo: testing an MCP server we broke on purpose/);
  assert.match(r.out, /hidden <IMPORTANT> block/);
  assert.ok(existsSync(page));
  assert.equal(qamcp(['--demo', 'https://x.io/mcp']).code, 2);
});
