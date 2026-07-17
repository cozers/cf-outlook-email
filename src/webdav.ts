// WebDAV backup: uploads a plaintext account export (the same
// `email----password----client_id----refresh_token` format as the manual export)
// to a user-configured WebDAV server (Nextcloud / 坚果云 / etc.).
//
// Ported from assast/outlookEmail, with two deliberate improvements:
//   1. Retention: keep only the newest N backups (PROPFIND list + DELETE old),
//      so credential-bearing files don't accumulate forever.
//   2. Runs on Cloudflare Workers via plain fetch() — no WebDAV client library.
//
// SECURITY: the backup file contains plaintext passwords and refresh tokens.
// Whoever can read the WebDAV target can read every account credential. This
// mirrors upstream behaviour; the retention cap only limits accumulation.

import type { Env } from './types';
import { query, run } from './db';

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
}

// Build the backup file content: every account as one export line, newest first.
// Reuses the exact format of GET /api/accounts/export so a backup can be restored
// by pasting it straight into the import box.
export async function buildBackupContent(
  db: D1Database
): Promise<{ content: string; count: number }> {
  type ExportRow = { email: string; password: string; client_id: string; refresh_token: string };
  const rows = await query<ExportRow>(
    db,
    'SELECT email, password, client_id, refresh_token FROM accounts ORDER BY created_at DESC'
  );
  const lines = rows.map(
    (r) => `${r.email}----${r.password || ''}----${r.client_id}----${r.refresh_token}`
  );
  return { content: lines.join('\n'), count: rows.length };
}

// Build the full upload URL for a filename (base dir URL + encoded filename).
function buildUploadUrl(baseUrl: string, filename: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(filename)}`;
}

// Timestamped backup filename, e.g. all_accounts_backup_20260717_030000.txt
export function buildBackupFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `all_accounts_backup_${ts}.txt`;
}

function basicAuth(cfg: WebdavConfig): Record<string, string> {
  if (!cfg.username && !cfg.password) return {};
  return { Authorization: 'Basic ' + btoa(`${cfg.username}:${cfg.password}`) };
}

function uploadErrorMessage(status: number): string {
  if (status === 401) return 'WebDAV 认证失败 (401)：用户名或密码错误';
  if (status === 403) return 'WebDAV 拒绝访问 (403)：账号无写入权限';
  if (status === 404) return 'WebDAV 目录不存在 (404)：请先在服务器手动创建目标目录';
  if (status === 409) return 'WebDAV 路径冲突 (409)：上级目录不存在，请先创建';
  return `WebDAV 上传失败 (${status})`;
}

// Upload one backup file via PUT. Returns the created filename on success.
export async function uploadBackup(
  cfg: WebdavConfig,
  content: string,
  now = new Date()
): Promise<{ ok: boolean; filename?: string; error?: string }> {
  const filename = buildBackupFilename(now);
  const url = buildUploadUrl(cfg.url, filename);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...basicAuth(cfg) },
      body: content,
    });
    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return { ok: true, filename };
    }
    return { ok: false, error: uploadErrorMessage(res.status) };
  } catch (e) {
    return { ok: false, error: `网络错误: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

// List existing backup files in the directory via PROPFIND (Depth: 1), returning
// just our backup filenames. Best-effort: returns [] if the server doesn't support
// PROPFIND or the parse fails.
async function listBackups(cfg: WebdavConfig): Promise<string[]> {
  const dirUrl = cfg.url.replace(/\/+$/, '') + '/';
  try {
    const res = await fetch(dirUrl, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml', ...basicAuth(cfg) },
    });
    if (res.status !== 207) return [];
    const xml = await res.text();
    // Extract <...href>...</...href> (namespace-agnostic), then keep our backups.
    const hrefs = [...xml.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi)].map((m) => m[1]);
    return hrefs
      .map((h) => {
        try {
          const parts = decodeURIComponent(h).split('/').filter(Boolean);
          return parts[parts.length - 1] || '';
        } catch {
          return '';
        }
      })
      .filter((n) => /^all_accounts_backup_\d{8}_\d{6}\.txt$/.test(n));
  } catch {
    return [];
  }
}

// Delete one backup file (best-effort; treats 404 as success).
async function deleteBackup(cfg: WebdavConfig, filename: string): Promise<boolean> {
  const url = buildUploadUrl(cfg.url, filename);
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { ...basicAuth(cfg) } });
    return res.status === 200 || res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

