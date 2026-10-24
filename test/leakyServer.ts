// The smallest possible server with one planted problem (a leaked fake key), used by the
// command-line tests. Fast: no slow tools. Everything is fake.
import { createServer, type IncomingMessage } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';
import { isMain } from '../src/isMain.js';

// Made at run time so secret scanners don't mistake this planted test value for a real key.
const FAKE_KEY = ['sk', 'test', 'FAKE0000000000notarealkey0000'].join('-');

const TOOLS: any[] = [
  {
    name: 'get_item',
    description: 'Get one item by its id. Returns the item name and price.',
    inputSchema: { type: 'object', properties: { item_id: { type: 'string', description: 'Item id, like I-1' } }, required: ['item_id'] },
    annotations: { readOnlyHint: true },
  },
];

function build() {
  const server = new Server({ name: 'leaky-test-server', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async (request) => {
    const args = (request.params as any).arguments ?? {};
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
    if (typeof args.item_id !== 'string' || !args.item_id) return text(`Lookup failed using key ${FAKE_KEY}`, true);
    return text(JSON.stringify({ id: args.item_id, name: 'Mug (fake)', price: 12 }));
  });
  return server;
}

export function startLeakyServer(port: number) {
  const http = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const server = build();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  return new Promise<typeof http>((resolve) => http.listen(port, '127.0.0.1', () => resolve(http)));
}

// Run as its own program, so tests that wait on a child process can still reach it.
if (isMain(import.meta.url)) {
  await startLeakyServer(Number(process.argv[2] ?? 4730));
  console.log('ready');
}
