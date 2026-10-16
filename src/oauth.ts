// "Log in with…" (OAuth) for servers that need it, the way the MCP spec describes.
//
// The official SDK does the hard parts (finding the login server, registering us,
// PKCE, swapping the code for a token). We supply:
//   - a place to keep the login (.qamcp/auth/, never committed),
//   - opening the person's browser on the login page,
//   - a tiny local web page that catches the "approved" redirect.
//
// We never see the person's password: they type it on the service's own login page.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const DIR = join('.qamcp', 'auth');
// Fixed so the address we register with the login server stays the same between runs.
export const CALLBACK_PORT = 33418;
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

interface Saved {
  clients: Record<string, StoredOAuthClientInformation>; // per login server (issuer)
  tokens: Record<string, StoredOAuthTokens>; // per login server (issuer)
  lastIssuer?: string;
  discovery?: OAuthDiscoveryState;
}

function fileFor(serverUrl: string): string {
  const u = new URL(serverUrl);
  return join(DIR, (u.host + u.pathname).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json');
}

export class FileOAuthProvider implements OAuthClientProvider {
  private saved: Saved;
  private verifier = '';
  readonly expectedState = randomBytes(16).toString('hex');

  constructor(
    private readonly serverUrl: string,
    private readonly openLoginPage: (url: URL) => void,
  ) {
    try {
      this.saved = JSON.parse(readFileSync(fileFor(serverUrl), 'utf8'));
    } catch {
      this.saved = { clients: {}, tokens: {} };
    }
  }

  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'QAmcp tester',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    } as OAuthClientMetadata;
  }

  state() {
    return this.expectedState;
  }

  clientInformation(ctx?: OAuthClientInformationContext) {
    return ctx?.issuer ? this.saved.clients[ctx.issuer] : undefined;
  }

  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
    if (ctx?.issuer) this.saved.clients[ctx.issuer] = info;
    this.persist();
  }

  tokens(ctx?: OAuthClientInformationContext) {
    // With no ctx the transport is asking for the current token: give the latest one.
    const issuer = ctx?.issuer ?? this.saved.lastIssuer;
    return issuer ? this.saved.tokens[issuer] : undefined;
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
    const issuer = ctx?.issuer ?? this.saved.lastIssuer ?? 'default';
    this.saved.tokens[issuer] = tokens;
    this.saved.lastIssuer = issuer;
    this.persist();
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.saved.discovery = state;
    this.persist();
  }

  discoveryState() {
    return this.saved.discovery;
  }

  redirectToAuthorization(url: URL) {
    this.openLoginPage(url);
  }

  saveCodeVerifier(v: string) {
    this.verifier = v;
  }

  codeVerifier() {
    return this.verifier;
  }

  private persist() {
    mkdirSync(DIR, { recursive: true });
    // The folder ignores itself, so a login saved inside someone's project can't be committed by accident.
    const ignore = join('.qamcp', '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '# QAmcp keeps saved logins here. Never commit them.\n*\n');
    writeFileSync(fileFor(this.serverUrl), JSON.stringify(this.saved, null, 2), { mode: 0o600 });
  }
}

// Waits for the login server to send the browser back to us. Resolves with the
// callback's query (code, state, iss…) once, then closes.
export function waitForLoginRedirect(expectedState: string, timeoutMs = 5 * 60_000): { done: Promise<URLSearchParams>; close: () => void } {
  let server: Server;
  const done = new Promise<URLSearchParams>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes.'));
    }, timeoutMs);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URL);
      if (url.pathname !== '/callback') return res.writeHead(404).end();
      const params = url.searchParams;
      const ok = params.get('state') === expectedState && params.has('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      // Never echo the login server's error text into the page.
      res.end(ok ? '<h1>Logged in.</h1><p>You can close this tab and go back to QAmcp.</p>' : '<h1>Login did not complete.</h1><p>Go back to QAmcp and try again.</p>');
      clearTimeout(timer);
      server.close();
      if (ok) resolve(params);
      else reject(new Error(params.get('state') !== expectedState ? 'Login reply did not match our request (state mismatch).' : 'Login was cancelled or refused.'));
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the local login page on port ${CALLBACK_PORT}: ${err.message}`));
    });
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
  return { done, close: () => server?.close() };
}

// Opens the login page in the person's normal browser.
export function openInBrowser(url: URL): void {
  const href = url.toString();
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
    : process.platform === 'darwin' ? ['open', [href]]
    : ['xdg-open', [href]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
