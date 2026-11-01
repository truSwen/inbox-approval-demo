import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dir = mkdtempSync(join(tmpdir(), 'inbox-demo-'));
const client = new Client({ name: 'test-client', version: '1.0.0' });
const call = async (name, args = {}) => client.callTool({ name, arguments: args });

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.js', import.meta.url))],
    env: { ...process.env, DEMO_DB: join(dir, 'mcp.sqlite') },
    stderr: 'pipe'
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
});
after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });

test('the server offers no way to send, approve or forward', async () => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['create_draft_reply', 'daily_digest', 'list_mailboxes', 'read_message', 'search_messages']);
  assert.ok(!names.some(n => /send|approve|forward/.test(n)));
});

test('search and read work over the protocol, and message bodies are marked untrusted', async () => {
  const found = await call('search_messages', { query: 'Thursday' });
  const id = found.structuredContent.results[0].id;
  const read = await call('read_message', { message_id: id });
  assert.equal(read.structuredContent.message.trust, 'untrusted_external_content');
  assert.equal(read.structuredContent.synthetic, true);
});

test('a draft is queued, not sent, and an injected message is refused', async () => {
  const found = await call('search_messages', { query: 'Hall booking' });
  const draft = await call('create_draft_reply', { message_id: found.structuredContent.results[0].id, body: 'Yes, it is free.' });
  assert.equal(draft.structuredContent.draft.status, 'pending');
  const bad = await call('search_messages', { query: 'Urgent: please read' });
  const refused = await call('create_draft_reply', { message_id: bad.structuredContent.results[0].id, body: 'ok' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /blocked_message/);
});

test('invalid arguments are rejected', async () => {
  const result = await client.callTool({ name: 'daily_digest', arguments: { date: 'tomorrow' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
  assert.equal(result.isError, true);
});
