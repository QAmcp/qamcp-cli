// "Is the server's login set up the way AI apps need it?"
//
// A server that needs a login must tell AI apps where to log in (RFC 9728), and the login
// server must describe itself (RFC 8414) in the way MCP clients require (PKCE with S256, a way
// to register). Many "login doesn't work" reports are really mistakes in this setup. Every
// finding here is read straight from the server's own public login documents, so it is a
// fact the owner can verify, and we never log in or use anyone's account.

import { checkResourceAllowed } from '@modelcontextprotocol/client';
import type { CheckResult, Finding, Status } from './types.js';

export interface SetupOptions {
  fetch?: typeof fetch; // the website passes a guarded fetch
  timeoutMs?: number;
}

const MAX_BYTES = 200_000;

// Returns null when the server doesn't ask for a login (nothing to check).
export async function checkLoginSetup(serverUrl: string, opts: SetupOptions = {}): Promise<CheckResult | null> {
  const f = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 10_000;
  const get = async (url: string, init?: RequestInit) => {
    const res = await f(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json', ...(init?.headers as object) } });
    const text = (await res.text()).slice(0, MAX_BYTES);
    return { res, text };
  };

  // 1. Knock without credentials: does the server ask for a login?
  let challenge: string | null;
  try {
    const { res } = await get(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qamcp-login-check', version: '0.1.0' } } }),
    });
    if (res.status !== 401) return null;
    challenge = res.headers.get('www-authenticate');
  } catch {
    return null;
  }

  const findings: Finding[] = [];
  const add = (status: Status, message: string) => findings.push({ status, message });
  add('pass', 'The server asks for a login (it answers 401 to an anonymous request).');

  const server = new URL(serverUrl);
  const params = parseChallenge(challenge);
  if (challenge && !/^\s*bearer/i.test(challenge)) add('warn', `The 401 reply's WWW-Authenticate header doesn't start with "Bearer" (it says "${challenge.slice(0, 40)}"), which AI apps expect.`);

  // 2. Where does the server say the login server is? (header first, then the well-known address)
  const candidates: string[] = [];
  if (params.resource_metadata) candidates.push(params.resource_metadata);
  const pathPart = server.pathname === '/' ? '' : server.pathname.replace(/\/$/, '');
  candidates.push(`${server.origin}/.well-known/oauth-protected-resource${pathPart}`);
  if (pathPart) candidates.push(`${server.origin}/.well-known/oauth-protected-resource`);

  let prm: any;
  let prmUrl: string | undefined;
  for (const url of [...new Set(candidates)]) {
    try {
      const { res, text } = await get(url);
      if (!res.ok) continue;
      const json = JSON.parse(text);
      if (json && typeof json === 'object') {
        prm = json;
        prmUrl = url;
        break;
      }
    } catch {
      // try the next place
    }
  }
  // Older MCP versions (March 2025) had no resource details: AI apps look for the login server
  // at the MCP server's own address instead. Still supported, so that's a warning, not a failure.
  let legacy = false;
  if (!prm) {
    legacy = true;
    add('warn', `Uses the older login setup from the March 2025 MCP version: nothing is published at ${server.origin}/.well-known/oauth-protected-resource, so AI apps fall back to looking for the login server at ${server.origin}. Most still do, but newer ones may not.`);
  }
  if (legacy) {
    // skip the resource checks: there is no resource description
  } else if (params.resource_metadata) add('pass', 'The 401 reply points AI apps to the login details (resource_metadata).');
  else add('warn', `The 401 reply doesn't include a "resource_metadata" pointer. The details were found at ${prmUrl}, but some AI apps only follow the pointer.`);

  // 3. The resource must name this server.
  if (legacy) {
    // nothing to compare
  } else if (typeof prm.resource !== 'string') {
    add('fail', 'The login details have no "resource" field, which says which server they describe.');
  } else {
    // The same rule AI apps built on the official MCP SDK use: same address, and the server's
    // path starts with the resource's path (so a parent address is fine).
    const allowed = checkResourceAllowed({ requestedResource: serverUrl, configuredResource: prm.resource });
    if (!allowed && canon(prm.resource) === canon(serverUrl))
      add('fail', `The login details name the server as "${prm.resource}" but its address is "${serverUrl}". They differ only by a trailing slash, and AI apps built on the official MCP SDK reject that.`);
    else if (!allowed) add('fail', `The login details say they are for "${prm.resource}", but the server is at "${serverUrl}". AI apps refuse to log in when these differ.`);
    else if (prm.resource === serverUrl) add('pass', 'The login details name this exact server.');
    else add('pass', `The login details name "${prm.resource}", a parent of the server's address, which AI apps accept.`);
  }

  const servers: unknown = legacy ? [server.origin] : prm.authorization_servers;
  if (!Array.isArray(servers) || !servers.length || !servers.every((s) => typeof s === 'string')) {
    add('fail', 'The login details have no "authorization_servers" list, so AI apps don\'t know where to log in.');
    return result(findings);
  }

  // 4. The login server's own description.
  const issuer = servers[0] as string;
  if (servers.length > 1) add('pass', `It lists ${servers.length} login servers; the first one (${issuer}) was checked.`);
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    add('fail', `The login server "${issuer}" is not a valid address.`);
    return result(findings);
  }
  let as: any;
  let asUrl: string | undefined;
  for (const url of metadataUrls(issuerUrl)) {
    try {
      const { res, text } = await get(url);
      if (!res.ok) continue;
      const json = JSON.parse(text);
      if (json && typeof json === 'object' && (json.authorization_endpoint || json.token_endpoint || json.issuer)) {
        as = json;
        asUrl = url;
        break;
      }
    } catch {
      // try the next place
    }
  }
  if (!as && legacy) {
    findings.pop();
    add('fail', `AI apps can't find where to log in: the 401 reply has no "resource_metadata" pointer, nothing is published at ${server.origin}/.well-known/oauth-protected-resource, and there is no login server description at ${server.origin} either.`);
    return result(findings);
  }
  if (!as) {
    add('fail', `The login server at ${issuer} doesn't publish its description at any of the standard addresses (.well-known/oauth-authorization-server or openid-configuration), so AI apps can't use it.`);
    return result(findings);
  }
  add('pass', `Found the login server's description at ${asUrl}.`);

  if (as.issuer === issuer) add('pass', "The login server's name matches what the server points to.");
  else if (typeof as.issuer === 'string' && as.issuer.replace(/\/+$/, '') === issuer.replace(/\/+$/, ''))
    add('warn', `The login server describes itself as "${as.issuer}" but the server points to "${issuer}". They differ only by a trailing slash. The standard says they must be identical, so strict AI apps may reject it.`);
  else add('fail', `The login server describes itself as "${as.issuer}" but the server points to "${issuer}". Strict AI apps reject a mismatch.`);

  for (const key of ['authorization_endpoint', 'token_endpoint'] as const) {
    const v = as[key];
    if (typeof v !== 'string') add('fail', `The login server's description has no "${key}".`);
    else if (!isSecure(v)) add('fail', `The login server's ${key} (${v}) is not https. Logins must use https.`);
  }

  const methods: unknown = as.code_challenge_methods_supported;
  if (!Array.isArray(methods)) add('fail', 'The login server doesn\'t say which PKCE methods it supports ("code_challenge_methods_supported" is missing). MCP requires PKCE, and AI apps refuse to log in without proof of it.');
  else if (!methods.includes('S256')) add('fail', `The login server supports PKCE methods ${JSON.stringify(methods)} but not "S256", which MCP requires.`);
  else add('pass', 'PKCE with S256 is supported.');

  if (Array.isArray(as.response_types_supported) && !as.response_types_supported.includes('code'))
    add('fail', 'The login server doesn\'t support the "code" response type that AI apps use.');
  if (Array.isArray(as.grant_types_supported) && !as.grant_types_supported.includes('authorization_code'))
    add('fail', 'The login server doesn\'t support the "authorization_code" grant that AI apps use.');

  const dcr = typeof as.registration_endpoint === 'string';
  const cimd = as.client_id_metadata_document_supported === true;
  if (dcr || cimd) add('pass', `AI apps can register themselves (${[dcr && 'dynamic registration', cimd && 'client ID metadata documents'].filter(Boolean).join(' and ')}).`);
  else add('warn', 'The login server offers no way for an AI app to register itself (no registration_endpoint, no client ID metadata support). Only apps that you pre-register can log in.');

  // Apps that register with dynamic registration get a secret back, so they don't need "none".
  // Apps that identify themselves with a metadata document have no secret: they need it.
  if (cimd && !dcr && Array.isArray(as.token_endpoint_auth_methods_supported) && !as.token_endpoint_auth_methods_supported.includes('none'))
    add('warn', 'AI apps can only identify themselves with a client ID metadata document here, but the login server doesn\'t accept "none" as a client authentication method, which those apps (having no secret) need.');

  return result(findings);
}

function result(findings: Finding[]): CheckResult {
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;
  const status: Status = fails ? 'fail' : warns ? 'warn' : 'pass';
  const summary = status === 'pass' ? 'All good' : [fails && `${fails} failed`, warns && `${warns} warning${warns === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return { id: 'oauth', title: 'Login setup follows the spec', status, summary, findings, weight: 10 };
}

// WWW-Authenticate: Bearer realm="x", resource_metadata="https://…"
export function parseChallenge(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

// The places a login server may publish its description, in the order AI apps try them.
export function metadataUrls(issuer: URL): string[] {
  const base = issuer.origin;
  const path = issuer.pathname.replace(/\/$/, '');
  if (!path) return [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  return [`${base}/.well-known/oauth-authorization-server${path}`, `${base}/.well-known/openid-configuration${path}`, `${base}${path}/.well-known/openid-configuration`];
}

function canon(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u;
  }
}

function isSecure(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
  } catch {
    return false;
  }
}