// Enforce retention: keep the newest `keep` backups, delete the rest. Filenames
// embed a zero-padded timestamp, so lexicographic sort == chronological order.
// Returns how many were deleted. Best-effort; failures are swallowed.
export async function enforceRetention(cfg: WebdavConfig, keep: number): Promise<number> {
  if (keep <= 0) return 0;
  const files = await listBackups(cfg);
  if (files.length <= keep) return 0;
  const sorted = files.sort(); // ascending → oldest first
  const toDelete = sorted.slice(0, files.length - keep);
  let deleted = 0;
  for (const f of toDelete) {
    if (await deleteBackup(cfg, f)) deleted++;
  }
  return deleted;
}

// Connectivity test: PUT a small probe file, then DELETE it. Does not require the
// login password. Returns ok + a human message.
export async function testWebdav(cfg: WebdavConfig): Promise<{ ok: boolean; message: string }> {
  const probe = `outlookemail_webdav_test_${Date.now()}.txt`;
  const url = buildUploadUrl(cfg.url, probe);
  try {
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...basicAuth(cfg) },
      body: 'outlook-email webdav connectivity test',
    });
    if (!(put.status === 200 || put.status === 201 || put.status === 204)) {
      return { ok: false, message: uploadErrorMessage(put.status) };
    }
    // Clean up the probe (best-effort).
    await fetch(url, { method: 'DELETE', headers: { ...basicAuth(cfg) } }).catch(() => undefined);
    return { ok: true, message: 'WebDAV 连接正常，测试文件已上传并清理' };
  } catch (e) {
    return { ok: false, message: `网络错误: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

// Run a full backup: build content, upload, enforce retention. Writes status back
// to settings so the UI can show last-run info. Guarded against empty account sets.
// Return string is a status line; callers key off its prefix:
//   'backup ok...' | 'backup failed:...' | 'skipped: no accounts...' |
//   'skipped: no url...' | 'skipped: disabled' | 'skipped: within interval'
export async function runWebdavBackup(env: Env, opts: { force?: boolean } = {}): Promise<string> {
  const db = env.DB;
  const getSetting = async (key: string): Promise<string> => {
    const rows = await query<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key]);
    return rows[0]?.value ?? '';
  };
  const setSetting = async (key: string, value: string): Promise<void> => {
    await run(
      db,
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [key, value]
    );
  };

  const enabled = await getSetting('webdav_backup_enabled');
  if (!opts.force && enabled !== 'true' && enabled !== '1') return 'skipped: disabled';

  const cfg: WebdavConfig = {
    url: await getSetting('webdav_backup_url'),
    username: await getSetting('webdav_backup_username'),
    password: await getSetting('webdav_backup_password'),
  };
  if (!cfg.url) return 'skipped: no url configured';

  // Interval gate for scheduled runs (same pattern as token refresh / push).
  if (!opts.force) {
    const intervalHours = parseInt((await getSetting('webdav_backup_interval_hours')) || '24', 10) || 24;
    const lastRun = parseInt((await getSetting('webdav_backup_last_run')) || '0', 10);
    const now = Date.now();
    if (lastRun && now - lastRun < intervalHours * 3600 * 1000) {
      return 'skipped: within interval';
    }
  }

  const { content, count } = await buildBackupContent(db);
  if (count === 0) return 'skipped: no accounts to back up';

  const result = await uploadBackup(cfg, content);
  if (!result.ok) {
    await setSetting('webdav_backup_last_run', String(Date.now()));
    await setSetting('webdav_backup_last_status', 'error');
    await setSetting('webdav_backup_last_message', result.error ?? '备份失败');
    return `backup failed: ${result.error}`;
  }

  // Retention (best-effort; don't fail the backup if cleanup fails).
  const keep = parseInt((await getSetting('webdav_backup_keep')) || '7', 10) || 7;
  let deletedNote = '';
  try {
    const deleted = await enforceRetention(cfg, keep);
    if (deleted > 0) deletedNote = `，清理旧备份 ${deleted} 个`;
  } catch {
    /* ignore retention errors */
  }

  await setSetting('webdav_backup_last_run', String(Date.now()));
  await setSetting('webdav_backup_last_status', 'success');
  await setSetting(
    'webdav_backup_last_message',
    `已备份 ${count} 个账号到 ${result.filename}${deletedNote}`
  );
  await setSetting('webdav_backup_last_filename', result.filename ?? '');
  return `backup ok: ${count} accounts -> ${result.filename}${deletedNote}`;
}
