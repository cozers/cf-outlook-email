import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { query, first, run } from '../db';
import { ok, badRequest, notFound } from '../response';
import { maskToken, isValidEmail } from '../utils/validation';
import { getAccessToken } from '../graph';

const accounts = new Hono<{ Bindings: Env }>();

// Mask account for list responses
function safeAccount(acc: AccountRow) {
  return {
    id: acc.id,
    email: acc.email,
    client_id: maskToken(acc.client_id),
    refresh_token: maskToken(acc.refresh_token),
    group_id: acc.group_id,
    remark: acc.remark,
    status: acc.status,
    created_at: acc.created_at,
    updated_at: acc.updated_at,
  };
}

// GET /api/accounts
accounts.get('/', async (c) => {
  const groupId = c.req.query('group_id');
  const keyword = c.req.query('keyword');

  let sql = `SELECT a.*, g.name AS group_name, g.color AS group_color
             FROM accounts a LEFT JOIN groups g ON a.group_id = g.id`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (groupId) {
    conditions.push('a.group_id = ?');
    params.push(parseInt(groupId, 10));
  }
  if (keyword) {
    conditions.push('(a.email LIKE ? OR a.remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY a.created_at DESC';

  const rows = await query<AccountRow & { group_name: string; group_color: string }>(
    c.env.DB, sql, params
  );

  const data = rows.map((r) => ({
    ...safeAccount(r),
    group_name: r.group_name ?? '默认分组',
    group_color: r.group_color ?? '#2563eb',
  }));

  return ok(data);
});

// POST /api/accounts (supports batch import)
accounts.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    account_string?: string;
    email?: string;
    client_id?: string;
    refresh_token?: string;
    password?: string;
    group_id?: number;
    remark?: string;
  };

  const groupId = body.group_id ?? 1;

  // Batch import mode
  if (body.account_string) {
    const lines = body.account_string.trim().split('\n');
    let added = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('----');
      if (parts.length >= 4) {
        const [email, password, clientId, refreshToken] = parts;
        try {
          await run(
            c.env.DB,
            'INSERT INTO accounts (email, password, client_id, refresh_token, group_id) VALUES (?, ?, ?, ?, ?)',
            [email.trim(), password.trim(), clientId.trim(), refreshToken.trim(), groupId]
          );
          added++;
        } catch {
          // Duplicate email, skip
        }
      }
    }
    if (added > 0) return ok({ added }, `成功添加 ${added} 个账号`);
    return badRequest('没有新账号被添加（可能格式错误或已存在）');
  }

  // Single add mode
  const email = body.email?.trim();
  const clientId = body.client_id?.trim();
  const refreshToken = body.refresh_token?.trim();

  if (!email || !clientId || !refreshToken) {
    return badRequest('邮箱、Client ID 和 Refresh Token 不能为空');
  }
  if (!isValidEmail(email)) {
    return badRequest('邮箱格式不正确');
  }

  try {
    const result = await run(
      c.env.DB,
      'INSERT INTO accounts (email, password, client_id, refresh_token, group_id, remark) VALUES (?, ?, ?, ?, ?, ?)',
      [email, body.password ?? '', clientId, refreshToken, groupId, body.remark ?? '']
    );
    return ok({ id: result.meta.last_row_id }, '账号添加成功');
  } catch {
    return badRequest('邮箱已存在');
  }
});

