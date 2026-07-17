import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first } from '../db';
import { ok, fail } from '../response';
import { listEmails } from '../mail';

// External API: fetch emails by API key, no login required.
// Mounted BEFORE the cookie auth middleware so it is not gated by sessions.
const external = new Hono<{ Bindings: Env }>();

// API-key auth: accept `X-API-Key` header or `?key=` query param
external.use('*', async (c, next) => {
  const row = await first<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'external_api_key'",
    []
  );
  const configured = row?.value;
  if (!configured) {
    return fail('API_DISABLED', '对外 API 未启用：请在「系统设置」生成 API Key', 403);
  }
  const provided = c.req.header('X-API-Key') || c.req.query('key') || '';
  if (provided !== configured) {
    return fail('UNAUTHORIZED', 'API Key 无效', 401);
  }
  await next();
});

// GET /api/external/emails?email=<addr>&folder=inbox|junkemail|deleteditems|all&top=10&keyword=
external.get('/emails', async (c) => {
  const email = (c.req.query('email') || '').trim().toLowerCase();
  if (!email) return fail('BAD_REQUEST', '缺少 email 参数', 400);

  const folder = c.req.query('folder') || 'inbox';
  const top = Math.min(parseInt(c.req.query('top') || '10', 10) || 10, 50);
  const keyword = c.req.query('keyword') || undefined;

  const acc = await first<AccountRow>(
    c.env.DB,
    'SELECT * FROM accounts WHERE lower(email) = ?',
    [email]
  );
  if (!acc) return fail('NOT_FOUND', '账号不存在', 404);
  if (acc.status === 'disabled') return fail('DISABLED', '该账号已停用', 400);

  // Dispatch to Graph or IMAP (resolved/probed inside), token rotation + status
  // persistence handled by the dispatcher. Normalised items either way.
  const result = await listEmails(c.env.DB, acc, { folder, top, skip: 0, keyword });
  if (result.error) return fail('MAIL_ERROR', result.error, 502);

  const items = (result.items ?? []).map((e) => ({
    id: e.id,
    subject: e.subject,
    from: e.from,
    receivedDateTime: e.receivedDateTime,
    bodyPreview: e.bodyPreview,
    isRead: e.isRead,
  }));

  return ok({ email, folder, count: items.length, items });
});

export default external;
