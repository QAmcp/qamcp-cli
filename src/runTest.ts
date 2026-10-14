import { ProtocolError, SdkError, SdkErrorCode, type Client, type Tool } from '@modelcontextprotocol/client';
import { connect } from './connect.js';
import { toolboxHash, toolFingerprints } from './ci.js';
import { checkResourcesAndPrompts } from './resourcesPrompts.js';
import { checkLoginSetup } from './oauthSetup.js';
import { badArgs, goodArgs } from './sampleArgs.js';
import { HIDDEN_INSTRUCTION_PATTERNS, INTERNAL_PATTERNS, SECRET_PATTERNS, VALID_TOOL_NAME, allMatches, firstMatch } from './patterns.js';
import { decideRun, labelContradiction, looksDestructive } from './toolSafety.js';
import { hollowTools, similarTools, vagueDescription } from './heuristics.js';
import { scoreOf } from './score.js';
import type { CheckResult, Finding, ProgressEvent, Report, Status, TestOptions, ToolCallRecord } from './types.js';

const MAX_TOOLS_TO_RUN = 60;
const CHECKS_TOTAL = 10;
const SLOW_MS = 2_000;
const TOO_SLOW_MS = 10_000;

export async function runTest(url: string, opts: TestOptions = {}): Promise<Report> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const report: Report = {
    url, testedAt: new Date().toISOString(), score: 0, toolCount: 0,
    coverage: { checksRun: 0, checksTotal: CHECKS_TOTAL, toolsRun: 0, toolsTotal: 0 }, skippedTools: [], checks: [], calls: [],
    testedAs: { safety: opts.safety ?? 'labeled', loggedIn: !!(opts.login || opts.authProvider) },
    dataFlow: DATA_FLOW,
  };
  // Live progress for the website: every finished check, plus a note before each slow part.
  const say = (e: ProgressEvent) => {
    try {
      opts.onProgress?.(e);
    } catch {
      // a broken listener must never break the test
    }
  };
  const push = (c: CheckResult) => {
    report.checks.push(c);
    say({ kind: 'check', id: c.id, title: c.title, status: c.status, summary: c.summary });
  };
  say({ kind: 'working', message: 'Connecting to the server' });

  // 1. Connect
  let client: Client;
  let connectMs: number;
  try {
    const conn = await connect(url, opts.headers ?? {}, timeoutMs, opts.login, opts.fetch, opts.stdio, opts.authProvider);
    client = conn.client;
    connectMs = conn.ms;
    const info = client.getServerVersion();
    report.server = { name: info?.name, version: info?.version };
    report.protocol = { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(), transport: conn.transport };
    push(check('connect', 'Connects', 15, [{ status: 'pass', message: `Connected in ${fmtMs(connectMs)}` }]));
  } catch (err) {
    push(check('connect', 'Connects', 15, [{ status: 'fail', message: explainConnectError(err) }]));
    // A login wall isn't a broken server: say so instead of giving it a zero.
    if (needsLogin(err)) report.notScored = 'needs a login';
    // Even without logging in we can read the server's public login setup, and often explain why logging in fails.
    if (!opts.stdio) {
      const login = await checkLoginSetup(url, { fetch: opts.fetch, timeoutMs: 10_000 });
      if (login) push(login);
    }
    return finish(report);
  }

  try {
    push(protocolCheck(report));
    if (!opts.stdio) {
      const login = await checkLoginSetup(url, { fetch: opts.fetch, timeoutMs: 10_000 });
      if (login) push(login);
    }

    // 2. Tool list
    let tools: Tool[] = [];
    let broken: { name: string; problem: string }[] = [];
    const listStarted = Date.now();
    try {
      tools = (await client.listTools(undefined, { timeout: timeoutMs })).tools;
    } catch (err) {
      // The official client rejects the whole list when one tool is malformed, and so may
      // AI apps. Read the list without that check, name the broken tools, test the rest.
      try {
        ({ tools, broken } = splitRawTools(await client.request({ method: 'tools/list', params: {} } as any, PERMISSIVE as any, { timeout: timeoutMs })));
      } catch {
        push(check('tools', 'Lists its tools', 10, [{ status: 'fail', message: toolListError(errText(err)) }]));
        return finish(report);
      }
    }
    const listMs = Date.now() - listStarted;
    report.toolCount = tools.length + broken.length;
    report.toolboxHash = toolboxHash(tools);
    report.toolFingerprints = toolFingerprints(tools);
    push(toolListCheck(tools, broken));
    if (!tools.length) return finish(report);

    push(descriptionCheck(tools));
    push(safetyLabelCheck(tools));
    push(hiddenInstructionCheck(tools));

    // 3. Call tools that are safe to run
    const runnable: { tool: Tool; why: ToolCallRecord['why'] }[] = [];
    for (const tool of tools) {
      const d = decideRun(tool, opts.safety ?? 'labeled');
      if (!d.run) report.skippedTools.push({ tool: tool.name, why: d.why });
      else if (runnable.length >= MAX_TOOLS_TO_RUN) report.skippedTools.push({ tool: tool.name, why: `we test at most ${MAX_TOOLS_TO_RUN} tools` });
      else runnable.push({ tool, why: d.why });
    }
    say({ kind: 'working', message: `Trying ${runnable.length} safe tool${runnable.length === 1 ? '' : 's'} with good and bad inputs` });
    for (const { tool, why } of runnable) {
      report.calls.push(await callTool(client, tool, why, 'good-input', goodArgs(tool.inputSchema), timeoutMs));
      for (const bad of badArgs(tool.inputSchema)) {
        const rec = await callTool(client, tool, why, 'bad-input', bad.args, timeoutMs);
        report.calls.push({ ...rec, text: `[${bad.label}] ${rec.text}` });
      }
    }
    push(toolsRespondCheck(report.calls, runnable.length, report.skippedTools));
    push(badInputCheck(report.calls, runnable.length));
    push(speedCheck(connectMs, listMs, report.calls, report.protocol?.transport === 'stdio'));
    push(leakCheck(report.calls));
    // Resources and prompts: only a check when the server offers them.
    say({ kind: 'working', message: 'Opening resources and prompts' });
    const rp = await checkResourcesAndPrompts(client, timeoutMs);
    if (rp) push(rp.check);
    // Extra checks plugged in by another app (QAmcp's hosted version adds its AI tests here).
    for (const extra of opts.extraChecks ?? []) {
      try {
        const c = await extra({ client, tools, report, timeoutMs, say });
        if (c) push(c);
      } catch {
        // a broken plug-in must never break the test
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return finish(report);
}

function finish(report: Report): Report {
  const s = scoreOf(report.checks);
  report.score = s.score;
  report.scoreBeforeCaps = s.beforeCaps;
  report.scoreCaps = s.caps;
  report.coverage = {
    checksRun: report.checks.filter((c) => c.status !== 'skip').length,
    // The login-setup check only exists when the server asks for a login.
    // Some checks only exist for some servers (login, resources and prompts, plug-ins).
    checksTotal: CHECKS_TOTAL + report.checks.filter((c) => !CORE_CHECKS.has(c.id)).length,
    toolsRun: new Set(report.calls.filter((c) => c.outcome !== 'needs-login').map((c) => c.tool)).size,
    toolsTotal: report.toolCount,
  };
  return report;
}

const CORE_CHECKS = new Set(['connect', 'protocol', 'tools', 'descriptions', 'labels', 'hidden', 'respond', 'bad-input', 'speed', 'leaks']);

// QAmcp sends nothing anywhere except to the server being tested. No AI, no tracking.
const DATA_FLOW: NonNullable<Report['dataFlow']> = {
  summary: 'Privacy: nothing was sent anywhere except to the server being tested (and its login server, if it needed a login). QAmcp has no tracking.',
};

// ---------- checks ----------

function protocolCheck(report: Report): CheckResult {
  const findings: Finding[] = [];
  const { era, version, transport } = report.protocol!;
  if (era === 'modern') findings.push({ status: 'pass', message: `Uses the latest MCP version (${version})` });
  else findings.push({ status: 'warn', message: `Uses an older MCP version (${version}). It works today, but it isn't on the July 2026 version (2026-07-28) yet.` });
  if (transport === 'sse') findings.push({ status: 'warn', message: 'Only speaks the old SSE connection type, which MCP is removing. Switch to Streamable HTTP.' });
  return check('protocol', 'Ready for the newest MCP version', 10, findings);
}

// Accepts any reply, so a malformed tool list can still be read and explained.
const PERMISSIVE = { '~standard': { version: 1, vendor: 'qamcp', validate: (value: unknown) => ({ value }) } };

// Separate tools AI apps can load from tools that break the MCP rules for a tool definition.
export function splitRawTools(raw: any): { tools: Tool[]; broken: { name: string; problem: string }[] } {
  const tools: Tool[] = [];
  const broken: { name: string; problem: string }[] = [];
  for (const t of Array.isArray(raw?.tools) ? raw.tools : []) {
    const name = typeof t?.name === 'string' && t.name ? t.name : '(no name)';
    if (name === '(no name)') broken.push({ name, problem: 'has no name' });
    else if (!t.inputSchema || typeof t.inputSchema !== 'object') broken.push({ name, problem: 'has no input definition (inputSchema), which MCP requires on every tool' });
    else tools.push(t as Tool);
  }
  return { tools, broken };
}

function toolListCheck(tools: Tool[], broken: { name: string; problem: string }[] = []): CheckResult {
  const findings: Finding[] = [];
  for (const b of broken)
    findings.push({ status: 'fail', tool: b.name, message: `Breaks the tool list: ${b.problem}. AI apps may refuse to load this whole server because of it. We tested the other tools anyway.` });
  if (!tools.length) return check('tools', 'Lists its tools', 10, [...findings, { status: 'fail', message: 'The server has no usable tools' }]);
  findings.push({ status: 'pass', message: `Found ${tools.length + broken.length} tool${tools.length + broken.length === 1 ? '' : 's'}` });

  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) findings.push({ status: 'fail', tool: t.name, message: `Two tools share the name "${t.name}"` });
    seen.add(t.name);
    if (!VALID_TOOL_NAME.test(t.name)) findings.push({ status: 'warn', tool: t.name, message: `Name "${t.name}" breaks the MCP naming rule (letters, numbers, _ - . only, max 128)` });
    if ((t.inputSchema as any)?.type !== 'object') findings.push({ status: 'fail', tool: t.name, message: 'Input definition is not an object, so AI apps may reject this tool' });
  }
  return check('tools', 'Lists its tools', 10, findings);
}

