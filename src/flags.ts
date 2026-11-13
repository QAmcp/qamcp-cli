// Three plain questions answered before the score, because one number hides what matters most.
// Every answer is worked out by code from results already in the report (never by an AI), and
// every answer carries the evidence it came from, so a reader can check it.
//
// "Couldn't run any tool" is its own line, with its own reason: a login wall, a server that did
// not answer, or no tool labeled read-only. Those used to be mixed together.

import type { CheckResult, Finding, Report } from './types.js';

export type FlagTone = 'good' | 'bad' | 'none'; // none: not known, or not checked
export interface Flag {
  question: string;
  answer: string; // a few words: "Yes, 2 places", "No", "Not checked"
  tone: FlagTone;
  evidence: { text: string; tool?: string; check?: string }[]; // check: the check id it came from
}
export interface Flags {
  wrongTool: Flag;
  readOnly: Flag;
  noLogin: Flag;
  toolsRun: Flag; // "Tools run": how many, and when none ran, why
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function reportFlags(r: Report): Flags {
  const login = loginWall(r);
  return { wrongTool: wrongTool(r, login), readOnly: readOnly(r, login), noLogin: noLogin(r, login), toolsRun: toolsRun(r, login) };
}

// A login wall, also in reports saved before "notScored" existed (they only said so in the connect check).
function loginWall(r: Report): boolean {
  if (r.notScored === 'needs a login') return true;
  const connect = r.checks.find((c) => c.id === 'connect');
  return connect?.status === 'fail' && connect.findings.some((f) => /needs a login|sign in|log in|login key/i.test(f.message));
}

const byId = (r: Report, id: string): CheckResult | undefined => r.checks.find((c) => c.id === id);
// Tools that break the tool list: AI apps can't load them, and we can't read their labels or call them.
const brokenCount = (r: Report): number => byId(r, 'tools')?.findings.filter((f) => f.message.startsWith('Breaks the tool list')).length ?? 0;
const problems = (c: CheckResult | undefined): Finding[] => (c ? c.findings.filter((f) => f.status === 'warn' || f.status === 'fail') : []);

// Not having the tool list means the description and label questions could not be asked.
function noList(r: Report, login: boolean, question: string): Flag | undefined {
  if (login) return { question, answer: 'Not checked yet', tone: 'none', evidence: [{ text: 'The tools are behind the login.' }] };
  if (r.offersTools === false) return { question, answer: 'No tools', tone: 'none', evidence: [{ text: 'This server offers no tools, only resources or prompts.' }] };
  const tools = byId(r, 'tools');
  if (!tools || !r.toolCount) return { question, answer: 'Not checked', tone: 'none', evidence: [{ text: tools ? 'We could not read the tool list.' : 'We could not get as far as the tool list.', check: tools ? 'tools' : 'connect' }] };
  return undefined;
}

// From the description checks only: no description, inputs with no description, near-identical tools,
// vague or very short descriptions. ("Very long" is about the AI's memory, not about picking.)
const PICK = /^(?:Has no description|Description is very short|Inputs with no description|Description uses vague words|Description only repeats the tool name|\S+ and \S+ have nearly the same description)/;

function wrongTool(r: Report, login: boolean): Flag {
  const question = 'Could a description make the AI pick the wrong tool?';
  const missing = noList(r, login, question);
  if (missing) return missing;
  const c = byId(r, 'descriptions');
  if (!c) return { question, answer: 'Not checked', tone: 'none', evidence: [{ text: 'The description check did not run.' }] };
  const hits = problems(c).filter((f) => PICK.test(f.message));
  if (!hits.length) return { question, answer: 'No reason found', tone: 'good', evidence: [{ text: 'Every tool and input is described, and no two tools read nearly the same.', check: 'descriptions' }] };
  return { question, answer: `Yes, ${plural(hits.length, 'place')}`, tone: 'bad', evidence: hits.map((f) => ({ text: f.message, tool: f.tool, check: 'descriptions' })) };
}

// What each skip reason tells us about the tool's read-only label (see decideRun in toolSafety.ts).
function labelFromSkip(why: string): 'read-only' | 'not read-only' | 'unknown' {
  if (why.startsWith('labeled read-only')) return 'read-only';
  if (/^(?:no safety label|labeled dangerous|labeled as changing data|no label, and the name)/.test(why) || why.endsWith('so it might change data')) return 'not read-only';
  return 'unknown'; // too many tools to run, look-only mode, task mode, a name that sounds like deleting
}

function readOnly(r: Report, login: boolean): Flag {
  const question = 'Is anything marked read-only?';
  const missing = noList(r, login, question);
  if (missing) return missing;
  // Only tools AI apps can load have labels to read: a tool that breaks the tool list is counted apart.
  const broken = brokenCount(r);
  // Each tool's definition, labels included, is kept in the report (toolDefs).
  const total = r.toolDefs?.length ?? Math.max(0, r.toolCount - broken);
  let count: number;
  let atLeast = false;
  if (r.toolDefs) count = r.toolDefs.filter((t) => t.annotations?.readOnlyHint === true).length;
  else {
    // Older reports don't keep each tool's labels: work them out from what ran and why the rest didn't.
    const yes = new Set(r.calls.filter((c) => c.why === 'labeled read-only').map((c) => c.tool));
    let unknown = 0;
    for (const s of r.skippedTools) {
      const l = labelFromSkip(s.why);
      if (l === 'read-only') yes.add(s.tool);
      else if (l === 'unknown') unknown++;
    }
    count = yes.size;
    const unlabeled = problems(byId(r, 'labels')).map((f) => f.message.match(/^(\d+) of (\d+) tools have no safety label/)).find(Boolean);
    if (unlabeled && Number(unlabeled[1]) === Number(unlabeled[2])) count = 0;
    else atLeast = unknown > 0;
  }
  const evidence: Flag['evidence'] = problems(byId(r, 'labels')).map((f) => ({ text: f.message, tool: f.tool, check: 'labels' }));
  if (broken) evidence.push({ text: `${plural(broken, 'more tool')} ${broken === 1 ? 'breaks' : 'break'} the tool list, so ${broken === 1 ? 'its label' : 'their labels'} could not be read.`, check: 'tools' });
  if (!count && !atLeast) {
    const none = total === 1 ? 'Its one tool is not labeled read-only (readOnlyHint), so AI apps can\'t tell whether it only reads.' : `None of the ${total} tools is labeled read-only (readOnlyHint), so AI apps can't tell which ones only read.`;
    return { question, answer: 'No', tone: 'bad', evidence: [{ text: none, check: 'labels' }, ...evidence.filter((e) => e.tool || e.check === 'tools')] };
  }
  const answer = `${atLeast ? 'Yes, at least' : 'Yes,'} ${count} of ${total}`;
  return { question, answer, tone: 'good', evidence: evidence.length ? evidence : [{ text: 'Every tool has a safety label.', check: 'labels' }] };
}

function noLogin(r: Report, login: boolean): Flag {
  const question = 'Could we see the tools without a login?';
  const connect = byId(r, 'connect');
  const tools = byId(r, 'tools');
  if (login) {
    const said = tools?.findings.find((f) => /login/i.test(f.message)) ?? connect?.findings[0];
    // A fact, not a fault: many good servers need a login.
    return { question, answer: 'No', tone: 'none', evidence: [{ text: tools && said === tools.findings[0] ? said!.message : 'The server asks for a login before it shows its tools.', check: tools ? 'tools' : 'connect' }] };
  }
  if (r.testedAs?.loggedIn) return { question, answer: 'Not tried', tone: 'none', evidence: [{ text: 'This test used your login, so it did not try without one.' }] };
  if (connect?.status !== 'pass') return { question, answer: "Couldn't tell", tone: 'none', evidence: [{ text: connect?.findings[0]?.message ?? 'The server did not answer.', check: 'connect' }] };
  if (r.offersTools === false) return { question, answer: 'No tools', tone: 'none', evidence: [{ text: 'This server offers no tools, only resources or prompts.', check: 'tools' }] };
  const found = tools?.findings.find((f) => /^Found \d+ tools?$/.test(f.message));
  if (found) return { question, answer: 'Yes', tone: 'good', evidence: [{ text: `${found.message}, with no login.`, check: 'tools' }] };
  return { question, answer: "Couldn't tell", tone: 'none', evidence: [{ text: problems(tools)[0]?.message ?? 'The tool list did not come back.', check: 'tools' }] };
}

// How many tools ran, and when none did, the one reason why.
function toolsRun(r: Report, login: boolean): Flag {
  const question = 'Tools run';
  const total = r.coverage?.toolsTotal ?? r.toolCount;
  const ran = r.coverage?.toolsRun ?? 0;
  const connect = byId(r, 'connect');
  const none = (why: string, evidence: Flag['evidence'] = [], tone: FlagTone = 'bad'): Flag => ({ question, answer: total ? `0 of ${total}` : 'None', tone, evidence: [{ text: `No tool could be run. Why: ${why}.` }, ...evidence] });
  // A login wall is not a fault, so it is not marked as one.
  if (login) return none('a login wall: the server asks for a login first', [{ text: 'Testing with your login runs the tools too.' }], 'none');
  if (r.notScored) return none(`the server ${r.notScored}`, [{ text: connect?.findings[0]?.message ?? '', check: 'connect' }].filter((e) => e.text), 'none');
  if (connect?.status === 'fail') return none('the server did not answer', [{ text: connect.findings[0]?.message ?? '', check: 'connect' }].filter((e) => e.text));
  if (r.offersTools === false) return { question, answer: 'No tools', tone: 'none', evidence: [{ text: 'This server offers no tools, only resources or prompts.' }] };
  if (!total) return none('the tool list did not come back', problems(byId(r, 'tools')).slice(0, 1).map((f) => ({ text: f.message, check: 'tools' })));
  if (ran > 0) {
    const left = total - ran;
    const broken = brokenCount(r);
    const skipped = Math.min(r.skippedTools.length, left);
    const other = left - skipped - Math.min(broken, left - skipped);
    const why: Flag['evidence'] = [];
    if (skipped) why.push({ text: `${plural(skipped, 'tool')} not run on purpose: the reasons are listed under "Tools not run, and why".` });
    if (broken && left > skipped) why.push({ text: `${plural(Math.min(broken, left - skipped), 'tool')} ${broken === 1 ? 'breaks' : 'break'} the tool list, so ${broken === 1 ? 'it' : 'they'} could not be called.`, check: 'tools' });
    if (other > 0) why.push({ text: `${plural(other, 'tool')} did not give an answer we could count.`, check: 'respond' });
    return { question, answer: `${ran} of ${total}`, tone: 'good', evidence: left ? why : [{ text: 'Every tool ran.' }] };
  }
  if (r.testedAs?.safety === 'none' || r.skippedTools.some((s) => s.why.startsWith('look-only'))) return { question, answer: `0 of ${total}`, tone: 'none', evidence: [{ text: 'Look-only mode: no tools were called, on purpose.' }] };
  const called = r.calls.filter((c) => c.kind === 'good-input');
  if (called.length && called.every((c) => c.outcome === 'needs-login')) return none('a login wall: every tool asked us to sign in first', [], 'none');
  if (called.length && called.every((c) => c.outcome === 'rate-limited')) return none('the server limited our requests (HTTP 429)', [], 'none');
  if (called.length) return none('the server did not give a usable answer to any call', called.slice(0, 1).map((c) => ({ text: c.reason ?? c.outcome, tool: c.tool, check: 'respond' })));
  const unlabeled = r.skippedTools.filter((s) => labelFromSkip(s.why) === 'not read-only').length;
  if (unlabeled === r.skippedTools.length && unlabeled > 0) return none('no tool is labeled read-only, and this test only runs tools labeled read-only', [{ text: 'If you own this server, add readOnlyHint: true to the tools that only read, or test again with --owner.' }]);
  return none('none of the tools could be run safely; each reason is listed under "Tools not run, and why"');
}

// The same answers as text lines, for the terminal report.
export function flagLines(f: Flags): string[] {
  const out: string[] = [];
  for (const x of [f.wrongTool, f.readOnly, f.noLogin, f.toolsRun]) {
    out.push(`${x.question}${x.question.endsWith('?') ? '' : ':'} ${x.answer}`);
    for (const e of x.evidence.slice(0, 3)) out.push(`    ${e.tool && !e.text.startsWith(e.tool) ? e.tool + ': ' : ''}${e.text}`);
    if (x.evidence.length > 3) out.push(`    and ${x.evidence.length - 3} more`);
  }
  return out;
}
