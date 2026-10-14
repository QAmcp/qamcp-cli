// Command-line options for QAmcp. Kept separate from cli.ts so it can be tested.

export const USAGE = `Usage:
  qamcp <server-link> [options]            test a server on the internet
  qamcp --stdio "<command>" [options]      test a server that runs as a program on this computer

What to test
  --header "Name: value"     send a header, e.g. "Authorization: Bearer abc123" (can repeat)
  --stdio "<command>"        start this program and test it, e.g. --stdio "npx -y @acme/mcp-server"
  --env NAME=value           environment variable for the --stdio program (can repeat)
  --cwd <folder>             folder to start the --stdio program in
  --login                    if the server needs a login, open its login page in your browser
  --timeout <seconds>        time limit per request (default 20)

Which tools may run
  --owner                    I own this server: also run unlabeled tools whose names clearly only read
  --run-unlabeled            I own this server: run every tool not named or labeled dangerous (your own risk)

For CI (run on every change)
  --fail-under <score>       exit 1 if the score is below this
  --fail-on-fail             exit 1 if any check failed
  --baseline <file.json>     compare with a saved report; exit 1 if the score dropped or a check got worse
  --max-drop <points>        how far the score may fall below the baseline (default 5)
  --save-baseline <file>     save this report to use as a baseline next time
  --junit <file.xml>         write a JUnit XML report
  --markdown <file.md>       write a short report for pull-request comments
  --json <file.json>         write the full report

Exit codes: 0 fine · 1 a CI gate failed · 2 wrong options · 3 could not test (server down or needs a login)

QAmcp sends nothing anywhere except to the server you test. No AI, no tracking.`;

export interface Args {
  url?: string;
  stdio?: { command: string; args: string[]; env: Record<string, string>; cwd?: string };
  headers: Record<string, string>;
  safety: 'labeled' | 'owner' | 'all';
  timeoutMs?: number;
  login: boolean;
  failUnder?: number;
  failOnFail: boolean;
  baseline?: string;
  maxDrop: number;
  saveBaseline?: string;
  junit?: string;
  markdown?: string;
  json?: string;
  help: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const a: Args = { headers: {}, safety: 'labeled', login: false, failOnFail: false, maxDrop: 5, help: false };
  let stdioLine: string | undefined;
  const env: Record<string, string> = {};
  let cwd: string | undefined;
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  const num = (i: number, flag: string) => {
    const n = Number(need(i, flag));
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} needs a number.`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--header': {
        const v = need(++i, f);
        const idx = v.indexOf(':');
        if (idx < 1) throw new UsageError('--header needs "Name: value".');
        a.headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim();
        break;
      }
      case '--stdio': stdioLine = need(++i, f); break;
      case '--env': {
        const v = need(++i, f);
        const idx = v.indexOf('=');
        if (idx < 1) throw new UsageError('--env needs NAME=value.');
        env[v.slice(0, idx)] = v.slice(idx + 1);
        break;
      }
      case '--cwd': cwd = need(++i, f); break;
      case '--login': a.login = true; break;
      case '--timeout': a.timeoutMs = num(++i, f) * 1000; break;
      case '--owner': a.safety = 'owner'; break;
      case '--run-unlabeled': a.safety = 'all'; break;
      case '--fail-under': a.failUnder = num(++i, f); break;
      case '--fail-on-fail': a.failOnFail = true; break;
      case '--baseline': a.baseline = need(++i, f); break;
      case '--max-drop': a.maxDrop = num(++i, f); break;
      case '--save-baseline': a.saveBaseline = need(++i, f); break;
      case '--junit': a.junit = need(++i, f); break;
      case '--markdown': a.markdown = need(++i, f); break;
      case '--json': a.json = need(++i, f); break;
      case '--help': case '-h': a.help = true; break;
      default:
        if (f.startsWith('--')) throw new UsageError(`Unknown option ${f}.`);
        if (a.url) throw new UsageError(`Only one server link at a time (got "${a.url}" and "${f}").`);
        a.url = f;
    }
  }
  if (a.help) return a;

  if (stdioLine !== undefined) {
    if (a.url) throw new UsageError('Give either a server link or --stdio, not both.');
    const parts = shellSplit(stdioLine);
    if (!parts.length) throw new UsageError('--stdio needs a command.');
    a.stdio = { command: parts[0], args: parts.slice(1), env, cwd };
    if (a.login) throw new UsageError('--login is for servers on the internet, not --stdio programs.');
  } else {
    if (!a.url) throw new UsageError('Give a server link, or --stdio "<command>".');
    try {
      const u = new URL(a.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      throw new UsageError(`"${a.url}" is not a valid http or https link.`);
    }
    if (Object.keys(env).length || cwd) throw new UsageError('--env and --cwd are for --stdio programs.');
  }
  return a;
}

// "npx -y @acme/server --flag 'two words'" → ["npx", "-y", "@acme/server", "--flag", "two words"]
export function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new UsageError('A quote in --stdio was never closed.');
  if (has || cur) out.push(cur);
  return out;
}
