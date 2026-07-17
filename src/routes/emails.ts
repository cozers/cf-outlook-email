import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first } from '../db';
import { ok, notFound, badRequest } from '../response';
import { acquireToken } from '../mail';
import { listEmails, getEmailDetail, deleteMessage, batchDelete } from '../mail';
import { listAttachments, getAttachment } from '../graph';

const emails = new Hono<{ Bindings: Env }>();

// GET /api/accounts/:id/emails
emails.get('/', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  if (acc.status === 'disabled') {
    return badRequest('该账号已停用');
  }

  const folder = c.req.query('folder') ?? 'inbox';
  const top = Math.min(parseInt(c.req.query('top') ?? '20', 10), 50);
  const skip = parseInt(c.req.query('skip') ?? '0', 10);
  const keyword = c.req.query('keyword');

  const result = await listEmails(c.env.DB, acc, { folder, top, skip, keyword });
  if (result.error) {
    return ok({ items: [], error: result.error }, '获取邮件失败');
  }

  return ok({ items: result.items ?? [], total: (result.items ?? []).length });
});

// GET /api/accounts/:id/emails/:messageId
emails.get('/:messageId', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const messageId = c.req.param('messageId')!;

  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  const result = await getEmailDetail(c.env.DB, acc, messageId);
  if (result.error) {
    if (result.code === 'NOT_FOUND') return notFound('邮件不存在');
    return badRequest(result.error);
  }

  return ok(result.item);
});

// GET /api/accounts/:id/emails/:messageId/attachments - list attachment metadata
// Graph-only: IMAP attachment extraction is not implemented; IMAP accounts get an
// empty list so the frontend renders no attachment chips rather than erroring.
emails.get('/:messageId/attachments', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const messageId = c.req.param('messageId')!;
  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  // IMAP message ids are namespaced ("imap:<folder>:<uid>"); attachments unsupported.
  if (messageId.startsWith('imap:')) return ok({ items: [] });

  const tok = await acquireToken(c.env.DB, acc);
  if (!tok.resolved) return badRequest(tok.error ?? '认证失败');
  if (tok.resolved.protocol === 'imap') return ok({ items: [] });

  const result = await listAttachments(tok.resolved.token, messageId);
  if (result.error) return badRequest(result.error.message);
  const items = (result.items ?? []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size }));
  return ok({ items });
});

// GET /api/accounts/:id/emails/:messageId/attachments/:attId - download one attachment
emails.get('/:messageId/attachments/:attId', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const messageId = c.req.param('messageId')!;
  const attId = c.req.param('attId')!;
  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  if (messageId.startsWith('imap:')) return badRequest('IMAP 账号暂不支持下载附件');

  const tok = await acquireToken(c.env.DB, acc);
  if (!tok.resolved) return badRequest(tok.error ?? '认证失败');
  if (tok.resolved.protocol === 'imap') return badRequest('IMAP 账号暂不支持下载附件');

  const result = await getAttachment(tok.resolved.token, messageId, attId);
  if (result.error) {
    if (result.error.code === 'NOT_FOUND') return notFound('附件不存在');
    return badRequest(result.error.message);
  }
  const att = result.attachment!;
  if (!att.contentBytes) return badRequest('该附件不是文件附件，无法下载');

  // Decode base64 contentBytes to binary
  const binary = atob(att.contentBytes);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      'Content-Type': att.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`,
    },
  });
});

// POST /api/accounts/:id/emails/batch-delete  body: { ids: string[] }
emails.post('/batch-delete', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = (body.ids ?? []).filter((x) => typeof x === 'string');
  if (!ids.length) return badRequest('请选择要删除的邮件');

  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  // Cap per request. Graph: 1 token call + N deletes must stay under the
  // 50-subrequest limit. IMAP: one shared connection handles the whole set.
  const MAX = 30;
  const targets = ids.slice(0, MAX);
  const { results: delResults, forbidden, error } = await batchDelete(c.env.DB, acc, targets);
  if (error) return badRequest(error);
  const deleted = [...delResults.values()].filter(Boolean).length;
  const failed = targets.length - deleted;
  const skipped = ids.length - targets.length;

  let msg = `已删除 ${deleted} 封`;
  if (failed) msg += `，失败 ${failed} 封`;
  if (skipped) msg += `，超出单次上限未处理 ${skipped} 封（请分批）`;
  if (forbidden) msg += '。该账号为只读授权，请「编辑账号 → 重新授权」获取读写权限';
  return ok({ deleted, failed, skipped }, msg);
});

// DELETE /api/accounts/:id/emails/:messageId
emails.delete('/:messageId', async (c) => {
  const accountId = parseInt(c.req.param('id')!, 10);
  const messageId = c.req.param('messageId')!;

  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) return notFound('账号不存在');

  const result = await deleteMessage(c.env.DB, acc, messageId);
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('邮件不存在');
    return badRequest(result.error || '删除失败');
  }
  return ok(null, '已删除');
});

export default emails;
