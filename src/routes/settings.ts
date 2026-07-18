import { Hono } from 'hono';
import type { Env, SettingRow } from '../types';
import { query, run } from '../db';
import { ok, badRequest } from '../response';
import { hashPassword } from '../utils/crypto';
import { maskToken } from '../utils/validation';
import { runTokenRefresh, runEmailPush } from '../cron';
import { sendTelegramMessage } from '../telegram';
import { testWebdav, runWebdavBackup, type WebdavConfig } from '../webdav';

const settings = new Hono<{ Bindings: Env }>();

// GET /api/settings
settings.get('/', async (c) => {
  const rows = await query<SettingRow>(c.env.DB, 'SELECT * FROM settings');
  const data: Record<string, string> = {};

  for (const row of rows) {
    // Mask sensitive values
    if (row.key === 'login_password_hash') {
      data['login_password'] = '******';
    } else if (row.key === 'gptmail_api_key' || row.key === 'telegram_bot_token') {
      data[row.key] = row.value ? maskToken(row.value) : '';
    } else if (row.key === 'webdav_backup_password' || row.key === 'cloudflare_admin_password') {
      // Mask stored secrets; '******' signals "unchanged" on save.
      data[row.key] = row.value ? '******' : '';
    } else {
      // external_api_key is returned in full so the admin can copy it (page is behind login)
      data[row.key] = row.value;
    }
  }

  return ok(data);
});

