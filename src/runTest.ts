import { ProtocolError, SdkError, SdkErrorCode, fromJsonSchema, specTypeSchemas, type Client, type Tool } from '@modelcontextprotocol/client';
import { connect, stdoutNoise } from './connect.js';
import { toolboxHash, toolFingerprints } from './ci.js';
import { toToolDef } from './drift.js';
import { chainCheck } from './chains.js';
import { checkResourcesAndPrompts } from './resourcesPrompts.js';
import { badReplyWords, classifyError, schemaIssueWords } from './errorKind.js';
import { checkLoginSetup } from './oauthSetup.js';
import { badArgs, goodArgs } from './sampleArgs.js';
import { HIDDEN_INSTRUCTION_PATTERNS, INTERNAL_PATTERNS, SECRET_PATTERNS, VALID_TOOL_NAME, allMatches, firstMatch } from './patterns.js';
import { decideRun, labelContradiction, looksDestructive } from './toolSafety.js';
import { hollowTools, similarTools, vagueDescription } from './heuristics.js';
import { scoreOf } from './score.js';
import type { CheckResult, Finding, ProgressEvent, Report, Status, TestOptions, ToolCallRecord } from './types.js';

const MAX_TOOLS_TO_RUN = 60;
const BIG_ANSWER = 100_000; // characters, roughly 25,000 tokens
// Answers that mean we did not really test the tool. Never counted against the server.
const NOT_TESTED = new Set<ToolCallRecord['outcome']>(['needs-login', 'rate-limited', 'unclear']);
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
  let programOutput: (() => string) | undefined;
  try {
    const attempt = () => connect(url, opts.headers ?? {}, timeoutMs, opts.login, opts.fetch, opts.stdio, opts.authProvider);
    // A rate limit is the server asking us to slow down: wait a moment and try once more, as a polite app would.
    const conn = await attempt().catch(async (err) => {
      if (opts.stdio || httpStatus(err) !== 429) throw err;
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
      return attempt();
    });
    client = conn.client;
    connectMs = conn.ms;
    const info = client.getServerVersion();
    report.server = { name: info?.name, version: info?.version };
    report.protocol = { era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(), transport: conn.transport };
    programOutput = conn.programOutput;
    push(check('connect', 'Connects', 15, [{ status: 'pass', message: `Connected in ${fmtMs(connectMs)}` }]));
  } catch (err) {
    let why = explainConnectError(err, !!opts.stdio);
    // The most common wrong link: the server lives at …/mcp, but the link (often copied from a listing) leaves it out.
    const alt = !opts.stdio && [404, 405].includes(httpStatus(err) ?? 0) ? await mcpPathAnswers(url, opts.fetch, timeoutMs) : undefined;
    if (alt) why = `Nothing at this address (HTTP ${httpStatus(err)}), but an MCP server answers at ${alt}. The link points to the wrong place: use that one instead.`;
    // A rate limit isn't a broken server either: it just asked us to slow down.
    const limited = !opts.stdio && httpStatus(err) === 429;
    if (limited) why = 'The server limited our requests (HTTP 429: too many requests), even after waiting. This is not a fault; try again in a minute.';
    push(check('connect', 'Connects', 15, [{ status: limited ? 'skip' : 'fail', message: why }], limited));
    if (limited) report.notScored = 'limited our requests (HTTP 429)';
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
    const noise = opts.stdio ? await stdoutNoise(opts.stdio).catch(() => []) : [];
    push(protocolCheck(report, noise));
    if (!opts.stdio) {
      const login = await checkLoginSetup(url, { fetch: opts.fetch, timeoutMs: 10_000 });
      if (login) push(login);
    }

    // 2. Tool list
    let tools: Tool[] = [];
    let broken: { name: string; problem: string }[] = [];
    let listMs = 0;
    const offersTools = !!client.getServerCapabilities()?.tools;
    report.offersTools = offersTools;
    if (!offersTools) {
      push(check('tools', 'Lists its tools', 10, [{ status: 'skip', message: 'This server offers no tools (it only has resources or prompts), so the tool checks do not apply' }], true));
    } else {
      const listStarted = Date.now();
      let listing: Awaited<ReturnType<typeof listToolsPaged>>;
      try {
        listing = await listToolsPaged(client, timeoutMs);
      } catch (err) {
        // Some servers let anyone connect, then ask for a login at this step: still a login wall, not a fault.
        if (listNeedsLogin(err)) {
          report.notScored = 'needs a login';
          push(check('tools', 'Lists its tools', 10, [{ status: 'skip', message: `The server asks for a login before it lists its tools (${short(serverSaid(err), 120)})` }], true));
          return finish(report);
        }
        push(check('tools', 'Lists its tools', 10, [{ status: 'fail', message: toolListError(errText(err)) }]));
        return finish(report);
      }
      listMs = Date.now() - listStarted;
      ({ tools, broken } = listing);
      // The official client is stricter about the reply as a whole (e.g. the 2026-07-28 "resultType").
      let sdkProblem: string | undefined;
      if (!broken.length) {
        try {
          await client.listTools(undefined, { timeout: timeoutMs });
        } catch (err) {
          sdkProblem = toolListError(errText(err));
        }
      }
      report.toolCount = tools.length + broken.length;
      report.toolboxHash = toolboxHash(tools);
      report.toolFingerprints = toolFingerprints(tools);
      report.toolDefs = tools.map(toToolDef);
      push(toolListCheck(tools, broken, listing.loop, sdkProblem));
    }
    if (tools.length) {

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
    // A local program that dies can't answer anything after that: those calls are not tests.
    let programDied = false;
    const run = async (tool: Tool, why: ToolCallRecord['why'], kind: ToolCallRecord['kind'], args: Record<string, unknown>): Promise<ToolCallRecord> => {
      if (programDied) return { tool: tool.name, why, kind, arguments: args, ms: 0, outcome: 'unclear', text: '', reason: 'the program had already stopped' };
      const rec = await callTool(client, tool, why, kind, args, timeoutMs);
      if (opts.stdio && rec.outcome === 'crash' && rec.reason?.startsWith('the connection was cut')) {
        programDied = true;
        const said = programOutput?.();
        return { ...rec, reason: `the program stopped${said ? ` (its last message: "${said}")` : ''}` };
      }
      return rec;
    };
    for (const { tool, why } of runnable) {
      report.calls.push(await run(tool, why, 'good-input', goodArgs(tool.inputSchema)));
      for (const bad of badArgs(tool.inputSchema)) {
        const rec = await run(tool, why, 'bad-input', bad.args);
        report.calls.push({ ...rec, text: `[${bad.label}] ${rec.text}` });
      }
    }
    if (opts.safety === 'none') {
      // Look-only: say plainly what wasn't tested, instead of "no tools ran".
      const why = 'Look-only mode: no tools were called, so this was not tested (not counted either way)';
      push(check('respond', 'Tools work with good inputs', 10, [{ status: 'skip', message: why }], true));
      push(check('bad-input', 'Bad inputs give a clean error', 10, [{ status: 'skip', message: why }], true));
      push(speedCheck(connectMs, listMs, report.calls, report.protocol?.transport === 'stdio'));
      push(check('leaks', 'No secrets leaked', 5, [{ status: 'skip', message: why }], true));
    } else {
    push(toolsRespondCheck(report.calls, runnable.length, report.skippedTools));
    push(badInputCheck(report.calls, runnable.length));
    // Chains run before the speed and secrets checks, so their answers are timed and scanned too.
    say({ kind: 'working', message: 'Trying tools together (one tool\'s answer into another)' });
    const good = report.calls.filter((c) => c.kind === 'good-input' && c.outcome === 'ok' && c.text.trim().length > 2);
    const whyOf = new Map(runnable.map((r) => [r.tool.name, r.why]));
    push(
      await chainCheck({
        tools: runnable.map((r) => r.tool),
        starts: good.map((c) => ({ tool: c.tool, args: c.arguments as Record<string, unknown>, result: c.text })),
        worksAlone: new Set(good.map((c) => c.tool)),
        sampleArgs: (t) => goodArgs(t.inputSchema),
        execute: async (t, args) => {
          const rec = await run(t, whyOf.get(t.name)!, 'chain', args);
          report.calls.push(rec);
          return rec;
        },
      }),
    );
    push(speedCheck(connectMs, listMs, report.calls, report.protocol?.transport === 'stdio'));
    push(leakCheck(report.calls, !!opts.stdio));
    }
    }
    // Resources and prompts: only a check when the server offers them.
    say({ kind: 'working', message: 'Opening resources and prompts' });
    const rp = await checkResourcesAndPrompts(client, timeoutMs, !!opts.stdio);
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
    // Without a tools feature the tool checks don't apply, so they aren't counted as untested.
    // "Tools work together" only counts when the server has chains to test.
    checksTotal: report.offersTools === false ? report.checks.filter((c) => c.id !== 'tools').length : CHECKS_TOTAL + report.checks.filter((c) => !CORE_CHECKS.has(c.id) && !(c.id === 'chains' && c.status === 'skip')).length,
    toolsRun: new Set(report.calls.filter((c) => !NOT_TESTED.has(c.outcome)).map((c) => c.tool)).size,
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

function protocolCheck(report: Report, stdoutJunk: string[] = []): CheckResult {
  const findings: Finding[] = [];
  // Be open about it: checking stdout means starting the program a second time, briefly.
  if (report.protocol?.transport === 'stdio')
    findings.push({ status: stdoutJunk.length ? 'warn' : 'pass', message: stdoutJunk.length ? 'Checked what the program prints by starting it once more for a moment' : 'Prints only MCP messages on stdout (checked by starting the program once more for a moment)' });
  if (stdoutJunk.length)
    findings.push({ status: 'warn', message: `The program prints text that isn't an MCP message where only MCP messages may go (stdout): "${stdoutJunk[0]}". Some AI apps fail to connect because of it. Print logs to stderr instead.` });
  const { era, version, transport } = report.protocol!;
  if (era === 'modern') findings.push({ status: 'pass', message: `Uses the latest MCP version (${version})` });
  else findings.push({ status: 'warn', message: `Uses an older MCP version (${version}). It works today, but it isn't on the July 2026 version (2026-07-28) yet.` });
  if (transport === 'sse') findings.push({ status: 'warn', message: 'Only speaks the old SSE connection type, which MCP is removing. Switch to Streamable HTTP.' });
  return check('protocol', 'Ready for the newest MCP version', 10, findings);
}

// Accepts any reply, so a malformed tool list can still be read and explained.
const PERMISSIVE = { '~standard': { version: 1, vendor: 'qamcp', validate: (value: unknown) => ({ value }) } };

// Separate tools AI apps can load from tools that break the MCP rules for a tool definition.
const MAX_PAGES = 50;

// Reads every page of the tool list, the way an AI app does, and notices a list that never ends.
async function listToolsPaged(client: Client, timeoutMs: number): Promise<{ tools: Tool[]; broken: { name: string; problem: string }[]; loop: boolean }> {
  const raw: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let loop = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: any = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} } as any, PERMISSIVE as any, { timeout: timeoutMs });
    if (Array.isArray(res?.tools)) raw.push(...res.tools);
    const next = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
    if (!next) return { ...splitRawTools({ tools: raw }), loop };
    if (seen.has(next)) {
      loop = true;
      break;
    }
    seen.add(next);
    cursor = next;
  }
  return { ...splitRawTools({ tools: raw }), loop: true };
}

