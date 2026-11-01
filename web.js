import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { NOTICE, WorkflowError, openStore } from './core.js';

const MAX_REQUEST = 16 * 1024;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const STATUS = { not_found: 404, already_sent: 409, not_pending: 409, content_changed: 409, human_required: 400 };
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const sameSecret = (a = '', b = '') => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
async function readJson(req) {
  let size = 0; const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_REQUEST) throw new WorkflowError('too_large', 'Request too large');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new WorkflowError('invalid_json', 'Body must be JSON'); }
}

export function createWebApp({ store, webhookSecret, approver = 'Maya (demo approver)', sessionToken = randomBytes(24).toString('hex') }) {
  const page = fileURLToPath(new URL('./public/index.html', import.meta.url));
  const html = async () => (await readFile(page, 'utf8')).replace('__SESSION_TOKEN__', sessionToken);
  return createHttpServer(async (req, res) => {
    try {
      if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden' });
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && pathname === '/') return send(res, 200, await html(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/state') {
        return send(res, 200, { notice: NOTICE, approver, mailboxes: store.mailboxes(), pending: store.listDrafts('pending'),
          inbox: store.search({ limit: 20 }), outbox: store.outbox(), audit: store.auditLog(14) });
      }
      if (req.method === 'POST' && pathname === '/hooks/inbound') {
        if (!sameSecret(req.headers['x-webhook-secret'], webhookSecret)) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, store.ingest(await readJson(req)));
      }
      const decision = pathname.match(/^\/api\/drafts\/([\w-]+)\/(approve|reject)$/);
      if (req.method === 'POST' && decision) {
        if (req.headers['x-session-token'] !== sessionToken) return send(res, 403, { error: 'forbidden' });
        const body = await readJson(req);
        const args = { draft_id: decision[1], content_hash: body.content_hash };
        return send(res, 200, decision[2] === 'approve' ? store.approve(args, approver) : store.reject(args, approver));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof WorkflowError) return send(res, STATUS[error.code] ?? 400, { error: error.code, message: error.message });
      console.error(error);
      return send(res, 500, { error: 'server_error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = openStore(process.env.DEMO_DB ?? fileURLToPath(new URL('./demo.sqlite', import.meta.url)));
  store.seed();
  const webhookSecret = process.env.WEBHOOK_SECRET || randomBytes(24).toString('hex');
  const port = Number(process.env.PORT ?? 4173);
  createWebApp({ store, webhookSecret }).listen(port, '127.0.0.1', () => {
    console.log(`Approval desk: http://127.0.0.1:${port}`);
  });
}