// GET /api/accounts/export - export accounts as text (same format as import)
// MUST be before /:id to avoid being matched as id="export"
accounts.get('/export', async (c) => {
  const groupId = c.req.query('group_id');
  const idsParam = c.req.query('ids');
  let sql = 'SELECT email, password, client_id, refresh_token FROM accounts';
  const params: unknown[] = [];
  // `ids` (comma-separated) takes precedence — used for single-row and selected exports
  if (idsParam) {
    const ids = idsParam
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n));
    if (!ids.length) return ok({ content: '', count: 0 });
    sql += ` WHERE id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (groupId) {
    sql += ' WHERE group_id = ?';
    params.push(parseInt(groupId, 10));
  }
  sql += ' ORDER BY created_at DESC';

  const rows = await query<{ email: string; password: string; client_id: string; refresh_token: string }>(
    c.env.DB, sql, params
  );

  const lines = rows.map(r => `${r.email}----${r.password || ''}----${r.client_id}----${r.refresh_token}`);
  return ok({ content: lines.join('\n'), count: rows.length });
});

// POST /api/accounts/batch - batch operations (delete / move group)
// MUST be before /:id
accounts.post('/batch', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: string;
    ids?: number[];
    group_id?: number;
  };

  if (!body.ids?.length) return badRequest('请选择账号');

  const placeholders = body.ids.map(() => '?').join(',');

  if (body.action === 'delete') {
    await run(c.env.DB, `DELETE FROM accounts WHERE id IN (${placeholders})`, body.ids);
    return ok(null, `已删除 ${body.ids.length} 个账号`);
  }

  if (body.action === 'move' && body.group_id !== undefined) {
    await run(
      c.env.DB,
      `UPDATE accounts SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [body.group_id, ...body.ids]
    );
    return ok(null, `已移动 ${body.ids.length} 个账号`);
  }

  if (body.action === 'enable') {
    await run(
      c.env.DB,
      `UPDATE accounts SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      body.ids
    );
    return ok(null, `已启用 ${body.ids.length} 个账号`);
  }

  if (body.action === 'disable') {
    await run(
      c.env.DB,
      `UPDATE accounts SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      body.ids
    );
    return ok(null, `已停用 ${body.ids.length} 个账号`);
  }

  return badRequest('未知操作');
});

// GET /api/accounts/:id
accounts.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const acc = await first<AccountRow & { group_name: string; group_color: string }>(
    c.env.DB,
    `SELECT a.*, g.name AS group_name, g.color AS group_color
     FROM accounts a LEFT JOIN groups g ON a.group_id = g.id WHERE a.id = ?`,
    [id]
  );
  if (!acc) return notFound('账号不存在');

  // For detail view, show full client_id but still mask refresh_token
  return ok({
    ...acc,
    refresh_token: maskToken(acc.refresh_token),
    group_name: acc.group_name ?? '默认分组',
    group_color: acc.group_color ?? '#2563eb',
  });
});

// PUT /api/accounts/:id
accounts.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!existing) return notFound('账号不存在');

  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    email: string;
    client_id: string;
    refresh_token: string;
    password: string;
    group_id: number;
    remark: string;
    status: string;
  }>;

  // Status-only update
  if (body.status && Object.keys(body).length === 1) {
    await run(
      c.env.DB,
      'UPDATE accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [body.status, id]
    );
    return ok(null, '状态更新成功');
  }

  const email = body.email?.trim() ?? existing.email;
  const clientId = body.client_id?.trim() ?? existing.client_id;
  const refreshToken = body.refresh_token?.trim() ?? existing.refresh_token;

  if (!email || !clientId || !refreshToken) {
    return badRequest('邮箱、Client ID 和 Refresh Token 不能为空');
  }

  try {
    await run(
      c.env.DB,
      `UPDATE accounts SET email = ?, password = ?, client_id = ?, refresh_token = ?,
       group_id = ?, remark = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        email,
        body.password ?? existing.password,
        clientId,
        refreshToken,
        body.group_id ?? existing.group_id,
        body.remark ?? existing.remark,
        body.status ?? existing.status,
        id,
      ]
    );
    return ok(null, '账号更新成功');
  } catch {
    return badRequest('更新失败，邮箱可能已存在');
  }
});

// DELETE /api/accounts/:id
accounts.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!existing) return notFound('账号不存在');

  await run(c.env.DB, 'DELETE FROM accounts WHERE id = ?', [id]);
  return ok(null, '账号已删除');
});

// POST /api/accounts/:id/test - test Graph connection
accounts.post('/:id/test', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!acc) return notFound('账号不存在');

  const result = await getAccessToken(acc.client_id, acc.refresh_token);

  if (result.token) {
    // Auto-save rotated refresh_token + mark active
    const updates: unknown[] = ['active', id];
    let sql = 'UPDATE accounts SET status = ?, updated_at = CURRENT_TIMESTAMP';
    if (result.newRefreshToken && result.newRefreshToken !== acc.refresh_token) {
      sql = 'UPDATE accounts SET refresh_token = ?, status = ?, updated_at = CURRENT_TIMESTAMP';
      updates.splice(0, 0, result.newRefreshToken);
    }
    sql += ' WHERE id = ?';
    await run(c.env.DB, sql, updates);
    return ok({ connected: true }, 'Graph API 连接正常');
  }

  // Mark as error
  await run(
    c.env.DB,
    'UPDATE accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['error', id]
  );

  return ok({
    connected: false,
    error: result.error?.message ?? 'Unknown error',
  }, 'Graph API 连接失败');
});

export default accounts;
