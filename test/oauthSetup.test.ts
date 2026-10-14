// The login-setup check, against a pretend server that makes one specific mistake per path.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { checkLoginSetup, metadataUrls, parseChallenge } from '../src/oauthSetup.js';

const PORT = 4720;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof createServer>;

// Every variant is a self-contained server at /<variant>/mcp with its own login server at /as/<variant>.
const good = (v: string) => ({
  resource: `${ORIGIN}/${v}/mcp`,
  as: {
    issuer: `${ORIGIN}/as/${v}`,
    authorization_endpoint: `${ORIGIN}/as/${v}/authorize`,
    token_endpoint: `${ORIGIN}/as/${v}/token`,
    registration_endpoint: `${ORIGIN}/as/${v}/register`,
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  } as Record<string, unknown>,
  header: true,
  prm: true,
  asMeta: true,
  prmAt: 'header' as 'header' | 'wellknown',
  asListed: `${ORIGIN}/as/${v}`, // how the resource details name the login server
});

const variants: Record<string, ReturnType<typeof good>> = {};
const variant = (name: string, change: (v: ReturnType<typeof good>) => void) => {
  const v = good(name);
  change(v);
  variants[name] = v;
};
variant('ok', () => {});
variant('slash', (v) => (v.resource += '/'));
variant('parent', (v) => (v.resource = ORIGIN + '/'));
variant('issuerslash', (v) => (v.asListed += '/')); // listed with a slash; its own description has none
variant('wronghost', (v) => (v.resource = 'https://other.example/mcp'));
variant('nopkce', (v) => delete v.as.code_challenge_methods_supported);
variant('plainonly', (v) => (v.as.code_challenge_methods_supported = ['plain']));
variant('issuer', (v) => (v.as.issuer = 'https://somewhere.else'));
variant('nodcr', (v) => delete v.as.registration_endpoint);
variant('cimd', (v) => {
  delete v.as.registration_endpoint;
  v.as.client_id_metadata_document_supported = true;
});
variant('noheader', (v) => {
  v.header = false;
  v.prmAt = 'wellknown';
});
variant('nometa', (v) => {
  v.header = false;
  v.prm = false;
});
variant('noasmeta', (v) => (v.asMeta = false));
variant('httpendpoint', (v) => (v.as.token_endpoint = 'http://auth.example.com/token'));
variant('nocode', (v) => (v.as.response_types_supported = ['token']));
variant('noauthcode', (v) => (v.as.grant_types_supported = ['client_credentials']));
variant('nonone', (v) => (v.as.token_endpoint_auth_methods_supported = ['client_secret_basic']));

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN);
    const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const m = url.pathname.match(/^\/([a-z0-9]+)\/mcp$/);
    if (req.method === 'POST' && m) {
      if (m[1] === 'open') return json(200, { jsonrpc: '2.0', id: 1, result: {} });
      const v = variants[m[1]];
      if (!v) return json(404, {});
      const challenge = v.header ? `Bearer realm="mcp", resource_metadata="${ORIGIN}/${m[1]}/.well-known/prm"` : 'Bearer realm="mcp"';
      return void res.writeHead(401, { 'www-authenticate': challenge }).end();
    }
    const prm = url.pathname.match(/^\/([a-z0-9]+)\/\.well-known\/prm$/);
    if (prm && variants[prm[1]]?.prm && variants[prm[1]].prmAt === 'header')
      return json(200, { resource: variants[prm[1]].resource, authorization_servers: [variants[prm[1]].asListed] });
    const wk = url.pathname.match(/^\/\.well-known\/oauth-protected-resource\/([a-z0-9]+)\/mcp$/);
    if (wk && variants[wk[1]]?.prm && variants[wk[1]].prmAt === 'wellknown')
      return json(200, { resource: variants[wk[1]].resource, authorization_servers: [variants[wk[1]].asListed] });
    const as = url.pathname.match(/^\/\.well-known\/oauth-authorization-server\/as\/([a-z0-9]+)$/);
    if (as && variants[as[1]]?.asMeta) return json(200, variants[as[1]].as);
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const run = (v: string) => checkLoginSetup(`${ORIGIN}/${v}/mcp`);
const texts = (r: Awaited<ReturnType<typeof run>>, status: string) => r!.findings.filter((f) => f.status === status).map((f) => f.message);

test('a server with no login gets no check at all', async () => {
  assert.equal(await run('open'), null);
  assert.equal(await checkLoginSetup('http://127.0.0.1:1/mcp', { timeoutMs: 2000 }), null); // nothing there: not our business here
});