function descriptionCheck(tools: Tool[]): CheckResult {
  const findings: Finding[] = [];
  for (const t of tools) {
    const desc = t.description?.trim() ?? '';
    if (!desc) findings.push({ status: 'fail', tool: t.name, message: 'Has no description, so the AI has to guess what it does' });
    else if (desc.length < 20) findings.push({ status: 'warn', tool: t.name, message: `Description is very short (${desc.length} characters)` });
    else if (desc.length > 4000) findings.push({ status: 'warn', tool: t.name, message: `Description is very long (${desc.length} characters), which uses up the AI's memory` });

    const props: Record<string, any> = (t.inputSchema as any)?.properties ?? {};
    const undocumented = Object.keys(props).filter((k) => !props[k]?.description?.trim());
    if (undocumented.length) findings.push({ status: 'warn', tool: t.name, message: `Inputs with no description: ${undocumented.join(', ')}` });
    const vague = vagueDescription(t);
    if (vague) findings.push({ status: 'warn', tool: t.name, message: `Description ${vague}: "${t.description!.trim().slice(0, 80)}"` });
  }
  for (const p of similarTools(tools))
    findings.push({ status: 'warn', tool: p.a, message: `${p.a} and ${p.b} have nearly the same description (${Math.round(p.overlap * 100)}% of their words are shared${differ(p)}), so an AI may not know which to pick` });
  if (!findings.length) findings.push({ status: 'pass', message: `All ${tools.length} tools and their inputs are described` });
  return check('descriptions', 'Every tool is described', 15, findings);
}