export function splitRawTools(raw: any): { tools: Tool[]; broken: { name: string; problem: string }[] } {
  const tools: Tool[] = [];
  const broken: { name: string; problem: string }[] = [];
  for (const t of Array.isArray(raw?.tools) ? raw.tools : []) {
    const name = typeof t?.name === 'string' && t.name ? t.name : '(no name)';
    if (name === '(no name)') broken.push({ name, problem: 'has no name' });
    else if (!t.inputSchema || typeof t.inputSchema !== 'object') broken.push({ name, problem: 'has no input definition (inputSchema), which MCP requires on every tool' });
    else {
      // Exactly the rules the official client applies to each tool.
      const issue = toolIssue(t);
      if (issue) broken.push({ name, problem: `doesn't match the MCP tool format (${issue})` });
      else tools.push(t as Tool);
    }
  }
  return { tools, broken };
}

function toolIssue(t: unknown): string | undefined {
  const result: any = (specTypeSchemas as any).Tool['~standard'].validate(t);
  if (!result?.issues?.length) return undefined;
  const i = result.issues[0];
  const where = (i.path ?? []).map((p: any) => (typeof p === 'object' ? p.key : p)).join('.');
  return `${where ? where + ': ' : ''}${i.message}`;
}

function toolListCheck(tools: Tool[], broken: { name: string; problem: string }[] = [], loop = false, sdkProblem?: string): CheckResult {
  const findings: Finding[] = [];
  if (loop) findings.push({ status: 'warn', message: 'The tool list keeps pointing to the same next page, so it never ends. We stopped after the pages we had already seen.' });
  if (sdkProblem) findings.push({ status: 'fail', message: sdkProblem });
  for (const b of broken)
    findings.push({ status: 'fail', tool: b.name, message: `Breaks the tool list: ${b.problem}. AI apps may refuse to load this whole server because of it. We tested the other tools anyway.` });
  if (!tools.length && broken.length) return check('tools', 'Lists its tools', 10, [...findings, { status: 'fail', message: 'None of its tools can be used' }]);
  if (!tools.length) return check('tools', 'Lists its tools', 10, [...findings, { status: 'warn', message: 'Has the tools feature, but offers no tools right now' }]);
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

// An input counts as described if it, or the shared definition it points to ($ref), has a description.
function describedInput(prop: any, root: any, depth = 0): boolean {
  if (prop?.description?.trim()) return true;
  // A list or object whose inner fields are all described explains itself.
  const inner = prop?.type === 'array' ? prop.items : prop;
  const fields = inner?.properties && typeof inner.properties === 'object' ? Object.values(inner.properties) : [];
  if (fields.length && depth < 5 && fields.every((f: any) => describedInput(f, root, depth + 1))) return true;
  const ref = typeof prop?.$ref === 'string' && prop.$ref.startsWith('#/') ? prop.$ref : undefined;
  if (!ref || depth > 5) return false;
  const target = ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  return describedInput(target, root, depth + 1);
}

function descriptionCheck(tools: Tool[]): CheckResult {
  const findings: Finding[] = [];
  for (const t of tools) {
    const desc = t.description?.trim() ?? '';
    if (!desc) findings.push({ status: 'fail', tool: t.name, message: 'Has no description, so the AI has to guess what it does' });
    // CJK scripts say in 1 character what English says in a word, so they get a lower bar.
    else if (desc.length < (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(desc) ? 8 : 20)) findings.push({ status: 'warn', tool: t.name, message: `Description is very short (${desc.length} characters)` });
    else if (desc.length > 4000) findings.push({ status: 'warn', tool: t.name, message: `Description is very long (${desc.length} characters), which uses up the AI's memory` });

    const props: Record<string, any> = (t.inputSchema as any)?.properties ?? {};
    const undocumented = Object.keys(props).filter((k) => !describedInput(props[k], t.inputSchema));
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
    else if (c.outcome === 'ok' && c.text.length > BIG_ANSWER) findings.push({ status: 'warn', tool: c.tool, message: `Answered with about ${Math.round(c.text.length / 1000)} KB of text. Many AI apps cut off tool answers this big, so the AI may never see the end of it.` });
    else if (c.outcome === 'ok') findings.push({ status: 'pass', tool: c.tool, message: `Worked (${fmtMs(c.ms)})` });
    else if (c.outcome === 'tool-error' || c.outcome === 'protocol-error') findings.push({ status: 'pass', tool: c.tool, message: `Answered with an error, probably because of our sample input: ${short(c.text)}` });
    else if (c.outcome === 'timeout') findings.push({ status: 'fail', tool: c.tool, message: `No answer within the time limit` });
    else if (c.outcome === 'needs-login') findings.push({ status: 'skip', tool: c.tool, message: 'Needs you to sign in, so it was not tested (not counted against the server)' });
    else if (c.outcome === 'rate-limited') findings.push({ status: 'skip', tool: c.tool, message: 'The server limited our requests (HTTP 429), so it was not tested (not counted against the server)' });
    else if (c.outcome === 'unclear') findings.push({ status: 'skip', tool: c.tool, message: c.reason ? `Not tested: ${c.reason}` : `Got an error we could not interpret, so it was not counted: ${short(c.text)}` });
    else if (c.outcome === 'unavailable') findings.push({ status: 'warn', tool: c.tool, message: 'The server said it was temporarily unavailable (HTTP 503)' });
    else if (c.outcome === 'bad-reply') findings.push({ status: 'fail', tool: c.tool, message: `Its reply breaks the MCP rules, so AI apps can't read it: ${c.reason}` });
    else findings.push({ status: 'fail', tool: c.tool, message: `Crashed: ${c.reason ?? short(c.text)}` });
  }
  for (const s of skipped) findings.push({ status: 'skip', tool: s.tool, message: `Not run: ${s.why}` });
  const tested = good.filter((c) => !NOT_TESTED.has(c.outcome)).length;
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
    else if (c.outcome === 'rate-limited') findings.push({ status: 'skip', tool: c.tool, message: 'The server limited our requests, so bad inputs were not tested' });
    else if (c.outcome === 'unclear') findings.push({ status: 'skip', tool: c.tool, message: c.reason ? `Bad inputs not tested: ${c.reason}` : 'Got errors we could not interpret, so bad inputs were not counted' });
    else if (c.outcome === 'unavailable') findings.push({ status: 'warn', tool: c.tool, message: `Said it was temporarily unavailable (HTTP 503) on ${what}` });
    else if (c.outcome === 'bad-reply') findings.push({ status: 'fail', tool: c.tool, message: `Broke the MCP rules on ${what}: ${c.reason}` });
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

  const timed = calls.filter((c) => c.kind === 'good-input' && (c.outcome === 'ok' || c.outcome === 'tool-error' || c.outcome === 'protocol-error'));
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

function leakCheck(calls: ToolCallRecord[], local = false): CheckResult {
  const findings: Finding[] = [];
  // Only error answers are scanned: normal answers from docs servers often contain example keys on purpose.
  for (const c of calls.filter((c) => c.outcome !== 'ok')) {
    // Report everything one message gives away, not just the first thing found.
    const secret = firstMatch(c.text, SECRET_PATTERNS);
    if (secret) findings.push({ status: 'fail', tool: c.tool, message: `Error message shows what looks like ${/^[aeiou]/i.test(secret) ? 'an' : 'a'} ${secret}` });
    // A program on your own computer showing your own folders isn't leaking anything.
    const internal = local ? [] : allMatches(c.text, INTERNAL_PATTERNS);
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
    const ms = Date.now() - started;
    if (!result.isError && kind === 'good-input') {
      const broke = await outputSchemaProblem(tool, result);
      if (broke) return { tool: tool.name, why, kind, arguments: args, ms, outcome: 'bad-reply', text: resultText(result), reason: broke };
    }
    return { tool: tool.name, why, kind, arguments: args, ms, outcome: result.isError ? 'tool-error' : 'ok', text: resultText(result) };
  } catch (err) {
    // A failure needs evidence: see classifyError. Unknown errors are "unclear", never a crash.
    const e = classifyError(err);
    const base = { tool: tool.name, why, kind, arguments: args, ms: Date.now() - started, ...(e.status ? { status: e.status } : {}) };
    switch (e.kind) {
      case 'timeout':
        return { ...base, outcome: 'timeout', text: '' };
      case 'refused':
        return { ...base, outcome: 'protocol-error', text: e.message || e.text, ...(e.status ? { note: `sent with HTTP ${e.status} instead of a normal MCP reply` } : {}) };
      case 'server-error':
        return { ...base, outcome: 'crash', text: e.text, reason: `server error (HTTP ${e.status})` };
      case 'dropped':
        return { ...base, outcome: 'crash', text: e.text, reason: 'the connection was cut before an answer' };
      case 'bad-reply':
        return { ...base, outcome: 'bad-reply', text: e.text, reason: badReplyWords(e.text) };
      default:
        return { ...base, outcome: e.kind, text: e.text };
    }
  }
}

// The spec: if a tool declares an outputSchema, its structured result MUST conform to it.
async function outputSchemaProblem(tool: Tool, result: any): Promise<string | undefined> {
  const schema = (tool as any).outputSchema;
  if (!schema || typeof schema !== 'object') return undefined;
  if (result.structuredContent === undefined) return 'it promised a structured answer (outputSchema) but sent none';
  let validator;
  try {
    validator = fromJsonSchema(schema);
  } catch {
    return undefined; // a schema we can't read is reported with the descriptions, not here
  }
  const v: any = await validator['~standard'].validate(result.structuredContent);
  if (!v?.issues?.length) return undefined;
  return `its structured answer doesn't match its own output schema (${schemaIssueWords(v.issues.map((i: any) => String(i.message)).join(', '))})`;
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

function needsLogin(err: unknown): boolean {
  const status = (err as any)?.data?.status ?? (err as any)?.status;
  return (err instanceof SdkError && (err.code === SdkErrorCode.ClientHttpAuthentication || err.code === SdkErrorCode.ClientHttpForbidden)) || status === 401 || status === 403;
}

// A login asked for in words rather than with a 401 (e.g. JSON-RPC error -32001 "Authentication required").
const LOGIN_WORDS = /\b(?:auth(?:entication|orization) (?:is )?required|unauthori[sz]ed|not authenticated|(?:sign|log)[ -]?in (?:is )?required|please (?:sign|log) ?in|api key (?:is )?(?:required|missing)|missing (?:api )?key|connect your [\w ]{1,30}account)\b/i;
function listNeedsLogin(err: unknown): boolean {
  return needsLogin(err) || LOGIN_WORDS.test(errText(err));
}

// The server's own message inside an SDK error, when there is one.
function serverSaid(err: unknown): string {
  const t = errText(err);
  return t.match(/"message":"((?:[^"\\]|\\.)*)"/)?.[1] ?? t;
}

// Plain words for why the tool list couldn't be read.
export function toolListError(raw: string): string {
  if (/missing required resultType/i.test(raw))
    return `The server says it supports the newest MCP version (2026-07-28), but its tool list reply is missing the "resultType" field that version requires, so AI apps on that version can't load its tools`;
  // Only the 2026-07-28 rules check the reply's fields like this, so the server claimed that version.
  const missing = missingResultFields(raw);
  if (missing.length)
    return `The server says it supports the newest MCP version (2026-07-28), but its tool list reply is missing ${missing.map((m) => `"${m}"`).join(' and ')}, which that version requires, so AI apps on that version can't load its tools`;
  return `Asking for the tool list failed: ${short(raw, 160)}`;
}

// "Invalid result for tools/list: [ { "path": [ "ttlMs" ], "message": "... received undefined" } ]" → ["ttlMs"]
export function missingResultFields(raw: string): string[] {
  const list = raw.match(/Invalid result for [\w/]+: (\[[\s\S]*\])/)?.[1];
  if (!list) return [];
  try {
    const issues = JSON.parse(list) as { path?: unknown[]; message?: string }[];
    return [...new Set(issues.filter((i) => Array.isArray(i.path) && i.path.length && /received undefined/.test(i.message ?? '')).map((i) => i.path!.join('.')))];
  } catch {
    return [];
  }
}

function explainConnectError(err: unknown, isProgram = false): string {
  const said = (err as any)?.programOutput as string | undefined;
  if (isProgram && said) return `The program stopped before it could connect. Its last message: "${said}"`;
  if (isProgram && /Connection closed|ENOENT|spawn/i.test(errText(err))) return 'The program stopped before it could connect, without saying why. Check the command runs on its own.';
  const version = errText(err).match(/protocol version is not supported:\s*(\S+)/i)?.[1];
  if (version) return `The server answered with MCP version "${version}", which AI apps don't support, so they refuse to connect.`;
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
  const http = httpStatus(err);
  if (http === 404) return 'Nothing at this address (HTTP 404). Check the link: MCP servers usually live at an address ending in /mcp.';
  if (http) return `The server answered with an error (HTTP ${http}) instead of connecting.`;
  if (/bad port/i.test(msg)) return 'That port is blocked for web requests. Use a different port.';
  return `Could not connect: ${short(errText(err).replace(/\s*\{"cause".*$/s, ''))}`;
}

// The HTTP status behind a failed connection, in any of the shapes it reaches us:
// "HTTP 404", "status 404", or the SDK's JSON {"status":404,…}.
function httpStatus(err: unknown): number | undefined {
  const direct = (err as any)?.data?.status ?? (err as any)?.status;
  if (typeof direct === 'number') return direct;
  const m = [errText(err), ...causes(err)].join(' ').match(/(?:status|HTTP)"?\s*[: ]\s*(\d{3})\b/i);
  return m ? Number(m[1]) : undefined;
}

// When a link without /mcp gets 404, does …/mcp answer like an MCP server? Any reply except
// "not found" counts (a login wall included); nothing is sent but an MCP hello.
async function mcpPathAnswers(url: string, fetchImpl: typeof fetch | undefined, timeoutMs: number): Promise<string | undefined> {
  let alt: string;
  try {
    const u = new URL(url);
    if (/\/mcp\/?$/.test(u.pathname)) return undefined;
    u.pathname = u.pathname.replace(/\/?$/, '/mcp');
    alt = u.toString();
  } catch {
    return undefined;
  }
  try {
    const res = await (fetchImpl ?? fetch)(alt, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'qamcp', version: '1' } } }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
    });
    await res.body?.cancel().catch(() => {});
    const type = res.headers.get('content-type') ?? '';
    const looksMcp = res.ok ? /json|event-stream/i.test(type) : res.status === 401 || res.status === 403;
    return looksMcp ? alt : undefined;
  } catch {
    return undefined;
  }
}

// Codes and messages of the errors underneath this one.
function causes(err: unknown): string[] {
  const out: string[] = [];
  let e: any = (err as any)?.cause;
  for (let i = 0; e && i < 6; i++, e = e.cause) out.push(String(e.code ?? ''), String(e.message ?? ''));
  return out;
}

const RATE_LIMIT_WAIT_MS = 3_000;

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function short(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one || '(no message)';
}
