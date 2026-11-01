import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

// Plays the part of an MCP host: reads the day's mail and queues one reply for a human to review.
const client = new Client({ name: 'inbox-approval-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.js', import.meta.url))],
  env: process.env,
  stderr: 'pipe'
});
transport.stderr?.on('data', () => {});
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;

const { tools } = await client.listTools();
console.log('Tools:', tools.map(t => t.name).join(', '));
const digest = await call('daily_digest', { date: '2026-11-02' });
console.log(`Digest: ${digest.total} messages, ${digest.needs_reply.length} need a reply, ${digest.flagged.length} flagged, ${digest.skipped} skipped`);
const { results: [message] } = await call('search_messages', { query: 'Thursday' });
const { draft } = await call('create_draft_reply', {
  message_id: message.id,
  body: 'Hi, thanks for your message. Friday morning works for us, so we will move the delivery. Maya'
});
console.log(`Draft for ${draft.to_address}: ${draft.status}. Open the approval desk to review it.`);
await client.close();
