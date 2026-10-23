// Everything CI needs: compare with a saved report, decide pass or fail, and write the
// outputs (JUnit XML for CI dashboards, markdown for pull-request comments).

import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import { topFixes } from './report.js';
import type { CheckResult, Report, Status } from './types.js';

// ---------- fingerprints: has anything about the tools changed? ----------

export function toolFingerprints(tools: Tool[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) out[t.name] = createHash('sha256').update(JSON.stringify([t.description ?? '', t.inputSchema])).digest('hex').slice(0, 12);
  return out;
}

// ---------- comparing with a baseline ----------

const RANK: Record<Status, number> = { pass: 0, warn: 1, fail: 2, skip: -1 };

export interface Comparison {
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
  worse: { id: string; title: string; from: Status; to: Status }[];
  better: { id: string; title: string; from: Status; to: Status }[];
  tools?: { added: string[]; removed: string[]; changed: string[]; unchanged: boolean };
}

export function compareReports(current: Report, baseline: Report): Comparison {
  const before = new Map(baseline.checks.map((c) => [c.id, c]));
  const worse: Comparison['worse'] = [];
  const better: Comparison['better'] = [];
  for (const c of current.checks) {
    const b = before.get(c.id);
    if (!b || c.status === 'skip' || b.status === 'skip') continue;
    const row = { id: c.id, title: c.title, from: b.status, to: c.status };
    if (RANK[c.status] > RANK[b.status]) worse.push(row);
    else if (RANK[c.status] < RANK[b.status]) better.push(row);
  }
  let tools: Comparison['tools'];
  if (current.toolFingerprints && baseline.toolFingerprints) {
    const a = baseline.toolFingerprints;
    const b = current.toolFingerprints;
    tools = {
      added: Object.keys(b).filter((n) => !(n in a)),
      removed: Object.keys(a).filter((n) => !(n in b)),
      changed: Object.keys(b).filter((n) => n in a && a[n] !== b[n]),
      unchanged: false,
    };
    tools.unchanged = !tools.added.length && !tools.removed.length && !tools.changed.length;
  }
  return { scoreBefore: baseline.score, scoreAfter: current.score, scoreDelta: current.score - baseline.score, worse, better, tools };
}

// ---------- the pass / fail decision ----------

export interface GateOptions {
  failUnder?: number;
  failOnFail?: boolean;
  maxDrop?: number; // used only when there is a comparison
}

export interface GateResult {
  exitCode: 0 | 1 | 3;
  reasons: string[]; // plain words, one per reason the gate failed
}

export function evaluateGates(report: Report, gates: GateOptions, cmp?: Comparison): GateResult {
  if (report.notScored) return { exitCode: 3, reasons: [`could not test: this server ${report.notScored}`] };
  if (report.checks[0]?.id === 'connect' && report.checks[0].status === 'fail') return { exitCode: 3, reasons: [`could not test: ${report.checks[0].findings[0]?.message ?? 'could not connect'}`] };

  const reasons: string[] = [];
  if (gates.failUnder !== undefined && report.score < gates.failUnder) reasons.push(`score ${report.score} is below the required ${gates.failUnder}`);
  if (gates.failOnFail) {
    const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.title);
    if (failed.length) reasons.push(`failed: ${failed.join('; ')}`);
  }
  if (cmp) {
    const maxDrop = gates.maxDrop ?? 5;
    if (cmp.scoreDelta < -maxDrop) reasons.push(`score fell from ${cmp.scoreBefore} to ${cmp.scoreAfter} (more than ${maxDrop} points)`);
    for (const w of cmp.worse) if (w.to === 'fail') reasons.push(`"${w.title}" got worse: ${w.from} → fail`);
    if (cmp.tools?.removed.length) reasons.push(`tools were removed, which breaks AI apps that use them: ${cmp.tools.removed.join(', ')}`);
  }
  return { exitCode: reasons.length ? 1 : 0, reasons };
}

// ---------- JUnit XML ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function toJUnit(report: Report): string {
  const cases = report.checks.map((c) => {
    const body = c.findings.map((f) => `${f.status.toUpperCase()}: ${f.tool && !f.message.includes(f.tool) ? f.tool + ': ' : ''}${f.message}`).join('\n');
    const name = esc(c.title);
    if (c.status === 'fail') return `    <testcase classname="qamcp" name="${name}">\n      <failure message="${esc(c.summary)}">${esc(body)}</failure>\n    </testcase>`;
    if (c.status === 'skip') return `    <testcase classname="qamcp" name="${name}">\n      <skipped message="${esc(c.findings[0]?.message ?? 'not tested')}"/>\n    </testcase>`;
    return `    <testcase classname="qamcp" name="${name}">${c.status === 'warn' ? `\n      <system-out>${esc(body)}</system-out>\n    ` : ''}</testcase>`;
  });
  const failures = report.checks.filter((c) => c.status === 'fail').length;
  const skipped = report.checks.filter((c) => c.status === 'skip').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${esc('QAmcp: ' + report.url)}" tests="${report.checks.length}" failures="${failures}" skipped="${skipped}" timestamp="${esc(report.testedAt)}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

