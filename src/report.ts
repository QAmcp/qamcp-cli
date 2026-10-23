import type { Finding, Report, Status } from './types.js';

const ICON: Record<Status, string> = { pass: '✅', warn: '⚠️ ', fail: '❌', skip: '➖' };

// Plain-text report for the terminal.
export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`QAmcp report for ${r.url}`);
  if (r.server?.name) lines.push(`Server: ${r.server.name}${r.server.version ? ' v' + r.server.version : ''}`);
  if (r.protocol) lines.push(`MCP version: ${r.protocol.version ?? 'unknown'} (${r.protocol.transport})`);
  lines.push('');
  const retry = r.notScored === 'needs a login' ? 'Test again with --login (or add a key with --header).' : 'Try again in a minute.';
  const partial = !r.notScored && r.coverage.checksRun < r.coverage.checksTotal;
  lines.push(r.notScored ? `NOT SCORED: this server ${r.notScored}. ${retry}` : `SCORE: ${r.score}/100${partial ? ` · partial: ${r.coverage.checksRun} of ${r.coverage.checksTotal} checks, ${r.coverage.toolsRun} of ${r.coverage.toolsTotal} tools ran` : ''}`);
  const cap = r.scoreCaps?.length ? [...r.scoreCaps].sort((a, b) => a.max - b.max)[0] : undefined;
  if (cap && r.scoreBeforeCaps !== undefined && r.scoreBeforeCaps > r.score) lines.push(`(Would be ${r.scoreBeforeCaps}, but capped at ${cap.max} because ${cap.reason}.)`);
  const { checksRun, checksTotal, toolsRun, toolsTotal } = r.coverage;
  lines.push(`Tested ${checksRun} of ${checksTotal} checks · ran ${toolsRun} of ${toolsTotal} tools`);
  if (checksRun < checksTotal) lines.push(`(The score only counts what we could test.)`);
  if (r.dataFlow) lines.push(r.dataFlow.summary);
  const byName = [...new Set(r.calls.filter((c) => c.why === 'name says read-only').map((c) => c.tool))];
  const signIn = [...new Set(r.calls.filter((c) => c.outcome === 'needs-login').map((c) => c.tool))].filter((t) => !r.calls.some((c) => c.tool === t && c.outcome !== 'needs-login'));
  if (signIn.length) lines.push(`${signIn.length} tool${signIn.length === 1 ? '' : 's'} asked us to sign in first, so ${signIn.length === 1 ? 'it was' : 'they were'} not tested: ${signIn.join(', ')}. Test again with --login or --header to include ${signIn.length === 1 ? 'it' : 'them'}.`);
  if (byName.length) lines.push(`Ran ${byName.length} unlabeled tool${byName.length === 1 ? '' : 's'} because the name says it only reads: ${byName.join(', ')}`);
  const unlabeled = r.skippedTools.filter((s) => s.why.startsWith('no safety label'));
  const capped = r.skippedTools.filter((s) => s.why.startsWith('we test at most'));
  const lookOnly = r.skippedTools.filter((s) => s.why.startsWith('look-only'));
  if (lookOnly.length) lines.push(`Look-only mode: called none of the ${lookOnly.length} tools. Tools, bad inputs and leaks were not tested.`);
  const risky = r.skippedTools.filter((s) => !s.why.startsWith('no safety label') && !s.why.startsWith('we test at most') && !s.why.startsWith('look-only'));
  if (capped.length) lines.push(`Did not run ${capped.length} more safe tool${capped.length === 1 ? '' : 's'} (${capped[0].why}): ${capped.map((s) => s.tool).join(', ')}`);
  if (unlabeled.length) {
    lines.push(`Did not run ${unlabeled.length} tool${unlabeled.length === 1 ? '' : 's'} with no safety label (MCP rules say to treat these as possibly dangerous): ${unlabeled.map((s) => s.tool).join(', ')}`);
    lines.push(`  Own this server? Test again with --owner to run the ones whose names clearly only read.`);
  }
  if (risky.length) lines.push(`Did not run ${risky.length} tool${risky.length === 1 ? '' : 's'} that might change data: ${risky.map((s) => s.tool).join(', ')}`);
  lines.push('');

  for (const c of r.checks) {
    lines.push(`${ICON[c.status]} ${c.title} — ${c.summary}`);
    // Keep long lists of passes short, but never hide a warning or failure.
    // Summary lines (no tool) always show; per-tool passes fold away when there are many.
    const toolPasses = c.findings.filter((f) => f.status === 'pass' && f.tool);
    const collapse = toolPasses.length > 3;
    // With problems in the same check, say how many passed out of how many, so "all passed" never sits next to a failure.
    const toolResults = c.findings.filter((f) => f.tool && f.status !== 'skip').length;
    if (collapse) lines.push(`     ${ICON.pass} ${toolPasses.length === toolResults ? `All ${toolResults} passed` : `${toolPasses.length} of ${toolResults} passed (the problems are listed below)`}`);
    // The same "not tested" reason for many tools becomes one line (the tools are named at the top).
    const skipGroups = new Map<string, number>();
    for (const f of c.findings) if (f.status === 'skip' && f.tool) skipGroups.set(f.message, (skipGroups.get(f.message) ?? 0) + 1);
    const shownGroups = new Set<string>();
    for (const f of c.findings) {
      if (collapse && f.status === 'pass' && f.tool) continue;
      if (f.status === 'skip' && f.tool && (skipGroups.get(f.message) ?? 0) > 3) {
        if (!shownGroups.has(f.message)) lines.push(`     ${ICON.skip} ${skipGroups.get(f.message)} tools: ${f.message.replace(/^Not run: /, 'not run: ')}`);
        shownGroups.add(f.message);
        continue;
      }
      lines.push(`     ${ICON[f.status]} ${f.tool && !f.message.includes(f.tool) ? f.tool + ': ' : ''}${f.message}`);
    }
  }

  const fixes = topFixes(r);
  if (fixes.length) {
    lines.push('');
    lines.push('Fix these first:');
    fixes.forEach((f, i) => lines.push(`  ${i + 1}. ${f.tool && !f.message.includes(f.tool) ? f.tool + ': ' : ''}${f.message}`));
  }
  lines.push('');
  return lines.join('\n');
}

// One fix per check that didn't pass: failed checks first, then the ones that count most.
export function topFixes(r: Report, max = 3): Finding[] {
  const rank = { fail: 0, warn: 1 } as const;
  return r.checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .sort((a, b) => rank[a.status as 'fail' | 'warn'] - rank[b.status as 'fail' | 'warn'] || b.weight - a.weight)
    .map((c) => c.findings.find((f) => f.status === c.status)!)
    .filter(Boolean)
    .slice(0, max);
}
