import { Client, SdkError, SdkErrorCode, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FileOAuthProvider, waitForLoginRedirect } from './oauth.js';

// A server that runs as a program on this machine, like "npx -y some-server".
export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface Connection {
  client: Client;
  transport: 'streamable-http' | 'sse' | 'stdio';
  ms: number;
  loggedIn?: boolean;
  programOutput?: () => string; // stdio only: the last things the program wrote to stderr
}

export interface LoginOptions {
  // Called with the service's login page; the CLI opens it in the browser.
  onLoginUrl: (url: URL) => void;
}

const CLIENT_INFO = { name: 'qamcp', version: '0.1.0' };

// Connect the way a modern AI app would: try the current transport first
// (with 2026-07-28 negotiation and fallback to older versions), then the
// deprecated SSE transport for servers that only speak that.
// fetchImpl: the website passes a guarded fetch that refuses private network addresses.
// authProvider: a login already completed elsewhere (the website), used as is.
export async function connect(url: string, headers: Record<string, string>, timeoutMs: number, login?: LoginOptions, fetchImpl?: typeof fetch, stdio?: StdioTarget, authProvider?: OAuthClientProvider): Promise<Connection> {
  if (stdio) return connectStdio(stdio, timeoutMs);
  const requestInit: RequestInit = { headers };
  if (login) return connectWithLogin(url, requestInit, timeoutMs, login, fetchImpl);
  if (authProvider) {
    const started = Date.now();
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
    await withDeadline(client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit, authProvider, fetch: fetchImpl }), { timeout: timeoutMs }), timeoutMs, client);
    return { client, transport: 'streamable-http', ms: Date.now() - started, loggedIn: true };
  }
  const started = Date.now();

  try {
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
    await withDeadline(client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit, fetch: fetchImpl }), { timeout: timeoutMs }), timeoutMs, client);
    return { client, transport: 'streamable-http', ms: Date.now() - started };
  } catch (httpError) {
    try {
      const client = new Client(CLIENT_INFO);
      await withDeadline(client.connect(new SSEClientTransport(new URL(url), { requestInit, fetch: fetchImpl }), { timeout: timeoutMs }), timeoutMs, client);
      return { client, transport: 'sse', ms: Date.now() - started };
    } catch {
      // The SSE attempt is only a fallback; the first error is the one worth showing.
      throw httpError;
    }
  }
}

// The SDK's time limit covers each request, but not every wait while connecting: the old SSE
// connection can wait forever for its first message. So each attempt also gets a hard deadline.
function withDeadline<T>(attempt: Promise<T>, timeoutMs: number, client: Client): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void client.close().catch(() => {});
      reject(new SdkError(SdkErrorCode.RequestTimeout, `Connecting took longer than ${Math.round((timeoutMs + 5_000) / 1000)} s`));
    }, timeoutMs + 5_000);
  });
  return Promise.race([attempt, late]).finally(() => clearTimeout(timer));
}

// Start the program and talk to it over its standard input and output.
async function connectStdio(target: StdioTarget, timeoutMs: number): Promise<Connection> {
  const started = Date.now();
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    env: target.env ? { ...getDefaultEnvironment(), ...target.env } : undefined,
    cwd: target.cwd,
    stderr: 'pipe', // not part of the protocol, but it's where a program says why it stopped
  });
  let output = '';
  transport.stderr?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (err) {
    // Give the person the program's own words: usually "X is required" or a stack trace.
    if (err && typeof err === 'object') (err as any).programOutput = lastWords(output);
    throw err;
  }
  return { client, transport: 'stdio', ms: Date.now() - started, programOutput: () => lastWords(output) };
}

// The last meaningful line a program printed, for a plain message.
export function lastWords(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !/^at\s|^\s*\^|^node:internal|^Node\.js v/.test(l));
  return (meaningful.at(-1) ?? lines.at(-1) ?? '').slice(0, 200);
}

// The MCP rules: a program MUST NOT write anything but MCP messages on stdout. The official
// client quietly skips such lines, but some AI apps fail to connect because of them, so start
// the program once more and look at exactly what it prints before its first reply.
export async function stdoutNoise(target: StdioTarget, timeoutMs = 15_000): Promise<string[]> {
  // The same launcher the official SDK uses, so commands like npx work on Windows too.
  const spawn: any = ((await import('cross-spawn')) as any).default;
  return new Promise((resolve) => {
    const noise: string[] = [];
    let buffer = '';
    let done = false;
    const child = spawn(target.command, target.args ?? [], {
      env: target.env ? { ...getDefaultEnvironment(), ...target.env } : (getDefaultEnvironment() as NodeJS.ProcessEnv),
      cwd: target.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(noise);
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on('error', finish);
    child.on('exit', finish);
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let isMcp = false;
        try {
          isMcp = JSON.parse(line)?.jsonrpc === '2.0';
        } catch {
          // not JSON
        }
        if (!isMcp) noise.push(line.slice(0, 160));
        else if (JSON.parse(line).id === 1) return finish(); // its first real reply: we've seen enough
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'qamcp', version: '0.1.0' } } }) + '\n');
  });
}

// Same, but if the server asks for a login, send the person to its login page,
// wait for them to approve, then connect again with the token. A saved login is
// reused, so the browser only opens the first time (or when the login expires).
async function connectWithLogin(url: string, requestInit: RequestInit, timeoutMs: number, login: LoginOptions, fetchImpl?: typeof fetch): Promise<Connection> {
  let redirect: ReturnType<typeof waitForLoginRedirect> | undefined;
  const provider = new FileOAuthProvider(url, (loginUrl) => {
    redirect = waitForLoginRedirect(provider.expectedState);
    login.onLoginUrl(loginUrl);
  });
  const transport = () => new StreamableHTTPClientTransport(new URL(url), { requestInit, authProvider: provider, fetch: fetchImpl });

  const first = transport();
  let started = Date.now();
  try {
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
    await client.connect(first, { timeout: timeoutMs });
    return { client, transport: 'streamable-http', ms: Date.now() - started, loggedIn: true };
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !redirect) {
      redirect?.close();
      throw err;
    }
  }

  const params = await redirect.done;
  await first.finishAuth(params);
  // A started transport can't be reused: connect again on a fresh one, now with the token.
  started = Date.now();
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport(), { timeout: timeoutMs });
  return { client, transport: 'streamable-http', ms: Date.now() - started, loggedIn: true };
}