// ", the only difference: "index" vs "page"" — what tells two similar descriptions apart.
function differ(p: { onlyA: string[]; onlyB: string[] }): string {
  const show = (ws: string[]) => (ws.length ? ws.slice(0, 3).map((w) => `"${w}"`).join(', ') : 'nothing');
  if (!p.onlyA.length && !p.onlyB.length) return '; the descriptions are identical';
  return `; the only difference: ${show(p.onlyA)} vs ${show(p.onlyB)}`;
}

function safetyLabelCheck(tools: Tool[]): CheckResult {
  const findings: Finding[] = [];
  const unlabeled = tools.filter((t) => t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined);
  if (unlabeled.length) {
    findings.push({ status: 'warn', message: `${unlabeled.length} of ${tools.length} tools have no safety label (read-only or dangerous): ${unlabeled.map((t) => t.name).join(', ')}` });
  }
  for (const t of tools) {
    const signal = labelContradiction(t);
    // Word matching can't tell "shows a form whose button creates an order" from "creates an order",
    // so this is a prompt to double-check, never a failure.
    if (signal && !looksDestructive(t.name)) findings.push({ status: 'warn', tool: t.name, message: `Labeled read-only, but its ${signal}. Worth double-checking the label, since AI apps trust it.` });
    if (!looksDestructive(t.name)) continue;
    if (t.annotations?.readOnlyHint === true) findings.push({ status: 'fail', tool: t.name, message: 'Name sounds like it deletes something, but it is labeled read-only' });
    else if (t.annotations?.destructiveHint !== true) findings.push({ status: 'warn', tool: t.name, message: 'Name sounds like it deletes something, but it is not labeled dangerous' });
  }
  if (!findings.length) findings.push({ status: 'pass', message: 'Every tool has a safety label' });
  return check('labels', 'Tools are labeled safe or dangerous', 10, findings);
}

