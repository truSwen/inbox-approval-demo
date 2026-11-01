import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fixture from './data.json' with { type: 'json' };

export const NOTICE = fixture.notice;
const INJECTION = /(ignore (all |your )?(previous|prior) instructions|system note to the assistant|without asking for approval|forward (every|all) )/i;
const CREDENTIAL = /(enter your password|verify your account|one-time code|bank details)/i;
const MAX_BODY = 4000;

export class WorkflowError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new WorkflowError(code, message); };
const contentHash = ({ to_address, subject, body }) =>
  createHash('sha256').update(JSON.stringify([to_address, subject, body])).digest('hex');

function riskOf({ body, subject }) {
  const text = `${subject}\n${body}`;
  if (INJECTION.test(text)) return 'instruction_in_message';
  if (CREDENTIAL.test(text)) return 'credential_request';
  return 'none';
}

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, mailbox TEXT NOT NULL, from_address TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, category TEXT NOT NULL,
      risk TEXT NOT NULL, UNIQUE (mailbox, provider_id));
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), mailbox TEXT NOT NULL,
      to_address TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','stale')),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_draft ON drafts(message_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS outbox (
      draft_id TEXT PRIMARY KEY REFERENCES drafts(id), mailbox TEXT NOT NULL, to_address TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL, delivered_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, ref TEXT NOT NULL);
  `);
  const now = () => new Date().toISOString();
  const log = (actor, action, ref) =>
    db.prepare('INSERT INTO audit (at, actor, action, ref) VALUES (?,?,?,?)').run(now(), actor, action, String(ref));
  const tx = run => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = run(); db.exec('COMMIT'); return out; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const mailboxes = () => fixture.mailboxes;
  const getMessage = id => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? fail('not_found', 'No such message');
  const getDraft = id => db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) ?? fail('not_found', 'No such draft');

  function ingest(raw, actor = 'inbound-webhook') {
    if (!mailboxes().some(m => m.id === raw.mailbox)) fail('unknown_mailbox', 'Unknown mailbox');
    for (const key of ['provider_id', 'from', 'subject', 'body', 'received_at']) {
      if (typeof raw[key] !== 'string' || !raw[key].length) fail('invalid_message', `Missing ${key}`);
    }
    if (raw.body.length > MAX_BODY) fail('invalid_message', 'Body too long');
    const result = db.prepare(`INSERT OR IGNORE INTO messages
      (provider_id, mailbox, from_address, subject, body, received_at, category, risk) VALUES (?,?,?,?,?,?,?,?)`)
      .run(raw.provider_id, raw.mailbox, raw.from.toLowerCase(), raw.subject, raw.body, raw.received_at,
        raw.category ?? 'unsorted', riskOf(raw));
    const inserted = result.changes === 1;
    if (inserted) log(actor, 'message.ingested', `${raw.mailbox}/${raw.provider_id}`);
    return { inserted, id: db.prepare('SELECT id FROM messages WHERE mailbox = ? AND provider_id = ?').get(raw.mailbox, raw.provider_id).id };
  }

  function search({ query = '', mailbox, limit = 10 } = {}) {
    if (mailbox && !mailboxes().some(m => m.id === mailbox)) fail('unknown_mailbox', 'Unknown mailbox');
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return db.prepare(`SELECT id, mailbox, from_address, subject, received_at, category, risk FROM messages
      WHERE (from_address LIKE ?1 ESCAPE '\\' OR subject LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\')
      AND (?2 IS NULL OR mailbox = ?2) ORDER BY received_at DESC LIMIT ?3`).all(like, mailbox ?? null, limit);
  }

  function digest({ date }) {
    const rows = db.prepare(`SELECT * FROM messages WHERE substr(received_at, 1, 10) = ? ORDER BY received_at`).all(date);
    const needsReply = rows.filter(r => ['customer', 'finance', 'personal'].includes(r.category) && r.risk === 'none');
    const flagged = rows.filter(r => r.risk !== 'none');
    const brief = r => ({ id: r.id, mailbox: r.mailbox, from: r.from_address, subject: r.subject, risk: r.risk });
    return { date, total: rows.length, needs_reply: needsReply.map(brief), flagged: flagged.map(brief),
      skipped: rows.length - needsReply.length - flagged.length };
  }

  // A draft may only answer the original sender, so instructions inside a message cannot redirect mail.
  function createDraft({ message_id, body, to }, actor = 'mcp-host') {
    return tx(() => {
      const message = getMessage(message_id);
      if (message.risk !== 'none') fail('blocked_message', `Message flagged: ${message.risk}`);
      if (to && to.toLowerCase() !== message.from_address) fail('recipient_not_allowed', 'A draft may only reply to the original sender');
      if (!body.trim() || body.length > MAX_BODY) fail('invalid_draft', 'Draft body must be 1 to 4000 characters');
      const draft = { to_address: message.from_address, subject: `Re: ${message.subject}`, body };
      const open = db.prepare(`SELECT id FROM drafts WHERE message_id = ? AND status = 'pending'`).get(message_id);
      if (open) {
        db.prepare(`UPDATE drafts SET status = 'stale', decided_by = ?, decided_at = ? WHERE id = ?`).run(actor, now(), open.id);
        log(actor, 'draft.superseded', open.id);
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO drafts (id, message_id, mailbox, to_address, subject, body, content_hash, status, created_by, created_at)
        VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`)
        .run(id, message_id, message.mailbox, draft.to_address, draft.subject, body, contentHash(draft), actor, now());
      log(actor, 'draft.created', id);
      return { id, status: 'pending', ...draft };
    });
  }

  const listDrafts = (status = 'pending') => db.prepare(`SELECT d.*, m.from_address AS original_from, m.subject AS original_subject,
    m.body AS original_body FROM drafts d JOIN messages m ON m.id = d.message_id WHERE d.status = ? ORDER BY d.created_at`).all(status);

  // Approval binds to the exact text the human saw. Any change means a new draft and a new decision.
  function approve({ draft_id, content_hash }, actor) {
    if (!actor) fail('human_required', 'An approver is required');
    return tx(() => {
      const draft = getDraft(draft_id);
      if (draft.status === 'approved') fail('already_sent', 'This draft was already approved and sent');
      if (draft.status !== 'pending') fail('not_pending', `Draft is ${draft.status}`);
      if (content_hash !== draft.content_hash || contentHash(draft) !== draft.content_hash) fail('content_changed', 'The draft changed after review');
      const at = now();
      db.prepare(`UPDATE drafts SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`).run(actor, at, draft_id);
      db.prepare(`INSERT INTO outbox (draft_id, mailbox, to_address, subject, body, content_hash, delivered_at) VALUES (?,?,?,?,?,?,?)`)
        .run(draft_id, draft.mailbox, draft.to_address, draft.subject, draft.body, draft.content_hash, at);
      log(actor, 'draft.approved', draft_id);
      log('simulated-transport', 'mail.sent', draft_id);
      return { draft_id, status: 'sent_simulated', to: draft.to_address };
    });
  }

  function reject({ draft_id }, actor) {
    if (!actor) fail('human_required', 'An approver is required');
    return tx(() => {
      const draft = getDraft(draft_id);
      if (draft.status !== 'pending') fail('not_pending', `Draft is ${draft.status}`);
      db.prepare(`UPDATE drafts SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`).run(actor, now(), draft_id);
      log(actor, 'draft.rejected', draft_id);
      return { draft_id, status: 'rejected' };
    });
  }

  const outbox = () => db.prepare('SELECT * FROM outbox ORDER BY delivered_at').all();
  const auditLog = (limit = 50) => db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit);
  const seed = () => { for (const m of fixture.messages) ingest(m, 'fixture'); };
  return { mailboxes, ingest, search, getMessage, digest, createDraft, listDrafts, approve, reject, outbox, auditLog, seed, close: () => db.close() };
}
