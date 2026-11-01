import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core.js';
import { createWebApp } from '../web.js';

const store = openStore();
store.seed();
const app = createWebApp({ store, webhookSecret: 'test-secret', sessionToken: 'tok' });
let base;
before(() => new Promise(done => app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.address().port}`; done(); })));
after(() => new Promise(done => app.close(done)));
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const mail = { mailbox: 'gmail-demo', provider_id: 'hook-1', from: 'new@client.example', subject: 'Hello', body: 'Are you open on Monday?', received_at: '2026-11-03T09:00:00Z' };

test('the inbound webhook needs the shared secret', async () => {
  assert.equal((await post('/hooks/inbound', mail)).status, 401);
  assert.equal((await post('/hooks/inbound', mail, { 'x-webhook-secret': 'wrong-secret' })).status, 401);
});

test('a repeated webhook delivery is stored once', async () => {
  const first = await (await post('/hooks/inbound', mail, { 'x-webhook-secret': 'test-secret' })).json();
  const second = await (await post('/hooks/inbound', mail, { 'x-webhook-secret': 'test-secret' })).json();
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(first.id, second.id);
});

test('the webhook rejects unknown mailboxes and malformed bodies', async () => {
  const headers = { 'x-webhook-secret': 'test-secret' };
  assert.equal((await post('/hooks/inbound', { ...mail, mailbox: 'x' }, headers)).status, 400);
  const raw = await fetch(`${base}/hooks/inbound`, { method: 'POST', headers, body: 'not json' });
  assert.equal(raw.status, 400);
});

test('approval from outside the desk page is refused', async () => {
  const d = store.createDraft({ message_id: store.search({ query: 'Are you open' })[0].id, body: 'Yes, from 9.' });
  const [row] = store.listDrafts();
  const res = await post(`/api/drafts/${d.id}/approve`, { content_hash: row.content_hash });
  assert.equal(res.status, 403);
  assert.equal(store.outbox().length, 0);
});

test('requests with a foreign Host header are refused', async () => {
  const { request } = await import('node:http');
  const status = await new Promise((done, fail) => {
    request(`${base}/api/state`, { headers: { host: 'attacker.example' } }, res => { res.resume(); done(res.statusCode); }).on('error', fail).end();
  });
  assert.equal(status, 403);
});

test('the desk approves once and a repeat click gets a conflict', async () => {
  const [row] = store.listDrafts();
  const headers = { 'x-session-token': 'tok' };
  assert.equal((await post(`/api/drafts/${row.id}/approve`, { content_hash: row.content_hash }, headers)).status, 200);
  assert.equal((await post(`/api/drafts/${row.id}/approve`, { content_hash: row.content_hash }, headers)).status, 409);
  assert.equal(store.outbox().length, 1);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.pending.length, 0);
});