test('a correct setup passes with nothing to fix', async () => {
  const r = await run('ok');
  assert.equal(r!.status, 'pass');
  assert.equal(r!.id, 'oauth');
  assert.ok(r!.findings.every((f) => f.status === 'pass'), JSON.stringify(r!.findings));
  assert.ok(r!.findings.some((f) => /PKCE with S256/.test(f.message)));
});

const cases: [string, 'fail' | 'warn', RegExp][] = [
  ['wronghost', 'fail', /say they are for "https:\/\/other.example\/mcp".*AI apps refuse/],
  ['nopkce', 'fail', /"code_challenge_methods_supported" is missing/],
  ['plainonly', 'fail', /not "S256"/],
  ['issuer', 'fail', /describes itself as "https:\/\/somewhere.else"/],
  ['nometa', 'fail', /can't find where to log in/],
  ['noasmeta', 'fail', /doesn't publish its description/],
  ['httpendpoint', 'fail', /token_endpoint .* is not https/],
  ['nocode', 'fail', /"code" response type/],
  ['noauthcode', 'fail', /"authorization_code" grant/],
  ['slash', 'fail', /differ only by a trailing slash.*official MCP SDK reject/],
  ['issuerslash', 'warn', /differ only by a trailing slash.*strict AI apps may reject/],
  ['nodcr', 'warn', /no way for an AI app to register itself/],
  ['noheader', 'warn', /doesn't include a "resource_metadata" pointer/],
  ['nonone', 'warn', /"none" as a client authentication method/],
];
for (const [v, status, pattern] of cases) {
  test(`${v}: reported as ${status} in plain words`, async () => {
    const r = await run(v);
    assert.ok(r, 'a check should exist');
    assert.ok(texts(r, status).some((t) => pattern.test(t)), `expected ${status} ${pattern}, got: ${JSON.stringify(r!.findings, null, 1)}`);
    assert.equal(r!.status, status === 'fail' ? 'fail' : 'warn');
  });
}

test('a resource that names a parent address is accepted, as the official SDK accepts it (real Semgrep case)', async () => {
  const r = await run('parent');
  assert.equal(r!.status, 'pass', JSON.stringify(r!.findings));
  assert.ok(r!.findings.some((f) => /a parent of the server's address/.test(f.message)));
});

test('client ID metadata documents count as a way to register (no false warning)', async () => {
  const r = await run('cimd');
  assert.equal(r!.status, 'pass');
  assert.ok(r!.findings.some((f) => /client ID metadata documents/.test(f.message)));
});

test('a missing pointer is only a warning when the well-known address works', async () => {
  const r = await run('noheader');
  assert.equal(r!.status, 'warn');
  assert.ok(!texts(r, 'fail').length);
});

test('parseChallenge reads quoted and bare values', () => {
  assert.deepEqual(parseChallenge('Bearer realm="mcp", resource_metadata="https://x.io/.well-known/prm", error=invalid_token'), {
    realm: 'mcp',
    resource_metadata: 'https://x.io/.well-known/prm',
    error: 'invalid_token',
  });
  assert.deepEqual(parseChallenge(null), {});
});

test('metadata addresses follow the standard order, with and without a path', () => {
  assert.deepEqual(metadataUrls(new URL('https://auth.example.com')), [
    'https://auth.example.com/.well-known/oauth-authorization-server',
    'https://auth.example.com/.well-known/openid-configuration',
  ]);
  assert.deepEqual(metadataUrls(new URL('https://auth.example.com/tenant1/')), [
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example.com/.well-known/openid-configuration/tenant1',
    'https://auth.example.com/tenant1/.well-known/openid-configuration',
  ]);
});

test('the older (March 2025) login setup is a warning, not a failure (real Atlassian case)', async () => {
  const port = PORT + 7;
  const origin = `http://127.0.0.1:${port}`;
  const legacy = createServer((req, res) => {
    const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/v1/sse' && req.method === 'POST') return void res.writeHead(401, { 'www-authenticate': 'Bearer realm="OAuth", error="invalid_token"' }).end();
    if (req.url === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/v1/authorize`,
        token_endpoint: `${origin}/v1/token`,
        registration_endpoint: `${origin}/v1/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => legacy.listen(port, '127.0.0.1', () => r()));
  try {
    const r = await checkLoginSetup(`${origin}/v1/sse`);
    assert.equal(r!.status, 'warn', JSON.stringify(r!.findings));
    assert.match(texts(r, 'warn').join(' '), /older login setup from the March 2025 MCP version/);
    assert.deepEqual(texts(r, 'fail'), []);
    assert.ok(texts(r, 'pass').some((m) => /PKCE with S256/.test(m)), 'the login server itself was still checked');
  } finally {
    legacy.closeAllConnections();
    legacy.close();
  }
});
