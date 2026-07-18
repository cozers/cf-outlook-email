// Multi-provider temp-email backends: DuckMail (mail.tm protocol) and a
// self-hosted cloudflare_temp_email instance. GPTMail stays in the route module
// (its shape predates this). Each provider exposes generate / list / detail so
// routes/tempEmails.ts can dispatch on `source` and stay provider-agnostic.
//
// Ported from assast/outlookEmail's Python implementation, adapted to Workers.
// SECURITY: per-mailbox credentials (DuckMail password/token) are stored in D1
// in plaintext, consistent with how this project already stores account
// refresh_tokens. Treat the DB as sensitive.

import type { Env, TempEmailRow } from './types';
import { first, run } from './db';

// Unified message shapes (mirror the GPTMail route output so the frontend
// renders any provider identically).
export interface TempMessage {
  id: string;
  from: string;
  subject: string;
  body_preview: string;
  timestamp: number | string;
  has_html: boolean;
}

export interface TempMessageDetail {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  body_type: 'html' | 'text';
  timestamp: number | string;
}

// Credentials returned by generate(), persisted by the route into temp_emails.
export interface GeneratedMailbox {
  email: string;
  duckmail_token?: string;
  duckmail_account_id?: string;
  duckmail_password?: string;
  cloudflare_address_id?: string;
}

async function getSetting(db: D1Database, key: string): Promise<string> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? '';
}

