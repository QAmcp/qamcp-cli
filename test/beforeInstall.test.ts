// --before-install: a plain-words safety look for someone about to add a server to their AI app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beforeInstall, formatBeforeInstall } from '../src/beforeInstall.js';
import { parseArgs } from '../src/cliArgs.js';
import type { CheckResult, Report } from '../src/types.js';

const check = (id: string, status: CheckResult['status'], findings: CheckResult['findings'] = []): CheckResult => ({ id, status, title: id, summary: '', weight: 10, findings });
const report = (over: Partial<Report>): Report => ({
  url: 'https://x.ai/mcp', testedAt: '', score: 90, toolCount: 0, skippedTools: [], calls: [],
  coverage: { checksRun: 1, checksTotal: 1, toolsRun: 0, toolsTotal: 0 }, checks: [check('connect', 'pass'), check('hidden', 'pass')], toolDefs: [], ...over,
});

test('before install: hidden instructions are a red flag', () => {
  const v = beforeInstall(report({ checks: [check('connect', 'pass'), check('hidden', 'fail', [{ status: 'fail', tool: 'notes', message: 'hidden <IMPORTANT> block' }])], toolDefs: [{ name: 'notes', annotations: { readOnlyHint: true } }] }));
  assert.equal(v.level, 'red');
  assert.match(v.headline, /don't install/);
  assert.match(v.points[0], /Hidden instructions .*\(notes\)/);
});

test('before install: tools that delete, change or don\'t say are named; read-only ones counted', () => {
  const v = beforeInstall(report({ toolDefs: [
    { name: 'delete_account' },
    { name: 'send_email', description: 'Sends an email.' },
    { name: 'mystery' },
    { name: 'get_weather', annotations: { readOnlyHint: true } },
  ] }));
  assert.equal(v.level, 'careful');
  const text = v.points.join('\n');
  assert.match(text, /1 tool can delete things: delete_account/);
  assert.match(text, /1 tool can change or send things: send_email/);
  assert.match(text, /1 tool doesn't say whether it changes anything: mystery/);
  assert.match(text, /1 tool only reads/);
  assert.match(text, /should ask you before/);
});

test('before install: all read-only is "no red flags"; a login wall is said plainly', () => {
  assert.equal(beforeInstall(report({ toolDefs: [{ name: 'get_x', annotations: { readOnlyHint: true } }] })).level, 'ok');
  const login = beforeInstall(report({ notScored: 'needs a login', toolDefs: undefined }));
  assert.equal(login.level, 'unknown');
  assert.match(login.points[0], /--login/);
  assert.match(formatBeforeInstall(report({}), beforeInstall(report({}))), /called none of its tools/);
});

test('before install: the option calls no tools and can\'t be mixed with running more tools', () => {
  assert.equal(parseArgs(['https://x.ai/mcp', '--before-install']).safety, 'none');
  assert.throws(() => parseArgs(['https://x.ai/mcp', '--before-install', '--owner']), /calls no tools/);
});
