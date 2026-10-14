// How the score is calculated. Plain arithmetic, so it should be easy to check by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreOf } from '../src/score.js';
import type { CheckResult } from '../src/types.js';

const c = (id: string, status: CheckResult['status'], weight: number, fails: string[] = [], points?: number): CheckResult => ({
  id, title: id, status, summary: '', weight, points,
  findings: fails.length ? fails.map((message) => ({ status: 'fail' as const, message })) : [{ status, message: 'x' }],
});

test('pass = full points, warning = half, fail = none, skipped checks are left out', () => {
  assert.equal(scoreOf([c('a', 'pass', 10), c('b', 'warn', 10)]).score, 75);
  assert.equal(scoreOf([c('a', 'pass', 10), c('b', 'fail', 10)]).score, 50);
  assert.equal(scoreOf([c('a', 'pass', 10), c('b', 'skip', 10)]).score, 100);
});

test('serious problems cap the score, and the lowest cap wins', () => {
  const s = scoreOf([c('connect', 'pass', 100), c('hidden', 'fail', 1, ['Description contains hidden <IMPORTANT> block']), c('leaks', 'fail', 1, ['shows a private key'])]);
  assert.equal(s.beforeCaps, 98);
  assert.equal(s.score, 40);
  assert.deepEqual(s.caps.map((x) => x.max), [40, 50]);
});

test('a doubtful safety label is only worth a look, so it never caps the score', () => {
  assert.equal(scoreOf([c('connect', 'pass', 100), c('labels', 'warn', 1)]).caps.length, 0);
  const missing = c('labels', 'warn', 10);
  assert.equal(scoreOf([c('connect', 'pass', 90), missing]).caps.length, 0);
});