function hiddenInstructionCheck(tools: Tool[]): CheckResult {
  const findings: Finding[] = [];
  for (const t of tools) {
    const text = [t.name, t.title, t.description, JSON.stringify(t.inputSchema)].filter(Boolean).join('\n');
    const hit = firstMatch(text, HIDDEN_INSTRUCTION_PATTERNS);
    if (hit) findings.push({ status: 'fail', tool: t.name, message: `Description contains ${hit}. This is a known trick to make AI do things the user didn't ask for.` });
  }
  if (!findings.length) findings.push({ status: 'pass', message: 'No hidden instructions found in tool descriptions' });
  return check('hidden', 'No hidden instructions', 10, findings);
}

function toolsRespondCheck(calls: ToolCallRecord[], ran: number, skipped: Report['skippedTools']): CheckResult {
  const findings: Finding[] = [];
  const byName = [...new Set(calls.filter((c) => c.why === 'name says read-only').map((c) => c.tool))];
  if (byName.length) findings.push({ status: 'pass', message: `Not labeled, but ran because the name says it only reads: ${byName.join(', ')}` });
  const good = calls.filter((c) => c.kind === 'good-input');
  const hollow = new Map(hollowTools(calls).map((h) => [h.tool, h]));
  for (const c of good) {
    const h = hollow.get(c.tool);
    if (c.outcome === 'ok' && h) findings.push({ status: h.serious ? 'fail' : 'warn', tool: c.tool, message: `Answered, but it ${h.reason}` });
    else if (c.outcome === 'ok') findings.push({ status: 'pass', tool: c.tool, message: `Worked (${fmtMs(c.ms)})` });
    else if (c.outcome === 'tool-error' || c.outcome === 'protocol-error') findings.push({ status: 'pass', tool: c.tool, message: `Answered with an error, probably because of our sample input: ${short(c.text)}` });
    else if (c.outcome === 'timeout') findings.push({ status: 'fail', tool: c.tool, message: `No answer within the time limit` });
    else if (c.outcome === 'needs-login') findings.push({ status: 'skip', tool: c.tool, message: 'Needs you to sign in, so it was not tested (not counted against the server)' });
    else findings.push({ status: 'fail', tool: c.tool, message: `Crashed: ${short(c.text)}` });
  }
  for (const s of skipped) findings.push({ status: 'skip', tool: s.tool, message: `Not run: ${s.why}` });
  const tested = good.filter((c) => c.outcome !== 'needs-login').length;
  return check('respond', 'Tools work with good inputs', 10, findings, ran === 0 || tested === 0);
}

function badInputCheck(calls: ToolCallRecord[], ran: number): CheckResult {
  const findings: Finding[] = [];
  for (const c of calls.filter((c) => c.kind === 'bad-input')) {
    const what = c.text.match(/^\[([^\]]+)\]/)?.[1] ?? 'bad input';
    if (c.outcome === 'tool-error' || c.outcome === 'protocol-error') {
      const empty = c.text.replace(/^\[[^\]]+\]\s*/, '').trim().length === 0;
      findings.push(empty
        ? { status: 'warn', tool: c.tool, message: `Refused ${what}, but the error message is empty` }
        : { status: 'pass', tool: c.tool, message: `Refused ${what} with a clear error` });
    } else if (c.outcome === 'ok') findings.push({ status: 'warn', tool: c.tool, message: `Accepted ${what} without complaining` });
    else if (c.outcome === 'timeout') findings.push({ status: 'fail', tool: c.tool, message: `Hung on ${what}` });
    else if (c.outcome === 'needs-login') findings.push({ status: 'skip', tool: c.tool, message: 'Needs you to sign in, so bad inputs were not tested' });
    else findings.push({ status: 'fail', tool: c.tool, message: `Crashed on ${what}` });
  }
  const oddErrors = [...new Set(calls.filter((c) => c.note).map((c) => c.tool))];
  if (oddErrors.length) findings.push({ status: 'warn', message: `Errors are sent with an HTTP error status (like 400) instead of a normal MCP reply, so some AI apps may treat them as crashes: ${oddErrors.join(', ')}` });
  return check('bad-input', 'Bad inputs give a clean error', 10, findings, ran === 0 || findings.every((f) => f.status === 'skip'));
}

