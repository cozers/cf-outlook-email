# 详细部署教程

本教程面向零基础用户，一步步教你把 Outlook 邮件管理工具部署到 Cloudflare。

## 目录

- [前置准备](#前置准备)
- [第一步：安装工具](#第一步安装工具)
- [第二步：获取代码](#第二步获取代码)
- [第三步：登录 Cloudflare](#第三步登录-cloudflare)
- [第四步：创建数据库](#第四步创建数据库)
- [第五步：配置密码](#第五步配置密码)
- [第六步：初始化数据库](#第六步初始化数据库)
- [第七步：部署](#第七步部署)
- [第八步：添加邮箱账号](#第八步添加邮箱账号)
- [本地开发](#本地开发)
- [关于 Client ID](#关于-client-id)
- [Token 过期处理](#token-过期处理)
- [获取 client_id 和 refresh_token](#获取-client_id-和-refresh_token)
- [API 端点](#api-端点)
- [免费版限制](#免费版限制)
- [暂不支持的功能](#暂不支持的功能)
- [常见错误](#常见错误)
- [手动测试清单](#手动测试清单)

---

## 前置准备

你需要：

1. **一个 Cloudflare 账号**（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com/)）
2. **Node.js 18+**（下载：[nodejs.org](https://nodejs.org/)）
3. **pnpm**（安装：终端运行 `npm install -g pnpm`，也可以用 npm 替代）

邮箱凭证（client_id / refresh_token）不需要提前准备，部署后可以在 Web 界面一键获取。

---

## 第一步：安装工具

确认 Node.js 和 pnpm 已安装：

```bash
node --version    # 应该显示 v18.x 或更高
pnpm --version    # 应该显示版本号
```

如果没有 pnpm，用 npm 也行，把后续命令中的 `pnpm` 替换为 `npm` 即可。

---

## 第二步：获取代码

```bash
git clone https://github.com/roseforyou/cf-outlook-email.git
cd cf-outlook-email
pnpm install
```

安装完成后你会看到 `node_modules` 目录。

---

## 第三步：登录 Cloudflare

```bash
pnpm exec wrangler login
```

浏览器会弹出 Cloudflare 授权页面：
1. 点击 **"Allow"** 允许访问
2. 看到 "Successfully logged in" 就行了

> 如果提示 wrangler 命令不存在，用 `pnpm exec wrangler` 替代 `wrangler`。

---

## 第四步：创建数据库

```bash
pnpm exec wrangler d1 create outlook-email-db
```

命令会输出类似这样的内容：

```
✅ Successfully created DB 'outlook-email-db'
database_id = "abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**复制 `database_id` 的值**，然后：

```bash
cp wrangler.toml.example wrangler.toml
```

打开 `wrangler.toml`，把 `REPLACE_WITH_YOUR_DATABASE_ID` 替换为你的 database_id。

---

## 第五步：配置密码

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD
```

提示 `Enter a secret value:` 时，输入你想设的**登录密码**（输入时不显示，直接打完回车）。

```bash
pnpm exec wrangler secret put COOKIE_SECRET
```

提示时输入一串**随机字符**（至少 32 位），例如键盘乱敲：`aK3mX9pQ2wE8rT6yU1iO4sD7fG0hJ5l`。

> 可选：如果你有 GPTMail API Key，也可以配置临时邮箱功能：
> ```bash
> pnpm exec wrangler secret put GPTMAIL_API_KEY
> ```

---

## 第六步：初始化数据库

```bash
pnpm exec wrangler d1 migrations apply outlook-email-db --remote
```

提示 "continue?" 时输入 `Y` 回车。

---

## 第七步：部署

```bash
pnpm exec wrangler deploy
```

部署成功后会输出你的访问地址：

```
https://outlook-email.你的用户名.workers.dev
```

打开这个地址，用第五步设的密码登录。

---

## 第八步：添加邮箱账号

### 方式一：一键授权（推荐，最简单）

1. 登录后点击 **"+ 添加账号"**
2. 点击蓝色区域的 **"一键授权"** 按钮
3. 弹出微软登录窗口，用你的 Outlook / Hotmail 邮箱登录
4. 点击 **"是"** 允许授权
5. 窗口自动关闭，**Client ID** 和 **Refresh Token** 自动填入
6. 在"邮箱"栏填入刚授权的邮箱地址
7. 点击 **"确定"** 保存

### 方式二：手动添加

如果你已经有 client_id 和 refresh_token：
1. 点击 **"+ 添加账号"**
2. 填写邮箱、Client ID、Refresh Token
3. 点击 **"确定"**

### 方式三：批量导入

1. 点击 **"批量导入"**
2. 每行一个账号，格式：`邮箱----密码----client_id----refresh_token`
3. 选择分组，点击 **"确定"**

---

## 本地开发

如果想先在本地试试再部署：

```bash
# 创建本地配置
cat > .dev.vars << 'EOF'
ADMIN_PASSWORD=test123
COOKIE_SECRET=aK3mX9pQ2wE8rT6yU1iO4sD7fG0hJ5laK3mX9pQ
EOF

# 初始化本地数据库
pnpm exec wrangler d1 migrations apply outlook-email-db --local

# 启动
pnpm run dev
```

访问 http://localhost:8787，用 `test123` 登录。

---

## 关于 Client ID

### 什么是 Client ID？

Client ID 是在 Microsoft Azure 注册应用时生成的唯一标识。它不是密码，本身不敏感。一个 Client ID 可以用来授权多个 Outlook 邮箱。

### 默认 Client ID

本项目默认使用 **Mozilla Thunderbird 的公开 Client ID**（`9e5f94bc-e8a4-4e73-b8be-63364c29d753`）：
- 公开免费，无需注册 Azure 应用
- 已配置 Graph Mail.Read 权限
- 支持所有 Outlook / Hotmail / Live 个人邮箱

> ⚠️ **重要：默认 Thunderbird ID 无法用于网页「一键授权」。**
> 它是桌面客户端用的，注册的回调地址不含你的 Worker 域名。网页一键授权时微软会拒绝并报
> `invalid_request ... redirect_uri is not valid`。
> 默认 ID 仅适用于：① **批量导入 / 手动填入**已有的 refresh_token；② 下文的 `https://localhost` 手动授权流程（**免注册 Azure**，见下）。
> 想用一步到位的网页「一键授权」，则需[注册自己的 Azure 应用](#自己注册-azure-应用)并登记 Worker 回调地址。

> ✅ **不想注册 Azure？用「方式二：手动授权」即可。**
> 因为 `https://localhost` 本就是 Thunderbird 公开应用登记过的回调地址，所以用默认 Client ID 也能授权。
> 添加账号弹窗里的「方式二」已把这个流程做成半自动：点「打开授权页」登录 → 复制跳转后
> `https://localhost?code=...` 的完整网址粘回 → 点「获取 Token」自动填入。无需注册任何应用。

### 可以使用其他 Client ID 吗？

可以。只要该应用在 Azure 注册时配置了 `Mail.Read` 权限就行。

**注意：** 仅有 IMAP 权限的 Client ID 会导致"测试连接成功但查看邮件报 401"。遇到这种情况，编辑账号 → 点"重新授权此邮箱"即可。

| 权限类型 | 测试连接 | 读邮件 |
|----------|:--------:|:------:|
| Graph Mail.Read | ✅ | ✅ |
| 仅 IMAP | ✅ | ❌ (401) |

---

## Token 过期处理

- 系统会**自动续期**：每次读邮件时自动保存新 refresh_token
- 只要定期使用（如每周看一次邮件），token 不会过期
- 长期未用导致过期（状态变 error）→ 编辑账号 → 点"重新授权此邮箱"

---

## 获取 client_id 和 refresh_token

> 推荐使用 Web 界面的"一键授权"功能，无需手动操作以下步骤。

### 使用已有的 Client ID

如果你有现成的 client_id（如 Thunderbird 的），可以直接手动授权：

**1. 浏览器打开（替换 YOUR_CLIENT_ID）：**

```
https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://localhost&scope=Mail.Read%20offline_access&response_mode=query
```

**2. 登录并授权后，浏览器跳转到 `https://localhost?code=xxx...`（页面报错正常）**

**3. 复制 `code=` 后面的值，用 curl 换 token：**

```bash
curl -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "grant_type=authorization_code" \
  -d "code=复制的code" \
  -d "redirect_uri=https://localhost" \
  -d "scope=Mail.Read offline_access"
```

返回的 `refresh_token` 就是你需要的值。

### 自己注册 Azure 应用

如果你想用自己的 Client ID（**网页一键授权必须走这一步**）：

1. 加入 [M365 开发者计划](https://developer.microsoft.com/en-us/microsoft-365/dev-program)（免费）或注册 [Azure 免费账号](https://azure.microsoft.com/free/)
2. 打开 [Azure 应用注册](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
3. 新注册 → 名称随意 → 账户类型选"任何组织目录和个人账户"（**必须包含个人账户**，否则 outlook.com / hotmail 无法登录）
4. **重定向 URI**：平台选 **Web**，填入你部署的 Worker 回调地址：
   ```
   https://<你的-worker-域名>/api/oauth/callback
   ```
   例如 `https://outlook-email.xxx.workers.dev/api/oauth/callback`（也可在添加账号弹窗里点"复制回调地址"直接拿到）。
   > 这一步是关键：网页一键授权报 `redirect_uri is not valid` 就是因为这里没登记对。
   > 如果你只想用手动 `curl` 流程，则改填 `https://localhost`。
5. 注册后在"概述"页面复制 **应用程序(客户端) ID**，填到添加账号弹窗的 **Client ID** 框
6. 左侧 "API 权限" → 添加 Microsoft Graph → 委托权限 → 勾选 `Mail.Read` 和 `offline_access`

---

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录 |
| `/api/auth/logout` | POST | 退出 |
| `/api/auth/me` | GET | 登录状态 |
| `/api/groups` | GET/POST | 分组列表/新增 |
| `/api/groups/:id` | PUT/DELETE | 修改/删除分组 |
| `/api/accounts` | GET/POST | 账号列表/添加 |
| `/api/accounts/export` | GET | 导出账号 |
| `/api/accounts/batch` | POST | 批量操作 |
| `/api/accounts/:id` | GET/PUT/DELETE | 账号详情/修改/删除 |
| `/api/accounts/:id/test` | POST | 测试连接 |
| `/api/accounts/:id/emails` | GET | 邮件列表 |
| `/api/accounts/:id/emails/:msgId` | GET | 邮件详情 |
| `/api/settings` | GET/PUT | 系统设置 |
| `/api/temp-emails` | GET/POST | 临时邮箱 |
| `/api/temp-emails/:id` | DELETE | 删除临时邮箱 |
| `/api/temp-emails/:id/messages` | GET | 临时邮件列表 |
| `/api/temp-emails/:id/messages/:msgId` | GET | 临时邮件详情 |
| `/api/oauth/authorize` | GET | 获取授权 URL |
| `/api/oauth/callback` | GET | OAuth 回调 |

---

## 免费版限制

| 资源 | 免费额度 | 对本项目影响 |
|------|----------|-------------|
| Workers 请求 | 10 万/天 | 单人远用不完 |
| Workers CPU | 10ms/请求 | Graph 走 JSON fetch，安全 |
| 外部 subrequest | 50/次请求 | 单账号单请求，不会超 |
| 并发出站连接 | 6 | 顺序读取不受影响 |
| D1 存储 | 5GB | 远超所需 |
| D1 读/写 | 500 万读、10 万写/天 | 远超所需 |

---

## 暂不支持的功能

- **IMAP 邮件读取** — Workers 不支持 TCP 长连接，已由 Graph API 替代
- **refresh_token 加密** — 当前明文存储在 D1（TODO）
- **邮件附件下载** — 仅显示附件标识
- **邮件缓存** — 每次实时获取，不缓存到数据库

---

## 常见错误

### `invalid_grant` / `grant is expired`

Token 已过期。编辑账号 → 点"重新授权此邮箱"获取新 token。

### 测试连接成功但读邮件 401

Client ID 只有 IMAP 权限。编辑账号 → "重新授权"切换到 Thunderbird 授权。

### 一键授权报 `invalid_request ... redirect_uri is not valid`

**最常见的问题。** 你在用默认 Thunderbird Client ID 做网页一键授权，但 Thunderbird 应用没有登记你的 Worker 回调地址，微软直接拒绝。

解决：[注册自己的 Azure 应用](#自己注册-azure-应用)，在重定向 URI（平台 = Web）填入
`https://<你的-worker-域名>/api/oauth/callback`（添加账号弹窗里可一键复制），
再把你应用的 Client ID 填进 **Client ID** 框，重新授权即可。

> 默认 Thunderbird ID 只适合「批量导入 / 手动填入已有 token」，不适合网页一键授权。

### 授权时提示"这不是正确的页面"

`redirect_uri` 与 Client ID 注册的不匹配。手动 `curl` 流程使用 `https://localhost`。

### Azure 无法注册应用

个人 Outlook 账号需要先加入 [M365 开发者计划](https://developer.microsoft.com/en-us/microsoft-365/dev-program)（免费）。

### 登录后跳回登录页

确认 `COOKIE_SECRET` 已配置，浏览器允许 Cookie。

### wrangler 命令不存在

不需要全局安装，用 `pnpm exec wrangler` 即可。

---

## 手动测试清单

1. 访问登录页 → 输入错误密码 → 提示错误
2. 输入正确密码 → 登录成功 → 跳转主页
3. 新建分组 → 编辑分组 → 删除分组
4. 一键授权添加账号 → 测试连接
5. 批量导入账号
6. 邮件查看 → 选择账号 → 查看列表 → 查看详情
7. 导出账号 → 复制/下载
8. 批量选中 → 移动分组/停用/删除
9. 修改设置 → 退出 → 用新密码登录
10. 切换深色/浅色/自动主题
