// `--before-install`: for someone about to add an MCP server to Claude, Cursor or another AI app.
// It calls none of the server's tools (look-only), reads what the server says about itself, and
// answers in plain words: any red flags, and which tools could change, send or delete things.

import { looksDestructive, writeSignal } from './toolSafety.js';
import type { Report } from './types.js';

export interface InstallVerdict {
  level: 'red' | 'careful' | 'ok' | 'unknown';
  headline: string;
  points: string[];
}

const list = (names: string[], max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

export function beforeInstall(r: Report): InstallVerdict {
  const connect = r.checks.find((c) => c.id === 'connect');
  if (r.notScored && /login/i.test(r.notScored)) {
    return { level: 'unknown', headline: 'It needs an account before it shows its tools', points: ['QAmcp can only see what a server shares before you sign in. Check again with --login to see its tools.'] };
  }
  if (connect?.status === 'fail' || !r.toolDefs) {
    return { level: 'unknown', headline: 'We could not check it', points: [connect?.findings[0]?.message ?? 'The server did not share its tools.'] };
  }
  const hidden = r.checks.find((c) => c.id === 'hidden');
  const red = hidden?.status === 'fail' ? hidden.findings.filter((f) => f.status === 'fail') : [];

  const deletes: string[] = [], changes: string[] = [], unsure: string[] = [], reads: string[] = [];
  for (const t of r.toolDefs) {
    const a = (t.annotations ?? {}) as Record<string, unknown>;
    const tool = { name: t.name, description: t.description, inputSchema: t.inputSchema ?? {}, annotations: a } as any;
    if (a.destructiveHint === true || looksDestructive(t.name)) deletes.push(t.name);
    else if (a.readOnlyHint === false || writeSignal(tool, true)) changes.push(t.name);
    else if (a.readOnlyHint === true) reads.push(t.name);
    else unsure.push(t.name);
  }

  const points: string[] = [];
  if (red.length) points.push(`Hidden instructions in ${red.length === 1 ? 'a tool description' : `${red.length} tool descriptions`} (${list([...new Set(red.map((f) => f.tool ?? '?'))])}): text that tells the AI to do things you didn't ask for.`);
  if (deletes.length) points.push(`${deletes.length} tool${deletes.length === 1 ? '' : 's'} can delete things: ${list(deletes)}.`);
  if (changes.length) points.push(`${changes.length} tool${changes.length === 1 ? '' : 's'} can change or send things: ${list(changes)}.`);
  if (unsure.length) points.push(`${unsure.length} tool${unsure.length === 1 ? " doesn't" : "s don't"} say whether ${unsure.length === 1 ? 'it changes' : 'they change'} anything: ${list(unsure)}.`);
  if (reads.length) points.push(`${reads.length} tool${reads.length === 1 ? '' : 's'} only read${reads.length === 1 ? 's' : ''} (labeled read-only).`);
  if (!r.toolDefs.length) points.push('It offers no tools.');
  if (deletes.length || changes.length) points.push('Your AI app should ask you before it uses tools that change, send or delete things. Keep that setting on.');

  if (red.length) return { level: 'red', headline: "Red flag: don't install it yet", points };
  if (deletes.length || changes.length || unsure.length) return { level: 'careful', headline: 'No red flags, but some tools can do more than read', points };
  return { level: 'ok', headline: 'No red flags found', points };
}

export function formatBeforeInstall(r: Report, v: InstallVerdict): string {
  const icon = { red: '🛑', careful: '⚠️ ', ok: '✅', unknown: '➖' }[v.level];
  return [
    '',
    `Before you install ${r.server?.name ?? r.url}`,
    '',
    `${icon} ${v.headline}`,
    ...v.points.map((p) => `   • ${p}`),
    '',
    'QAmcp read what the server says about itself and called none of its tools. It can\'t see what the server',
    'does with your data behind the scenes, so only add servers from makers you trust.',
    '',
  ].join('\n');
}