function speedCheck(connectMs: number, listMs: number, calls: ToolCallRecord[], isProgram = false): CheckResult {
  const findings: Finding[] = [];
  const rate = (ms: number): Status => (ms > TOO_SLOW_MS ? 'fail' : ms > SLOW_MS ? 'warn' : 'pass');
  // Connecting includes the MCP version check, which costs older servers one extra round trip.
  const connectStatus: Status = connectMs > 15_000 ? 'fail' : connectMs > 5_000 ? 'warn' : 'pass';
  // A program's start-up time includes whatever its launcher (like npx) had to download, which isn't the server's fault.
  if (isProgram) findings.push({ status: 'pass', message: `Started in ${fmtMs(connectMs)} (this includes anything the launcher had to download, so it isn't judged)` });
  else findings.push({ status: connectStatus, message: `Connecting took ${fmtMs(connectMs)}` });
  findings.push({ status: rate(listMs), message: `Listing tools took ${fmtMs(listMs)}` });

  const timed = calls.filter((c) => c.kind === 'good-input' && c.outcome !== 'timeout' && c.outcome !== 'needs-login');
  if (timed.length) {
    const avg = timed.reduce((s, c) => s + c.ms, 0) / timed.length;
    const slowest = timed.reduce((a, b) => (b.ms > a.ms ? b : a));
    findings.push({ status: rate(avg), message: `Average tool answer: ${fmtMs(avg)}` });
    // 2–10 s stays a warning (searches and reports can honestly take that long), said plainly.
    const feel = slowest.ms > TOO_SLOW_MS ? ': most users will give up waiting' : slowest.ms > SLOW_MS ? ': users will notice the wait' : '';
    findings.push({ status: rate(slowest.ms), tool: slowest.tool, message: `Slowest tool: ${slowest.tool} (${fmtMs(slowest.ms)})${feel}` });
  }
  return check('speed', 'Fast enough', 5, findings);
}

function leakCheck(calls: ToolCallRecord[]): CheckResult {
  const findings: Finding[] = [];
  // Only error answers are scanned: normal answers from docs servers often contain example keys on purpose.
  for (const c of calls.filter((c) => c.outcome !== 'ok')) {
    // Report everything one message gives away, not just the first thing found.
    const secret = firstMatch(c.text, SECRET_PATTERNS);
    if (secret) findings.push({ status: 'fail', tool: c.tool, message: `Error message shows what looks like ${/^[aeiou]/i.test(secret) ? 'an' : 'a'} ${secret}` });
    const internal = allMatches(c.text, INTERNAL_PATTERNS);
    if (internal.length) findings.push({ status: 'warn', tool: c.tool, message: `Error message shows internal details: ${internal.join(', ')}` });
  }
  const errorAnswers = calls.filter((c) => c.outcome !== 'ok').length;
  if (!errorAnswers) return check('leaks', 'No secrets leaked', 5, [{ status: 'skip', message: 'No error messages to check' }], true);
  if (!findings.length) findings.push({ status: 'pass', message: `Checked ${errorAnswers} error messages: no secrets or internal details` });
  return check('leaks', 'No secrets leaked', 5, findings);
}

// ---------- helpers ----------

