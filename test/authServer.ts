// A pretend service with a real login flow (OAuth 2.1 with PKCE and dynamic registration),
// an MCP server behind it, and an ownership file. Used to test "Log in with…" and owner
// mode end to end. It approves every login automatically, as if the person clicked "Allow".
// Everything is fake.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';

const TOOLS: any[] = [
  {
    name: 'whoami',
    description: 'Tell who is logged in. Returns the user name.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    // No safety label: only run in owner mode.
    name: 'get_profile',
    description: 'Get the profile of the logged-in user: name and plan.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    // No label and a dangerous name: never run, not even for the owner.
    name: 'delete_account',
    description: 'Delete the account of the logged-in user.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface AuthServer {
  http: HttpServer;
  origin: string;
  issued: string[]; // access tokens handed out
  toolCalls: string[]; // names of tools that were run
  verifyFile?: string; // what /.well-known/qamcp-verify.txt serves (unset: 404)
}

export function startAuthServer(port: number): Promise<AuthServer> {
  const origin = `http://127.0.0.1:${port}`;
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const state: AuthServer = { http: undefined as any, origin, issued: [], toolCalls: [] };

  const json = (res: any, code: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;

    if (p === '/.well-known/qamcp-verify.txt') {
      if (state.verifyFile === undefined) return res.writeHead(404).end('not found');
      return res.writeHead(200, { 'content-type': 'text/plain' }).end(state.verifyFile);
    }
    if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (p === '/register' && req.method === 'POST') {
      const meta = JSON.parse((await readBody(req)) || '{}');
      return json(res, 201, { ...meta, client_id: `client-${randomBytes(4).toString('hex')}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (p === '/authorize') {
      const q = url.searchParams;
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return res.writeHead(400).end('bad request');
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge')!, clientId: q.get('client_id')!, redirectUri: q.get('redirect_uri')! });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      if (q.get('state')) back.searchParams.set('state', q.get('state')!);
      back.searchParams.set('iss', origin);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (p === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      const saved = codes.get(f.get('code') ?? '');
      const verifier = f.get('code_verifier') ?? '';
      const ok =
        f.get('grant_type') === 'authorization_code' &&
        saved &&
        saved.clientId === f.get('client_id') &&
        saved.redirectUri === f.get('redirect_uri') &&
        createHash('sha256').update(verifier).digest('base64url') === saved.challenge;
      if (!ok) return json(res, 400, { error: 'invalid_grant' });
      codes.delete(f.get('code')!);
      const token = `tok-${randomBytes(12).toString('hex')}`;
      state.issued.push(token);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (p === '/mcp') {
      const auth = req.headers.authorization ?? '';
      if (!state.issued.some((t) => auth === `Bearer ${t}`))
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      const raw = await readBody(req);
      const server = new Server({ name: 'login-test-server', version: '0.0.1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
      server.setRequestHandler('tools/call', async (request) => {
        const name = (request.params as any).name as string;
        state.toolCalls.push(name);
        const text = name === 'whoami' ? 'user: test-user' : name === 'get_profile' ? JSON.stringify({ name: 'Test User', plan: 'free' }) : 'account deleted';
        return { content: [{ type: 'text' as const, text }] };
      });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      return void (await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined));
    }
    res.writeHead(404).end();
  });
  state.http = http;
  return new Promise((resolve) => http.listen(port, '127.0.0.1', () => resolve(state)));
}