// ---------- markdown for pull-request comments ----------

const ICON: Record<Status, string> = { pass: '✅', warn: '⚠️', fail: '❌', skip: '➖' };

export function toMarkdown(report: Report, cmp?: Comparison, gate?: GateResult): string {
  const L: string[] = [];
  const verdict = gate ? (gate.exitCode === 0 ? '✅ passed' : gate.exitCode === 1 ? '❌ failed' : '➖ could not test') : '';
  L.push(`## QAmcp: ${report.notScored ? 'not scored' : `${report.score}/100`} ${verdict}`.trim());
  L.push('');
  L.push(`\`${report.url}\` · tested ${report.coverage.checksRun} of ${report.coverage.checksTotal} checks · ran ${report.coverage.toolsRun} of ${report.coverage.toolsTotal} tools`);
  if (report.scoreCaps?.length && report.scoreBeforeCaps !== undefined && report.scoreBeforeCaps > report.score) {
    const cap = [...report.scoreCaps].sort((a, b) => a.max - b.max)[0];
    L.push('');
    L.push(`> Would be ${report.scoreBeforeCaps}, capped at ${cap.max} because ${cap.reason}.`);
  }
  if (gate?.reasons.length) {
    L.push('');
    L.push('**Why it failed**');
    for (const r of gate.reasons) L.push(`- ${r}`);
  }
  if (cmp) {
    L.push('');
    const d = cmp.scoreDelta;
    L.push(`**Compared with the baseline:** ${cmp.scoreBefore} → ${cmp.scoreAfter} (${d > 0 ? '+' : ''}${d})`);
    for (const w of cmp.worse) L.push(`- ⬇️ ${w.title}: ${w.from} → ${w.to}`);
    for (const b of cmp.better) L.push(`- ⬆️ ${b.title}: ${b.from} → ${b.to}`);
    if (cmp.tools && !cmp.tools.unchanged) {
      L.push(`- Tools changed: ${[cmp.tools.added.length && `added ${cmp.tools.added.join(', ')}`, cmp.tools.removed.length && `removed ${cmp.tools.removed.join(', ')}`, cmp.tools.changed.length && `changed ${cmp.tools.changed.join(', ')}`].filter(Boolean).join(' · ')}`);
    } else if (cmp.tools) L.push('- Tools unchanged since the baseline.');
  }
  L.push('');
  L.push('| | Check | Result |');
  L.push('|---|---|---|');
  for (const c of report.checks) L.push(`| ${ICON[c.status]} | ${c.title} | ${c.summary.replace(/\|/g, '/')} |`);
  const fixes = topFixes(report, 3);
  if (fixes.length) {
    L.push('');
    L.push('**Fix these first**');
    fixes.forEach((f, i) => L.push(`${i + 1}. ${f.tool && !f.message.includes(f.tool) ? `\`${f.tool}\`: ` : ''}${f.message}`));
  }
  const changed = report.toolChanges?.changes ?? [];
  if (changed.length) {
    L.push('');
    L.push(`**Tools changed since ${report.toolChanges!.since}**`);
    for (const c of changed) L.push(`- ${c.important ? '⚠️' : '·'} \`${c.tool}\`: ${c.what.join('; ')}`);
    L.push('');
    L.push('```diff');
    for (const c of changed) L.push(`@@ ${c.tool} @@`, ...c.diff.split('\n').slice(0, 20));
    L.push('```');
  }
  if (report.dataFlow) {
    L.push('');
    L.push(`<sub>${report.dataFlow.summary}</sub>`);
  }
  return L.join('\n').slice(0, 60_000) + '\n';
}

export function failedChecks(report: Report): CheckResult[] {
  return report.checks.filter((c) => c.status === 'fail');
}

// One fingerprint for the whole toolbox: changes when any tool's name, description or inputs change.
export function toolboxHash(tools: Tool[]): string {
  const view = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.description ?? '', t.inputSchema]);
  return createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 16);
}