function check(id: string, title: string, weight: number, allFindings: Finding[], skip = false): CheckResult {
  const seen = new Set<string>();
  const findings = allFindings.filter((f) => {
    const key = `${f.status}|${f.tool}|${f.message}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const statuses = findings.map((f) => f.status);
  const status: Status = skip ? 'skip' : statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
  const counts = (s: Status) => statuses.filter((x) => x === s).length;
  const summary = skip ? 'Not tested' : status === 'pass' ? 'All good' : [counts('fail') && `${counts('fail')} failed`, counts('warn') && `${counts('warn')} warning${counts('warn') === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return { id, title, status, summary, findings, weight };
}

async function callTool(client: Client, tool: Tool, why: ToolCallRecord['why'], kind: ToolCallRecord['kind'], args: Record<string, unknown>, timeoutMs: number): Promise<ToolCallRecord> {
  const started = Date.now();
  try {
    const result = await client.callTool({ name: tool.name, arguments: args }, { timeout: timeoutMs });
    return { tool: tool.name, why, kind, arguments: args, ms: Date.now() - started, outcome: result.isError ? 'tool-error' : 'ok', text: resultText(result) };
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'timeout', text: '' };
    if (err instanceof ProtocolError) return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'protocol-error', text: errText(err) };
    // Some servers send a proper MCP error but with an HTTP error status (like 400).
    // That's a clean refusal sent the unusual way, not a crash.
    const text = errText(err);
    const rpcMessage = text.match(/"error"\s*:\s*\{\s*"code"\s*:\s*-?\d+\s*,\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    if (rpcMessage) return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'protocol-error', text: rpcMessage, note: 'sent with an HTTP error status instead of a normal MCP reply' };
    // "Sign in first" (HTTP 401/403, or saying so) is the tool working as designed, not a crash.
    if (needsLogin(err) || SIGN_IN.test(text)) return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'needs-login', text };
    return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'crash', text };
  }
}

function resultText(result: any): string {
  const parts = (result.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`));
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const data = (err as any).data;
    return data !== undefined ? `${err.message} ${typeof data === 'string' ? data : JSON.stringify(data)}` : err.message;
  }
  return String(err);
}

const SIGN_IN = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|sign[ -]?in\b|log[ -]?in required|not authenticated|authentication required|access token|invalid_token/i;

function needsLogin(err: unknown): boolean {
  const status = (err as any)?.data?.status ?? (err as any)?.status;
  return (err instanceof SdkError && (err.code === SdkErrorCode.ClientHttpAuthentication || err.code === SdkErrorCode.ClientHttpForbidden)) || status === 401 || status === 403;
}

// Plain words for why the tool list couldn't be read.
export function toolListError(raw: string): string {
  if (/missing required resultType/i.test(raw))
    return `The server says it supports the newest MCP version (2026-07-28), but its tool list reply is missing the "resultType" field that version requires, so AI apps on that version can't load its tools`;
  return `Asking for the tool list failed: ${short(raw, 160)}`;
}

function explainConnectError(err: unknown): string {
  const status = (err as any)?.data?.status ?? (err as any)?.status;
  if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpAuthentication || status === 401) return 'The server needs a login key. Add it and test again.';
  if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpForbidden || status === 403) return 'The server refused access (403). Check the key has the right permissions.';
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return 'The server did not answer in time.';
  // The real reason is often buried a few layers down ("fetch failed" → cause → cause).
  const msg = [errText(err), ...causes(err)].join(' ');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "That address does not exist (its name can't be found). Check the link.";
  if (/ECONNREFUSED/i.test(msg)) return 'Nothing is running at that address.';
  if (/ECONNRESET|socket hang up|other side closed/i.test(msg)) return 'The server cut the connection before answering.';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ConnectTimeout/i.test(msg)) return 'The server did not answer in time.';
  if (/CERT|certificate|SSL|TLS/i.test(msg)) return "The server's security certificate is not valid, so AI apps won't connect to it.";
  if (/<!doctype html|<html|content.type: text\/html/i.test(msg)) return 'That address is a normal web page, not an MCP server. Check the link (it often ends in /mcp).';
  const http = msg.match(/(?:status|HTTP) (\d{3})/i);
  if (http) return `The server answered with an error (HTTP ${http[1]}) instead of connecting.`;
  if (/bad port/i.test(msg)) return 'That port is blocked for web requests. Use a different port.';
  return `Could not connect: ${short(errText(err).replace(/\s*\{"cause".*$/s, ''))}`;
}

// Codes and messages of the errors underneath this one.
function causes(err: unknown): string[] {
  const out: string[] = [];
  let e: any = (err as any)?.cause;
  for (let i = 0; e && i < 6; i++, e = e.cause) out.push(String(e.code ?? ''), String(e.message ?? ''));
  return out;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function short(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one || '(no message)';
}
