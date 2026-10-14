// A small MCP server that runs as a program and talks over standard input/output.
// Used to test QAmcp's --stdio support. Everything it returns is fake.
// Run by hand: node --import tsx test/stdioServer.ts
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server({ name: 'stdio-test-server', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'get_note',
      description: 'Get one note by its id. Returns the note title and text.',
      inputSchema: { type: 'object', properties: { note_id: { type: 'string', description: 'Note id, like N-1' } }, required: ['note_id'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'search_notes',
      description: 'Search notes by a word and return matching note ids and titles.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Word to search for' } }, required: ['query'] },
      annotations: { readOnlyHint: true },
    },
  ] as any,
}));

const NOTES: Record<string, { title: string; text: string }> = {
  'N-1': { title: 'Shopping', text: 'Buy oat milk and rice.' },
  'N-2': { title: 'Ideas', text: 'Build a tester for MCP servers.' },
};

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args = {} } = request.params as { name: string; arguments?: Record<string, any> };
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
  if (name === 'get_note') {
    if (typeof args.note_id !== 'string' || !args.note_id) return text('"note_id" is required', true);
    const n = NOTES[args.note_id];
    return n ? text(JSON.stringify({ id: args.note_id, ...n })) : text(`No note ${args.note_id}`, true);
  }
  if (name === 'search_notes') {
    if (typeof args.query !== 'string') return text('"query" is required', true);
    const hits = Object.entries(NOTES).filter(([, n]) => (n.title + ' ' + n.text).toLowerCase().includes(args.query.toLowerCase()));
    return text(JSON.stringify(hits.map(([id, n]) => ({ id, title: n.title }))));
  }
  return text(`Unknown tool ${name}`, true);
});

await server.connect(new StdioServerTransport());
