import type { LoginOptions, StdioTarget } from './connect.js';
import type { ScoreCap } from './score.js';
import type { RunReason, SafetyMode } from './toolSafety.js';

// Every check gives a hard-fact result. No opinions, no AI grading.
export type Status = 'pass' | 'warn' | 'fail' | 'skip';

export interface Finding {
  status: Status;
  message: string; // plain words, e.g. "search_orders took 3.1 s"
  tool?: string;
}

export interface CheckResult {
  id: string;
  title: string; // plain words, e.g. "Bad inputs give a clean error"
  status: Status;
  summary: string;
  findings: Finding[];
  weight: number; // how much this check counts toward the score
  points?: number; // 0..1 share of the weight earned, for checks measured as a percentage (otherwise from status)
}

export interface ToolCallRecord {
  tool: string;
  kind: 'good-input' | 'bad-input';
  why: RunReason; // why we were allowed to run it
  arguments: unknown;
  ms: number;
  // ok / tool-error / protocol-error: the tool answered (an error here is a deliberate "no")
  // timeout, crash (server error or dropped connection), bad-reply (broke the MCP rules): the tool failed
  // needs-login, rate-limited, unclear: not really tested, so never counted against the server
  // unavailable: the server said it was temporarily down
  outcome: 'ok' | 'tool-error' | 'protocol-error' | 'timeout' | 'crash' | 'bad-reply' | 'needs-login' | 'rate-limited' | 'unavailable' | 'unclear';
  status?: number; // HTTP status, when the tool call failed at the HTTP level
  reason?: string; // plain words for a failure
  text: string; // everything the server sent back, flattened to text (used for the secrets scan)
  note?: string; // something unusual about how the server answered
}

export interface Report {
  url: string;
  testedAt: string;
  score: number;
  testedAs?: { safety: string; loggedIn: boolean }; // which tools we allowed, and whether we were logged in
  notScored?: string; // set when we could not score at all for a reason that is not the server's fault (e.g. login wall)
  scoreBeforeCaps?: number;
  scoreCaps?: ScoreCap[]; // serious problems that put a ceiling on the score
  server?: { name?: string; version?: string };
  protocol?: { era?: string; version?: string; transport: 'streamable-http' | 'sse' | 'stdio' };
  toolCount: number;
  // How much we could actually test. A score is only as good as its coverage.
  coverage: { checksRun: number; checksTotal: number; toolsRun: number; toolsTotal: number };
  skippedTools: { tool: string; why: string }[];
  checks: CheckResult[];
  calls: ToolCallRecord[];
  toolboxHash?: string; // fingerprint of every tool's description and inputs
  toolFingerprints?: Record<string, string>; // per tool, to see exactly which tool changed
  dataFlow?: { summary: string }; // one plain sentence: what was sent where
}

export interface TestOptions {
  headers?: Record<string, string>;
  // Which tools we may run. Default 'labeled'. 'owner' and 'all' are only for someone who owns the server.
  safety?: SafetyMode;
  timeoutMs?: number;
  login?: LoginOptions; // set to allow "Log in with…" (OAuth) when the server asks for it
  authProvider?: import('@modelcontextprotocol/client').OAuthClientProvider; // a login completed on the website
  onProgress?: (e: ProgressEvent) => void; // live updates while the test runs
  fetch?: typeof fetch; // the website passes a guarded fetch that refuses private addresses
  stdio?: StdioTarget; // test a program on this machine instead of a link. Never offered by the website.
  extraChecks?: ExtraCheck[]; // checks plugged in by another app, run after the built-in ones
}

// A check another app can plug in. Gets the connected server and the report so far.
export type ExtraCheck = (ctx: {
  client: import('@modelcontextprotocol/client').Client;
  tools: import('@modelcontextprotocol/client').Tool[];
  report: Report;
  timeoutMs: number;
  say: (e: ProgressEvent) => void;
}) => Promise<CheckResult | null>;

// Live updates while a test runs: a note before each slow part, and each check as it finishes.
export type ProgressEvent =
  | { kind: 'working'; message: string }
  | { kind: 'check'; id: string; title: string; status: Status; summary: string };
