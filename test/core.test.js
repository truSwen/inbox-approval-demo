import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core.js';

const fresh = () => { const s = openStore(); s.seed(); return s; };
const idOf = (s, q) => s.search({ query: q })[0].id;
const code = name => error => error.code === name;

test('seed covers two mailboxes and repeated delivery does not duplicate', () => {
  const s = fresh();
  const before = s.search({ limit: 20 }).length;
  assert.equal(before, 7);
  s.seed();
  assert.equal(s.search({ limit: 20 }).length, before);
});

test('search can be scoped to one mailbox and treats wildcards literally', () => {
  const s = fresh();
  assert.ok(s.search({ mailbox: 'yahoo-demo' }).every(m => m.mailbox === 'yahoo-demo'));
  assert.equal(s.search({ query: '%' }).length, 0);
  assert.throws(() => s.search({ mailbox: 'nope' }), code('unknown_mailbox'));
});

test('digest separates replies, flagged mail and newsletters', () => {
  const d = fresh().digest({ date: '2026-11-02' });
  assert.equal(d.total, 7);
  assert.equal(d.needs_reply.length, 4);
  assert.equal(d.flagged.length, 2);
  assert.equal(d.skipped, 1);
});

test('injected instructions and credential requests are flagged and cannot be answered', () => {
  const s = fresh();
  for (const q of ['Urgent: please read', 'Verify your account']) {
    assert.notEqual(s.getMessage(idOf(s, q)).risk, 'none');
    assert.throws(() => s.createDraft({ message_id: idOf(s, q), body: 'ok' }), code('blocked_message'));
  }
});

test('a draft can only go to the original sender', () => {
  const s = fresh();
  const id = idOf(s, 'Thursday');
  assert.throws(() => s.createDraft({ message_id: id, body: 'x', to: 'someone@else.example' }), code('recipient_not_allowed'));
  assert.equal(s.createDraft({ message_id: id, body: 'Friday works.' }).to_address, 'lena@brightcrate.example');
});

test('creating a draft sends nothing', () => {
  const s = fresh();
  s.createDraft({ message_id: idOf(s, 'Thursday'), body: 'Friday works.' });
  assert.equal(s.outbox().length, 0);
});

test('approval needs a person and the exact reviewed text', () => {
  const s = fresh();
  const d = s.createDraft({ message_id: idOf(s, 'Thursday'), body: 'Friday works.' });
  const [row] = s.listDrafts();
  assert.throws(() => s.approve({ draft_id: d.id, content_hash: row.content_hash }), code('human_required'));
  assert.throws(() => s.approve({ draft_id: d.id, content_hash: 'other' }, 'Maya'), code('content_changed'));
  assert.equal(s.outbox().length, 0);
  assert.equal(s.approve({ draft_id: d.id, content_hash: row.content_hash }, 'Maya').status, 'sent_simulated');
  assert.equal(s.outbox().length, 1);
});

test('approving twice cannot send twice', () => {
  const s = fresh();
  const d = s.createDraft({ message_id: idOf(s, 'Thursday'), body: 'Friday works.' });
  const [row] = s.listDrafts();
  s.approve({ draft_id: d.id, content_hash: row.content_hash }, 'Maya');
  assert.throws(() => s.approve({ draft_id: d.id, content_hash: row.content_hash }, 'Maya'), code('already_sent'));
  assert.equal(s.outbox().length, 1);
});

test('a newer draft replaces the older one, and the old approval no longer works', () => {
  const s = fresh();
  const id = idOf(s, 'Thursday');
  const first = s.createDraft({ message_id: id, body: 'One' });
  const [row] = s.listDrafts();
  s.createDraft({ message_id: id, body: 'Two' });
  assert.equal(s.listDrafts().length, 1);
  assert.throws(() => s.approve({ draft_id: first.id, content_hash: row.content_hash }, 'Maya'), code('not_pending'));
  assert.equal(s.outbox().length, 0);
});

test('rejecting a draft sends nothing and the decision is logged', () => {
  const s = fresh();
  const d = s.createDraft({ message_id: idOf(s, 'Thursday'), body: 'No.' });
  s.reject({ draft_id: d.id }, 'Maya');
  assert.equal(s.outbox().length, 0);
  assert.ok(s.auditLog().some(a => a.action === 'draft.rejected' && a.actor === 'Maya'));
});
