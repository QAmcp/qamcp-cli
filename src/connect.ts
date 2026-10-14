import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
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
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit, authProvider, fetch: fetchImpl }), { timeout: timeoutMs });
    return { client, transport: 'streamable-http', ms: Date.now() - started, loggedIn: true };
  }
  const started = Date.now();

  try {
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit, fetch: fetchImpl }), { timeout: timeoutMs });
    return { client, transport: 'streamable-http', ms: Date.now() - started };
  } catch (httpError) {
    try {
      const client = new Client(CLIENT_INFO);
      await client.connect(new SSEClientTransport(new URL(url), { requestInit, fetch: fetchImpl }), { timeout: timeoutMs });
      return { client, transport: 'sse', ms: Date.now() - started };
    } catch {
      // The SSE attempt is only a fallback; the first error is the one worth showing.
      throw httpError;
    }
  }
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
    stderr: 'ignore', // the program's log lines are not part of the protocol
  });
  await client.connect(transport, { timeout: timeoutMs });
  return { client, transport: 'stdio', ms: Date.now() - started };
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
