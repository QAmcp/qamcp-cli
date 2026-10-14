// Local programs (stdio) that misbehave the ways real ones do. Run: tsx test/stdioVariants.ts <mode>
//   banner      prints a welcome line on stdout (where only MCP messages may go), then works
//   crashcall   works, but the whole program dies when a tool is called
//   needsenv    quits at once unless API_KEY is set, saying so on stderr (like most real servers)
//   noisy       writes lots of logs on stderr (allowed), and works
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'noisy';

if (mode === 'needsenv' && !process.env.API_KEY) {
  console.error('Error: API_KEY environment variable is required. Get one at https://example.com/keys');
  process.exit(1);
}
if (mode === 'banner') process.stdout.write('Weather MCP server v1.2 starting...\n');
if (mode === 'noisy') for (let i = 0; i < 50; i++) console.error(`[debug] loading module ${i}`);

const server = new Server({ name: `stdio-${mode}`, version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'get_weather', description: 'Get the current weather for a city. Returns the temperature in Celsius.', inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] }, annotations: { readOnlyHint: true } }] as any,
}));
server.setRequestHandler('tools/call', async (req) => {
  if (mode === 'crashcall') process.exit(3);
  const city = (req.params as any).arguments?.city;
  if (typeof city !== 'string') return { content: [{ type: 'text' as const, text: 'city is required and must be text' }], isError: true };
  return { content: [{ type: 'text' as const, text: `${city}: 21°C` }] };
});
await server.connect(new StdioServerTransport());
