// Worker environment bindings
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  COOKIE_SECRET: string;
  GPTMAIL_API_KEY?: string;
}

// Database row types
export interface SettingRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  id: number;
  name: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

// Mail channel for an account. 'auto' = not yet probed (dispatcher decides and
// rewrites it); 'graph' = Microsoft Graph REST; 'imap' = IMAP over XOAUTH2.
export type MailProtocol = 'auto' | 'graph' | 'imap';

export interface AccountRow {
  id: number;
  email: string;
  client_id: string;
  refresh_token: string;
  password: string;
  group_id: number;
  remark: string;
  status: string;
  // Added in migration 0004. Older rows read back as NULL until migrated, so
  // consumers must treat missing values as the defaults ('auto' / '').
  mail_protocol: MailProtocol;
  token_scope: string;
  created_at: string;
  updated_at: string;
}

// Normalized message shape shared by both channels (Graph + IMAP), so routes and
// the frontend see one consistent structure regardless of how it was fetched.
export interface MailMessage {
  id: string;
  subject: string;
  from: { name: string; address: string };
  toRecipients?: Array<{ name: string; address: string }>;
  ccRecipients?: Array<{ name: string; address: string }>;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  body?: { contentType: string; content: string };
}

export interface TempEmailRow {
  id: number;
  email: string;
  source: string;
  remark: string;
  // Added in migration 0005. Per-mailbox credentials for multi-provider temp email.
  // duckmail_*: mail.tm account token / id / password (token re-minted from password
  // on expiry). cloudflare_address_id: id from a self-hosted cloudflare_temp_email
  // instance (mail fetch uses the instance admin API, not a per-mailbox token).
  duckmail_token: string;
  duckmail_account_id: string;
  duckmail_password: string;
  cloudflare_address_id: string;
  created_at: string;
  updated_at: string;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

// Graph API types
export interface GraphTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export interface GraphMailMessage {
  id: string;
  subject: string;
  from: {
    emailAddress: {
      name: string;
      address: string;
    };
  };
  toRecipients: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  body?: {
    contentType: string;
    content: string;
  };
}
