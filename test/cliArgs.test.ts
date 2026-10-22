// Command-line options: every flag, and every way to get it wrong. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, shellSplit, UsageError } from '../src/cliArgs.js';

const bad = (argv: string[], pattern: RegExp) => assert.throws(() => parseArgs(argv), (e: any) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

test('a plain link with defaults', () => {
  const a = parseArgs(['https://mcp.example.com/mcp']);
  assert.equal(a.url, 'https://mcp.example.com/mcp');
  assert.equal(a.maxDrop, 5);
  assert.equal(a.failUnder, undefined);
});

test('every flag is read', () => {
  const a = parseArgs([
    'https://x.io/mcp', '--header', 'Authorization: Bearer a:b', '--header', 'X-Key: 1', '--timeout', '30', '--owner', '--login',
    '--fail-under', '80', '--fail-on-fail', '--baseline', 'b.json', '--max-drop', '3',
    '--save-baseline', 'o.json', '--junit', 'j.xml', '--markdown', 'm.md', '--json', 'r.json',
  ]);
  assert.deepEqual(a.headers, { Authorization: 'Bearer a:b', 'X-Key': '1' }); // a colon inside the value is kept
  assert.equal(a.timeoutMs, 30_000);
  assert.equal(a.safety, 'owner');
  assert.equal(a.failUnder, 80);
  assert.equal(a.maxDrop, 3);
  assert.equal(a.junit, 'j.xml');
  assert.equal(a.login, true);
  assert.equal(a.failOnFail, true);
  assert.equal(a.saveBaseline, 'o.json');
});

test('--stdio splits the command like a shell would, with quotes', () => {
  const a = parseArgs(['--stdio', `npx -y @acme/server --name "two words" --x='a b'`, '--env', 'TOKEN=abc=def', '--cwd', 'C:\\work']);
  assert.deepEqual(a.stdio, { command: 'npx', args: ['-y', '@acme/server', '--name', 'two words', '--x=a b'], env: { TOKEN: 'abc=def' }, cwd: 'C:\\work' });
  assert.equal(a.url, undefined);
});

test('shellSplit edge cases', () => {
  assert.deepEqual(shellSplit('  a   b  '), ['a', 'b']);
  assert.deepEqual(shellSplit('a "" b'), ['a', '', 'b']);
  assert.deepEqual(shellSplit('node "C:\\Program Files\\x.js"'), ['node', 'C:\\Program Files\\x.js']);
  assert.throws(() => shellSplit('a "b'), UsageError);
});

test('wrong options give plain messages', () => {
  bad([], /Give a server link/);
  bad(['https://x.io', '--bogus'], /Unknown option --bogus/);
  bad(['https://x.io', '--fail-under'], /--fail-under needs a value/);
  bad(['https://x.io', '--fail-under', 'high'], /needs a number/);
  bad(['https://x.io', '--header', 'nocolon'], /Name: value/);
  bad(['https://x.io', 'https://y.io'], /Only one server link/);
  bad(['ftp://x.io'], /not a valid http or https link/);
  bad(['not a link'], /not a valid http or https link/);
  bad(['https://x.io', '--stdio', 'npx x'], /either a server link or --stdio/);
  bad(['--stdio', ''], /needs a command|needs a value/);
  bad(['--stdio', 'npx x', '--login'], /--login is for servers on the internet/);
  bad(['https://x.io', '--env', 'A=1'], /--env and --cwd are for --stdio/);
  bad(['https://x.io', '--env', 'NOEQUALS'], /--env needs NAME=value/ as any);
  bad(['https://x.io', '--no-ai'], /Unknown option --no-ai/); // this version has no AI options at all
});

test('--help is accepted on its own', () => {
  assert.equal(parseArgs(['--help']).help, true);
});

test('--look-only sets the no-calls safety mode', () => {
  assert.equal(parseArgs(['https://x.io/mcp', '--look-only']).safety, 'none');
});

test('--install-hook is accepted on its own', () => {
  assert.equal(parseArgs(['--install-hook']).installHook, true);
  bad(['https://x.io', '--install-hook'], /--install-hook sets up a git pre-commit hook/);
});
