import type { CheckResult } from './types.js';

// How the score works, in plain arithmetic:
//
// 1. Each check is worth points (its weight). Pass = all of them, warning = half, fail = none.
//    Checks we could not run don't count either way.
// 2. A check measured as a percentage earns that share of its points.
// 3. Serious problems put a ceiling on the score, the way SSL Labs caps a grade: a server
//    that leaks secrets can't score well no matter how good everything else is.

const POINTS = { pass: 1, warn: 0.5, fail: 0 } as const;

export interface ScoreCap {
  max: number;
  reason: string;
}

export interface Score {
  score: number;
  beforeCaps: number;
  caps: ScoreCap[]; // every ceiling that applied; the lowest one wins
}

export function scoreOf(checks: CheckResult[]): Score {
  const counted = checks.filter((c) => c.status !== 'skip');
  const possible = counted.reduce((s, c) => s + c.weight, 0);
  if (!possible) return { score: 0, beforeCaps: 0, caps: [] };
  const earned = counted.reduce((s, c) => s + c.weight * (c.points ?? POINTS[c.status as keyof typeof POINTS]), 0);
  const beforeCaps = Math.round((earned / possible) * 100);

  const caps = capsFor(checks);
  const score = Math.min(beforeCaps, ...caps.map((c) => c.max));
  return { score, beforeCaps, caps };
}

function capsFor(checks: CheckResult[]): ScoreCap[] {
  const failed = (id: string, match?: RegExp) =>
    checks.some((c) => c.id === id && c.findings.some((f) => f.status === 'fail' && (!match || match.test(f.message))));
  const caps: ScoreCap[] = [];
  if (failed('tools', /^Breaks the tool list/)) caps.push({ max: 50, reason: 'a broken tool definition may stop AI apps from loading the server at all' });
  if (failed('hidden')) caps.push({ max: 40, reason: 'hidden instructions in tool descriptions' });
  if (failed('resources', /known trick/)) caps.push({ max: 40, reason: 'hidden instructions in resource or prompt descriptions' });
  if (failed('resources', /Error message shows what looks like/)) caps.push({ max: 50, reason: 'secrets leak in error messages' });
  if (failed('leaks')) caps.push({ max: 50, reason: 'secrets leak in error messages' });
  if (failed('respond', /^(No answer|Crashed)/) || failed('bad-input', /^(Hung|Crashed)/)) caps.push({ max: 70, reason: 'a tool crashes or hangs' });
  if (failed('respond', /claims success but returns no data/)) caps.push({ max: 70, reason: 'a tool claims success but returns nothing' });
  return caps;
}
