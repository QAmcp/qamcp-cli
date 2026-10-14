// A second deliberately broken MCP server with 7 specific faults, built as an
// independent check of what QAmcp catches. Everything here is fake: the "API key"
// and file paths are made up and unlock nothing.
// Run: npx tsx test/faultServer.ts [port]
import { createServer, type IncomingMessage } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';
import { isMain } from '../src/isMain.js';

const FAKE_KEY = 'sk-test-FAKE0000000000notarealkey0000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

const TOOLS: any[] = [
  {
    // A normal, healthy tool, so the report has something to compare against.
    name: 'get_order',
    description: 'Get one order by its order number. Returns the items, total, and delivery status.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string', description: 'Order number, e.g. A1001' } }, required: ['order_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 1: slow. Takes 8 seconds every time.
    name: 'get_sales_report',
    description: 'Get the sales report for a month: total orders, revenue, and top products.',
    inputSchema: { type: 'object', properties: { month: { type: 'string', description: 'Month as YYYY-MM' } }, required: ['month'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 2: vague description. Says nothing about what it does or returns.
    name: 'process_data',
    description: 'Handles data processing for various things.',
    inputSchema: { type: 'object', properties: { data: { type: 'string', description: 'The data' } }, required: ['data'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 3: missing input schema (MCP requires one on every tool).
    name: 'get_store_hours',
    description: 'Get the opening hours of a store location.',
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 4: on bad input, the error leaks a (fake) API key and a server file path.
    name: 'get_customer',
    description: 'Get a customer profile by customer id.',
    inputSchema: { type: 'object', properties: { customer_id: { type: 'string', description: 'Customer id, e.g. C-42' } }, required: ['customer_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 5: on bad input, the server crashes and returns a raw stack trace (HTTP 500).
    name: 'get_invoice',
    description: 'Get an invoice as text by invoice number.',
    inputSchema: { type: 'object', properties: { invoice_id: { type: 'string', description: 'Invoice number, e.g. INV-7' } }, required: ['invoice_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 6: claims success but does nothing. Always says "success" and returns no data.
    name: 'get_shipping_quote',
    description: 'Get a shipping price quote for a parcel to a postcode.',
    inputSchema: {
      type: 'object',
      properties: { postcode: { type: 'string', description: 'Destination postcode' }, weight_kg: { type: 'number', description: 'Parcel weight in kg' } },
      required: ['postcode', 'weight_kg'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 7a: near-duplicate of find_customers below.
    name: 'search_customers',
    description: 'Search customers by name and return matching customer profiles.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Customer name to search for' } }, required: ['name'] },
    annotations: { readOnlyHint: true },
  },
  {
    // FAULT 7b: near-duplicate of search_customers above.
    name: 'find_customers',
    description: 'Find customers by name and return the matching customer profiles.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name of the customer to find' } }, required: ['name'] },
    annotations: { readOnlyHint: true },
  },
];

const CUSTOMERS = [{ id: 'C-42', name: 'Asha Rao (fake)' }, { id: 'C-77', name: 'Ben Ortiz (fake)' }];

function buildServer() {
  const server = new Server({ name: 'fault-test-server', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args = {} } = request.params as { name: string; arguments?: Record<string, any> };
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
    switch (name) {
      case 'get_order':
        if (typeof args.order_id !== 'string' || !args.order_id) return text('"order_id" is required and must be text', true);
        return text(JSON.stringify({ order_id: args.order_id, items: ['mug (fake)'], total: 12.5, status: 'shipped' }));
      case 'get_sales_report':
        await sleep(8_000);
        if (typeof args.month !== 'string') return text('"month" is required, like 2026-09', true);
        return text(JSON.stringify({ month: args.month, orders: 120, revenue: 4200, top: ['mug (fake)'] }));
      case 'process_data':
        if (typeof args.data !== 'string') return text('"data" is required', true);
        return text(`Processed ${args.data.length} characters.`);
      case 'get_store_hours':
        return text('Mon–Sat 9:00–18:00, Sun closed (fake store)');
      case 'get_customer': {
        if (typeof args.customer_id !== 'string' || !args.customer_id)
          return text(`Error: customer lookup failed. Upstream auth used key ${FAKE_KEY} from /srv/app/config/secrets.env (CRM client v2)`, true);
        const c = CUSTOMERS.find((x) => x.id === args.customer_id);
        return c ? text(JSON.stringify(c)) : text(`No customer ${args.customer_id}`, true);
      }
      case 'get_invoice':
        return text(`Invoice ${args.invoice_id}: 1 × mug (fake), total 12.50`);
      case 'get_shipping_quote':
        return text(JSON.stringify({ status: 'success' }));
      case 'search_customers':
      case 'find_customers': {
        if (typeof args.name !== 'string') return text('"name" is required', true);
        const found = CUSTOMERS.filter((c) => c.name.toLowerCase().includes(args.name.toLowerCase()));
        return text(JSON.stringify(found));
      }
      default:
        return text(`Unknown tool ${name}`, true);
    }
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : undefined;
}

export function startFaultServer(port: number) {
  const http = createServer(async (req, res) => {
    const body: any = req.method === 'POST' ? await readBody(req) : undefined;
    const p = body?.params;
    // FAULT 5: a bad invoice id crashes the whole request with a raw stack trace.
    if (body?.method === 'tools/call' && p?.name === 'get_invoice' && typeof p.arguments?.invoice_id !== 'string') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(
        "TypeError: Cannot read properties of undefined (reading 'toUpperCase')\n" +
          '    at formatInvoiceId (/srv/app/src/invoices/format.js:14:22)\n' +
          '    at getInvoice (/srv/app/src/invoices/index.js:41:10)\n' +
          '    at async handleToolCall (/srv/app/src/mcp/server.js:88:5)',
      );
    }
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise<typeof http>((resolve) => http.listen(port, '127.0.0.1', () => resolve(http)));
}

if (isMain(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4300);
  await startFaultServer(port);
  console.log(`Fault MCP server on http://127.0.0.1:${port}/mcp`);
}