function randStr(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

// ==================== DuckMail (mail.tm protocol) ====================

// Default to the duckmail.sbs mirror (mail.tm-compatible), overridable via
// settings key `duckmail_base_url`.
async function duckmailBase(db: D1Database): Promise<string> {
  return (await getSetting(db, 'duckmail_base_url')) || 'https://api.duckmail.sbs';
}

async function duckmailFetch(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) return { ok: false, status: res.status, error: `DuckMail ${res.status}`, data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: `DuckMail 请求失败: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

// Generate: pick a domain, create an account, mint a token. Returns the mailbox
// plus credentials to persist (token + account id + password for re-minting).
export async function duckmailGenerate(
  env: Env,
  opts: { prefix?: string; password?: string }
): Promise<{ ok: boolean; mailbox?: GeneratedMailbox; error?: string }> {
  const base = await duckmailBase(env.DB);

  // 1. domains
  const domRes = await duckmailFetch(base, 'GET', '/domains');
  if (!domRes.ok) return { ok: false, error: domRes.error ?? '获取域名失败' };
  const members: any[] = domRes.data?.['hydra:member'] ?? domRes.data?.member ?? [];
  const active = members.filter((d) => d.isActive !== false);
  const domain = (active[0] ?? members[0])?.domain;
  if (!domain) return { ok: false, error: 'DuckMail 无可用域名' };

  const localPart = (opts.prefix || randStr(10)).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const address = `${localPart}@${domain}`;
  const password = opts.password || randStr(14);

  // 2. create account
  const accRes = await duckmailFetch(base, 'POST', '/accounts', { body: { address, password } });
  if (!accRes.ok || !accRes.data?.id) {
    return {
      ok: false,
      error: accRes.data?.['hydra:description'] || accRes.error || '创建账号失败（可能已存在）',
    };
  }
  const accountId = String(accRes.data.id);

  // 3. token
  const tokRes = await duckmailFetch(base, 'POST', '/token', { body: { address, password } });
  if (!tokRes.ok || !tokRes.data?.token) return { ok: false, error: tokRes.error ?? '获取 token 失败' };

  return {
    ok: true,
    mailbox: {
      email: address,
      duckmail_token: tokRes.data.token,
      duckmail_account_id: accountId,
      duckmail_password: password,
    },
  };
}

// Re-mint a token using the stored password and persist it.
async function duckmailRefreshToken(env: Env, row: TempEmailRow): Promise<string> {
  const base = await duckmailBase(env.DB);
  if (!row.duckmail_password) return '';
  const tokRes = await duckmailFetch(base, 'POST', '/token', {
    body: { address: row.email, password: row.duckmail_password },
  });
  const token = tokRes.data?.token ?? '';
  if (token) {
    await run(
      env.DB,
      'UPDATE temp_emails SET duckmail_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [token, row.id]
    );
  }
  return token;
}

export async function duckmailList(
  env: Env,
  row: TempEmailRow
): Promise<{ ok: boolean; messages?: TempMessage[]; error?: string }> {
  const base = await duckmailBase(env.DB);
  let token = row.duckmail_token;

  let res = await duckmailFetch(base, 'GET', '/messages?page=1', { token });
  if (res.status === 401) {
    token = await duckmailRefreshToken(env, row);
    if (!token) return { ok: false, error: 'DuckMail token 已失效且无法刷新' };
    res = await duckmailFetch(base, 'GET', '/messages?page=1', { token });
  }
  if (!res.ok) return { ok: false, error: res.error ?? '获取邮件失败' };

  const members: any[] = res.data?.['hydra:member'] ?? res.data?.member ?? [];
  const messages: TempMessage[] = members.map((m) => ({
    id: String(m.id),
    from: m.from?.address ?? m.from?.name ?? '未知',
    subject: m.subject ?? '无主题',
    body_preview: typeof m.intro === 'string' ? m.intro.slice(0, 200) : '',
    timestamp: m.createdAt ?? 0,
    has_html: false,
  }));
  return { ok: true, messages };
}

export async function duckmailDetail(
  env: Env,
  row: TempEmailRow,
  messageId: string
): Promise<{ ok: boolean; detail?: TempMessageDetail; error?: string }> {
  const base = await duckmailBase(env.DB);
  let token = row.duckmail_token;

  let res = await duckmailFetch(base, 'GET', `/messages/${messageId}`, { token });
  if (res.status === 401) {
    token = await duckmailRefreshToken(env, row);
    if (!token) return { ok: false, error: 'DuckMail token 已失效' };
    res = await duckmailFetch(base, 'GET', `/messages/${messageId}`, { token });
  }
  if (!res.ok || !res.data?.id) return { ok: false, error: res.error ?? '邮件不存在' };

  const m = res.data;
  // mail.tm: html is a string array; text is a string.
  const html = Array.isArray(m.html) ? m.html.join('\n') : m.html;
  const hasHtml = !!(html && html.length);
  return {
    ok: true,
    detail: {
      id: String(m.id),
      from: m.from?.address ?? '未知',
      to: row.email,
      subject: m.subject ?? '无主题',
      body: hasHtml ? html : m.text ?? '',
      body_type: hasHtml ? 'html' : 'text',
      timestamp: m.createdAt ?? 0,
    },
  };
}

// ==================== cloudflare_temp_email (self-hosted) ====================

interface CfConfig {
  workerDomain: string;
  adminPassword: string;
  domains: string[];
}

async function cfConfig(db: D1Database): Promise<CfConfig> {
  const workerDomain = (await getSetting(db, 'cloudflare_worker_domain')).replace(/\/+$/, '');
  const adminPassword = await getSetting(db, 'cloudflare_admin_password');
  const domainsRaw = await getSetting(db, 'cloudflare_email_domains');
  const domains = domainsRaw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return { workerDomain, adminPassword, domains };
}

async function cfFetch(
  cfg: CfConfig,
  method: string,
  path: string,
  opts: { body?: unknown; params?: Record<string, string> } = {}
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  try {
    let url = `${cfg.workerDomain}${path}`;
    if (opts.params) url += '?' + new URLSearchParams(opts.params).toString();
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-admin-auth': cfg.adminPassword },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) return { ok: false, status: res.status, error: `Cloudflare ${res.status}`, data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: `Cloudflare 请求失败: ${e instanceof Error ? e.message : 'unknown'}`,
    };
  }
}

export async function cloudflareGenerate(
  env: Env,
  opts: { prefix?: string; domain?: string }
): Promise<{ ok: boolean; mailbox?: GeneratedMailbox; error?: string }> {
  const cfg = await cfConfig(env.DB);
  if (!cfg.workerDomain || !cfg.adminPassword) {
    return { ok: false, error: '请先在系统设置填写 Cloudflare 实例地址和管理员密码' };
  }
  const domain = opts.domain || cfg.domains[0];
  if (!domain) return { ok: false, error: '请先在系统设置填写 Cloudflare 邮箱域名' };

  const name = (opts.prefix || randStr(10)).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  // Admin endpoint creates an address; enablePrefix mirrors the reference project.
  const res = await cfFetch(cfg, 'POST', '/admin/new_address', {
    body: { enablePrefix: true, name, domain },
  });
  if (!res.ok || !res.data?.address) {
    return { ok: false, error: res.data?.message || res.error || '创建邮箱失败' };
  }
  const addressId = res.data.id ?? res.data.address_id;
  return {
    ok: true,
    mailbox: {
      email: res.data.address,
      cloudflare_address_id: addressId != null ? String(addressId) : '',
    },
  };
}

// Parse minimal fields out of a raw MIME message (from the admin /mails feed).
function parseRawEmail(raw: string): { from: string; subject: string; text: string; html: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  const body = headerEnd >= 0 ? raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '') : '';
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const getHeader = (name: string): string => {
    const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  const decodeWord = (s: string): string =>
    s.replace(/=\?[^?]+\?[bBqQ]\?[^?]*\?=/g, (w) => {
      try {
        const mm = w.match(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/);
        if (!mm) return w;
        if (mm[2].toLowerCase() === 'b') return decodeURIComponent(escape(atob(mm[3])));
        return mm[3]
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)));
      } catch {
        return w;
      }
    });
  const from = decodeWord(getHeader('From'));
  const subject = decodeWord(getHeader('Subject'));
  const ctype = getHeader('Content-Type').toLowerCase();
  const isHtml = ctype.includes('text/html');
  return {
    from,
    subject,
    text: isHtml ? '' : body,
    html: isHtml ? body : '',
  };
}

function cfExtractMailList(data: any): any[] {
  return data?.results ?? data?.mails ?? data?.emails ?? data?.data?.results ?? data?.data ?? [];
}

export async function cloudflareList(
  env: Env,
  row: TempEmailRow
): Promise<{ ok: boolean; messages?: TempMessage[]; error?: string }> {
  const cfg = await cfConfig(env.DB);
  if (!cfg.workerDomain) return { ok: false, error: 'Cloudflare 实例未配置' };
  const res = await cfFetch(cfg, 'GET', '/admin/mails', {
    params: { limit: '20', offset: '0', address: row.email },
  });
  if (!res.ok) return { ok: false, error: res.error ?? '获取邮件失败' };
  const list = cfExtractMailList(res.data);
  const messages: TempMessage[] = list.map((m: any) => {
    const raw = m.raw ?? m.raw_content ?? m.source_raw ?? '';
    const parsed = raw ? parseRawEmail(raw) : { from: '', subject: '', text: '', html: '' };
    return {
      id: String(m.id ?? m.message_id ?? ''),
      from: m.from ?? parsed.from ?? '未知',
      subject: m.subject ?? parsed.subject ?? '无主题',
      body_preview: (parsed.text || parsed.html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200),
      timestamp: m.created_at ?? m.timestamp ?? 0,
      has_html: !!parsed.html,
    };
  });
  return { ok: true, messages };
}

export async function cloudflareDetail(
  env: Env,
  row: TempEmailRow,
  messageId: string
): Promise<{ ok: boolean; detail?: TempMessageDetail; error?: string }> {
  const cfg = await cfConfig(env.DB);
  if (!cfg.workerDomain) return { ok: false, error: 'Cloudflare 实例未配置' };
  // No single-message admin endpoint; refetch the list and pick by id.
  const res = await cfFetch(cfg, 'GET', '/admin/mails', {
    params: { limit: '20', offset: '0', address: row.email },
  });
  if (!res.ok) return { ok: false, error: res.error ?? '获取邮件失败' };
  const list = cfExtractMailList(res.data);
  const m = list.find((x: any) => String(x.id ?? x.message_id ?? '') === String(messageId));
  if (!m) return { ok: false, error: '邮件不存在' };
  const raw = m.raw ?? m.raw_content ?? m.source_raw ?? '';
  const parsed = raw ? parseRawEmail(raw) : { from: '', subject: '', text: '', html: '' };
  const hasHtml = !!parsed.html;
  return {
    ok: true,
    detail: {
      id: String(messageId),
      from: m.from ?? parsed.from ?? '未知',
      to: row.email,
      subject: m.subject ?? parsed.subject ?? '无主题',
      body: hasHtml ? parsed.html : parsed.text || '',
      body_type: hasHtml ? 'html' : 'text',
      timestamp: m.created_at ?? m.timestamp ?? 0,
    },
  };
}