// Generate a random hex key (no dependencies, Web Crypto)
function genApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// POST /api/settings/external-key - (re)generate the external API key
settings.post('/external-key', async (c) => {
  const key = genApiKey();
  await run(
    c.env.DB,
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('external_api_key', ?, CURRENT_TIMESTAMP)`,
    [key]
  );
  return ok({ external_api_key: key }, '已生成新的 API Key');
});

// DELETE /api/settings/external-key - disable the external API
settings.delete('/external-key', async (c) => {
  await run(c.env.DB, "DELETE FROM settings WHERE key = 'external_api_key'", []);
  return ok(null, '已停用对外 API');
});

// POST /api/settings/refresh-now - manually refresh a batch of tokens immediately
settings.post('/refresh-now', async (c) => {
  const summary = await runTokenRefresh(c.env, { force: true });
  return ok({ summary }, summary);
});

// POST /api/settings/push-now - manually run the Telegram email push immediately
settings.post('/push-now', async (c) => {
  const summary = await runEmailPush(c.env, { force: true });
  return ok({ summary }, summary);
});

// POST /api/settings/telegram-test - send a test message with the saved bot/chat config
settings.post('/telegram-test', async (c) => {
  const rows = await query<SettingRow>(
    c.env.DB,
    "SELECT key, value FROM settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id')"
  );
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) {
    return badRequest('请先填写并保存 Bot Token 和 Chat ID');
  }
  const r = await sendTelegramMessage(
    cfg.telegram_bot_token,
    cfg.telegram_chat_id,
    '✅ Outlook Email Manager 测试消息：Telegram 推送配置成功。'
  );
  if (!r.ok) return badRequest(`发送失败：${r.error}`);
  return ok(null, '测试消息已发送，请检查 Telegram');
});

// Resolve the effective WebDAV config: use draft values from the request body when
// provided (so "test" works before saving), else fall back to the stored settings.
// A masked password ('******' or containing '*') means "unchanged" → use stored.
async function resolveWebdavConfig(
  db: D1Database,
  body: Record<string, string>
): Promise<WebdavConfig> {
  const rows = await query<SettingRow>(
    db,
    "SELECT key, value FROM settings WHERE key IN ('webdav_backup_url','webdav_backup_username','webdav_backup_password')"
  );
  const stored: Record<string, string> = {};
  for (const r of rows) stored[r.key] = r.value;

  const draftPwd = body.webdav_backup_password;
  const password =
    draftPwd !== undefined && !draftPwd.includes('*') ? draftPwd : stored.webdav_backup_password || '';
  return {
    url: (body.webdav_backup_url ?? stored.webdav_backup_url ?? '').trim(),
    username: (body.webdav_backup_username ?? stored.webdav_backup_username ?? '').trim(),
    password,
  };
}

// POST /api/settings/webdav-test - PUT a probe file then DELETE it. Accepts draft
// config in the body so the user can test before saving.
settings.post('/webdav-test', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  const cfg = await resolveWebdavConfig(c.env.DB, body);
  if (!cfg.url) return badRequest('请先填写 WebDAV 地址');
  const r = await testWebdav(cfg);
  if (!r.ok) return badRequest(r.message);
  return ok(null, r.message);
});

// POST /api/settings/webdav-backup-now - run a full backup immediately (force),
// bypassing the enabled flag and the interval gate.
settings.post('/webdav-backup-now', async (c) => {
  const summary = await runWebdavBackup(c.env, { force: true });
  if (summary.startsWith('backup ok')) return ok({ summary }, summary);
  if (summary.startsWith('skipped: no accounts')) return badRequest('没有可备份的邮箱账号');
  if (summary.startsWith('skipped: no url')) return badRequest('请先填写并保存 WebDAV 地址');
  return badRequest(summary.replace(/^backup failed:\s*/, '') || '备份失败');
});

// PUT /api/settings
settings.put('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  const updated: string[] = [];
  const errors: string[] = [];

  // Update login password
  if (body.login_password) {
    const pwd = body.login_password.trim();
    if (pwd.length < 4) {
      errors.push('密码长度至少为 4 位');
    } else {
      const hashed = await hashPassword(pwd);
      await run(
        c.env.DB,
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('login_password_hash', ?, CURRENT_TIMESTAMP)`,
        [hashed]
      );
      updated.push('登录密码');
    }
  }

  // Update GPTMail API Key
  if (body.gptmail_api_key !== undefined) {
    await run(
      c.env.DB,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('gptmail_api_key', ?, CURRENT_TIMESTAMP)`,
      [body.gptmail_api_key.trim()]
    );
    updated.push('GPTMail API Key');
  }

  // Update site title
  if (body.site_title !== undefined) {
    await run(
      c.env.DB,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('site_title', ?, CURRENT_TIMESTAMP)`,
      [body.site_title.trim()]
    );
    updated.push('站点标题');
  }

  // Telegram bot token: skip if the value still looks masked (unchanged in UI)
  if (body.telegram_bot_token !== undefined && !body.telegram_bot_token.includes('*')) {
    await run(
      c.env.DB,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('telegram_bot_token', ?, CURRENT_TIMESTAMP)`,
      [body.telegram_bot_token.trim()]
    );
    updated.push('Telegram Bot Token');
  }

  // Other Telegram push config (plain values)
  const telegramKeys: Record<string, string> = {
    telegram_push_enabled: 'enabled',
    telegram_chat_id: 'chat-id',
    telegram_push_interval_minutes: 'interval',
  };
  for (const [key, label] of Object.entries(telegramKeys)) {
    if (body[key] !== undefined) {
      await run(
        c.env.DB,
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [key, String(body[key]).trim()]
      );
      updated.push(`Telegram-${label}`);
    }
  }

  // Scheduled token refresh config
  const refreshKeys: Record<string, string> = {
    token_refresh_enabled: 'enabled',
    token_refresh_interval_hours: 'interval',
    token_refresh_batch: 'batch',
  };
  for (const [key, label] of Object.entries(refreshKeys)) {
    if (body[key] !== undefined) {
      await run(
        c.env.DB,
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [key, String(body[key]).trim()]
      );
      updated.push(`定时刷新-${label}`);
    }
  }

  // WebDAV backup config. Password is skipped when masked (unchanged in the UI).
  const webdavPlainKeys: Record<string, string> = {
    webdav_backup_enabled: 'enabled',
    webdav_backup_url: 'url',
    webdav_backup_username: 'username',
    webdav_backup_interval_hours: 'interval',
    webdav_backup_keep: 'keep',
  };
  for (const [key, label] of Object.entries(webdavPlainKeys)) {
    if (body[key] !== undefined) {
      await run(
        c.env.DB,
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [key, String(body[key]).trim()]
      );
      updated.push(`WebDAV-${label}`);
    }
  }
  // Password only when provided and not masked.
  if (body.webdav_backup_password !== undefined && !body.webdav_backup_password.includes('*')) {
    await run(
      c.env.DB,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('webdav_backup_password', ?, CURRENT_TIMESTAMP)`,
      [body.webdav_backup_password.trim()]
    );
    updated.push('WebDAV-password');
  }

  // Temp-email provider config (Cloudflare self-hosted instance + DuckMail base).
  const tempProviderKeys: Record<string, string> = {
    cloudflare_worker_domain: 'Cloudflare-实例地址',
    cloudflare_email_domains: 'Cloudflare-邮箱域名',
    duckmail_base_url: 'DuckMail-地址',
  };
  for (const [key, label] of Object.entries(tempProviderKeys)) {
    if (body[key] !== undefined) {
      await run(
        c.env.DB,
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [key, String(body[key]).trim()]
      );
      updated.push(label);
    }
  }
  // Cloudflare admin password: only when provided and not masked.
  if (body.cloudflare_admin_password !== undefined && !body.cloudflare_admin_password.includes('*')) {
    await run(
      c.env.DB,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('cloudflare_admin_password', ?, CURRENT_TIMESTAMP)`,
      [body.cloudflare_admin_password.trim()]
    );
    updated.push('Cloudflare-管理员密码');
  }

  if (errors.length > 0) return badRequest(errors.join('；'));
  if (updated.length === 0) return badRequest('没有需要更新的设置');

  return ok(null, `已更新：${updated.join(', ')}`);
});

export default settings;
