# 升级部署指南（Graph + IMAP 双通道）

本文档说明：**项目已经部署在 Cloudflare Workers 上**，现在要把带「IMAP 双通道 + scope 修复」的新代码更新上去，该怎么做。

> 首次全新部署请看 [部署教程 GUIDE.md](./GUIDE.md)，本文只讲**已部署项目的更新**。

---

## 目录

- [先理解一件事：Worker 怎么"替换代码"](#先理解一件事worker-怎么替换代码)
- [这次更新改了什么](#这次更新改了什么)
- [更新前的准备与检查](#更新前的准备与检查)
- [方式 A：直接在现有工程目录更新](#方式-a直接在现有工程目录更新)
- [方式 B：把改动搬到你自己的工程](#方式-b把改动搬到你自己的工程)
- [部署后验证（重要）](#部署后验证重要)
- [同步上游更新（一键 Action）](#同步上游更新一键-action)
- [常见问题](#常见问题)
- [回滚](#回滚)
- [变更记录](#变更记录)

---

## 先理解一件事：Worker 怎么"替换代码"

Cloudflare Worker **没有"单独替换某个文件"的操作**。`wrangler deploy` 每次都会把整个 `src/` 打包成一个 bundle，**整体、原子地**替换掉线上正在跑的版本。

所以"把修改的代码替换上去"这件事，你不需要手动挑文件上传——**只要本地是新代码，跑一次 `wrangler deploy`，线上就整体换成新版了**。

这次更新和你平时 deploy 的**唯一区别**是：多了一个新的数据库迁移（`0004`），**必须在 `deploy` 之前先跑**，否则新代码去查数据库里还不存在的 `mail_protocol` 列会报错。

一句话总结顺序：

```
先跑数据库迁移 (0004)  →  再 wrangler deploy
```

---

## 这次更新改了什么

**功能层面**

1. **修复 `AADSTS90023` 刷新报错**：刷新 token 时不再用 `.default`，改为逐级尝试颗粒化 Graph scope（`Mail.ReadWrite` → `Mail.Read` → `.default`）。用默认 Thunderbird ID 手动授权拿到的令牌现在能正常刷新。
2. **新增 IMAP 通道**：购买 / 领来 / 第三方刷新出来的**仅授权 IMAP 的令牌**（之前在本项目一直报错、读不了信）现在可以直接导入使用，走 IMAP over XOAUTH2。系统自动探测每个账号该用 Graph 还是 IMAP。

**文件层面**

| 类型 | 文件 |
|------|------|
| 🆕 新增 | `src/imap.ts`（IMAP 客户端）|
| 🆕 新增 | `src/imapParse.ts`（IMAP 响应解析 / MIME 解码，纯函数）|
| 🆕 新增 | `src/mail.ts`（读信调度层，自动选通道）|
| 🆕 新增 | `migrations/0004_mail_protocol.sql`（**数据库迁移，必须跑**）|
| 🆕 新增 | `test/imap.test.ts`、`test/stubs/cloudflare-sockets.ts`（测试，可选）|
| ✏️ 修改 | `src/graph.ts`、`src/cron.ts`、`src/types.ts` |
| ✏️ 修改 | `src/routes/accounts.ts`、`src/routes/emails.ts`、`src/routes/external.ts` |
| ✏️ 修改 | `public/assets/app.js`（前端提示文案 + 显示实际通道）|
| 📄 文档 | `README.md`、`README_EN.md`、`docs/API.md`、`docs/GUIDE.md` |

> 数据库迁移 `0004` 只是给 `accounts` 表**新增两列**（`mail_protocol` 默认 `'auto'`、`token_scope` 默认 `''`），**不会删除或修改任何已有数据**。已有账号首次访问时会自动探测协议并回填，无需手工处理。

---

## 更新前的准备与检查

### 1. 确认你有可用的 `wrangler` 登录

```bash
pnpm exec wrangler whoami
```

若未登录，先 `pnpm exec wrangler login`。

### 2. 千万别覆盖你的 `wrangler.toml`

`wrangler.toml` 在 `.gitignore` 里、**不进仓库**。你线上那份是你首次部署时自己配的，里面有你的 **`database_id`**。这次更新**完全不用动它**（唯一可能要改的是下面第 3 点的兼容日期）。

> 如果你是用「方式 B」把代码搬到别处，注意别把仓库里的 `wrangler.toml.example` 当成你的配置——你要用的是你自己那份填好 `database_id` 的 `wrangler.toml`。

### 3. 检查 `compatibility_date`（IMAP 依赖此项）

IMAP 通道用到了 Cloudflare 的 `connect()` TCP socket API，需要足够新的兼容日期。打开你的 `wrangler.toml`，确认：

```toml
compatibility_date = "2026-06-01"   # 或更新的日期
```

如果你的日期比这个老（例如还是 2023/2024 年的），改成 `2026-06-01` 或更新。**不改的话 IMAP 通道会因 `connect()` 不可用而失败。**

### 4. 记下你的 D1 数据库名

后面的迁移命令里要用到。默认是 `outlook-email-db`（在 `wrangler.toml` 的 `[[d1_databases]] database_name` 里）。如果你首次部署时改过名字，把下文命令里的 `outlook-email-db` 换成你实际的名字。

---

## 方式 A：直接在现有工程目录更新

**适用于**：你现在这台机器上、平时用来 deploy 的就是这份工程目录（已经包含本次新代码）。

在工程根目录依次执行：

```bash
# 进入工程目录（换成你的实际路径）
cd /path/to/cf-outlook-email

# 1. 安装依赖（package.json 依赖没变，此步是保险）
pnpm install

# 2. 【关键】先把新迁移应用到线上数据库（注意 --remote）
pnpm exec wrangler d1 migrations apply outlook-email-db --remote

# 3. 部署（整体替换线上 Worker）
pnpm exec wrangler deploy
```

**第 2 步会发生什么**：`wrangler` 只会执行**尚未应用过**的迁移。你线上库已经跑过 `0001~0003`，它们会自动跳过，本次只会应用新的 `0004`。执行时会列出将要应用的迁移并让你确认，输入 `y` 即可。

**第 3 步会发生什么**：打包 `src/` 上传，几秒后线上 Worker 原子切换到新版本。访问你的域名即为新版。

> 可选：部署前想本地自检，可先跑 `pnpm run build`（类型检查）和 `pnpm test`（单元测试）。两者都应通过。

---

## 方式 B：把改动搬到你自己的工程

**适用于**：你线上是从**另一处**（比如你自己 fork/clone 的仓库）部署的，本次新代码不在那份工程里。

### 第 1 步：把文件搬过去

**新增文件**（直接复制到对应路径，目标目录若不存在则新建）：

```
src/imap.ts
src/imapParse.ts
src/mail.ts
migrations/0004_mail_protocol.sql
test/imap.test.ts                    # 可选（仅测试用）
test/stubs/cloudflare-sockets.ts     # 可选（仅测试用）
```

**覆盖文件**（用新版内容替换你工程里的同名文件）：

```
src/graph.ts
src/cron.ts
src/types.ts
src/routes/accounts.ts
src/routes/emails.ts
src/routes/external.ts
public/assets/app.js
```

**文档**（不影响运行，看你要不要同步）：

```
README.md
README_EN.md
docs/API.md
docs/GUIDE.md
docs/UPGRADE.md   # 就是本文件
```

> 如果你的工程是 git 仓库，也可以用 `git pull` / `git merge` 从上游拉这些改动，效果一样。手动拷贝时留意别漏了 `migrations/0004_mail_protocol.sql`——它最关键。

### 第 2 步：在你的工程目录执行更新

和方式 A 的命令完全一样：

```bash
cd /path/to/your/project

pnpm install

# 关键：先跑迁移到线上库
pnpm exec wrangler d1 migrations apply outlook-email-db --remote

# 部署
pnpm exec wrangler deploy
```

---

## 部署后验证（重要）

> ⚠️ **必须实测**：IMAP 通道的真实网络交互（socket 连接、XOAUTH2 认证、文件夹读取）无法在开发环境模拟，只有真机能确认。部署后请务必手动验证一遍。

按顺序验证三件事：

1. **验 IMAP 修复（本次重点）**
   找一个**之前导入后一直报 `AADSTS90023` 的账号**，进后台点「**测试连接**」。
   - ✅ 期望：提示「**IMAP 连接正常**」（不再报错）。
   - 再点进该账号「**查看邮件**」，能列出邮件即说明 IMAP 通道打通。

2. **验 Graph 账号没被改坏**
   找一个原本正常的 Graph 账号，点「测试连接」。
   - ✅ 期望：提示「**Graph API 连接正常**」，邮件照常能读。

3. **验刷新不再报 90023**
   用默认 Thunderbird ID + 手动授权（方式二）拿一个令牌导入，保存后点测试。
   - ✅ 期望：连接正常，不再出现 `AADSTS90023: No applicable permissions were found`。

如果第 1、2 步任一失败，把「测试连接」弹出的**完整报错**记下来（最可能是 IMAP 认证响应解析、或垃圾箱文件夹名在你租户下叫法不同导致的），据此再针对性修复。

---

## 同步上游更新（一键 Action）

本仓库是从上游 [`roseforyou/cf-outlook-email`](https://github.com/roseforyou/cf-outlook-email) 改造而来。上游发新版时，可以用内置的 GitHub Action 把它的更新拉进来。

> ⚠️ **重要前提**：因为本仓库**改过上游的文件**（`src/graph.ts`、`public/assets/app.js` 等），上游若也改了同一处，合并时会**产生冲突**，需要手动解决。这是所有"改过上游代码的 fork"的常态，不是操作出错。

### 怎么触发

1. 打开仓库页 → 顶部 **Actions** 标签
2. 左侧点 **「同步上游 (Sync upstream)」**
3. 右侧 **「Run workflow」** → 保持分支 `main` → 点绿色 **Run workflow**

跑完后去 **Pull requests** 标签看结果。

### 它会怎么做（三种情况）

这个 Action 的核心原则是：**绝不直接改 `main`，只开 PR**。你的改动永远安全。

| 情况 | 结果 |
|------|------|
| 上游没有新提交 | 什么都不做，Action 摘要显示「已经是最新」 |
| 能干净合并 | 自动开 PR（标题带 🔄），并**已帮你跑过 build + test**，结果写在 PR 描述里。两项都 ✅ 就点 **Merge** |
| 有冲突 | 开 PR（标题带 ⚠️），**列出具体冲突文件**，附两种解决方法（网页 / 本地）。你的 `main` 始终不动 |

### 有冲突时怎么解决

推荐**本地解决**（能顺便跑测试确认没揉坏）。PR 描述里会给出针对该分支的命令，大致是：

```bash
git fetch origin
git checkout <PR 里的 sync 分支名>
git merge origin/main
# 编辑器里解决 <<<<<<< ======= >>>>>>> 标记处的冲突
git add -A && git commit
pnpm install && pnpm run build && pnpm test   # 确认没揉坏
git push
```

冲突最可能出现在你改得最多的 `src/graph.ts` 和 `public/assets/app.js`。

### 合并 PR 之后（Action 不负责部署）

这个 Action 只**合并代码**，**不会自动部署**。合并上游更新后，仍需你手动：

1. 若上游**新增了数据库迁移**（`migrations/` 下有新 `.sql`）→ 先跑
   `pnpm exec wrangler d1 migrations apply outlook-email-db --remote`
2. `pnpm exec wrangler deploy`

> 上游地址写死在 `.github/workflows/sync-upstream.yml` 顶部的 `UPSTREAM_URL`。上游若换了仓库地址，改这一行即可。

---

## 常见问题

### Q: 跑迁移时报 `no such table` 或让我选数据库？

说明数据库名对不上。确认命令里的 `outlook-email-db` 与你 `wrangler.toml` 里 `[[d1_databases]] database_name` 一致。

### Q: 部署后页面报 `no such column: mail_protocol` 或 `DB_NOT_READY`？

你**跳过了迁移**，或者迁移没跑到**线上**库（漏了 `--remote`）。重新执行：

```bash
pnpm exec wrangler d1 migrations apply outlook-email-db --remote
```

再刷新页面即可。

### Q: `db:migrate` 这个 npm 脚本能用吗？

`package.json` 里的 `pnpm run db:migrate` 等价于 `wrangler d1 migrations apply outlook-email-db`，但**未带 `--remote`**，行为取决于 wrangler 版本，可能只作用于本地库。**更新线上库请直接用带 `--remote` 的完整命令**（本文一直用的那条），最稳妥。

### Q: IMAP 账号能下载附件吗？

暂不支持。IMAP 通道目前只做列表、正文、删除；附件下载仅 Graph 通道支持。IMAP 账号的附件请求会优雅降级（不报错，但拿不到附件）。

### Q: 已有的一堆账号需要我手动改协议吗？

不需要。迁移后所有账号 `mail_protocol` 默认为 `auto`，首次访问时系统自动探测（先试 Graph，失败退 IMAP）并把结果记住，之后直接走对的通道。

### Q: 批量删除对 IMAP 账号安全吗？

安全。IMAP 批量删除用**单条连接**处理整批（不会为每封邮件各开一个 socket），避免触发 Workers 的并发出站连接上限。

---

## 回滚

万一新版有问题，可以回滚 Worker：

```bash
# 查看部署历史，找到上一个版本的 Version ID
pnpm exec wrangler deployments list

# 回滚到指定版本
pnpm exec wrangler rollback [version-id]
```

**关于数据库迁移**：Worker 回滚**不会**撤销已应用的 `0004` 迁移。但这没关系——`0004` 只是新增了两个**带默认值的列**，旧版代码根本不读它们，所以对回滚后的旧代码**完全无害**。因此整个回滚是安全的，无需手动处理数据库。

---

## 变更记录

按时间倒序。每条标注**是否需要跑数据库迁移**——只有引入新迁移文件的那次才需要，其余 `wrangler deploy` 即可。

### 7. 临时邮箱多服务商（DuckMail + Cloudflare）

在原有 GPTMail 之外，新增两个临时邮箱服务商，生成时可在弹窗中选择：

- **DuckMail**（mail.tm 协议，公共服务，**免配置**）：取域名 → 建账号 → 换 token 收信；token 过期用存储的密码自动重新获取。
- **Cloudflare**（自建 `cloudflare_temp_email` 实例）：走实例 admin 接口建址 / 收信，解析原始 MIME 提取正文。
- **顺带修复「点生成没反应」**：旧版生成直接 `await` 请求上游且无加载提示，上游慢/挂或未配 Key 时静默卡住；现改为弹窗生成，确定按钮显示「处理中…」。
- **配置**：系统设置新增「临时邮箱服务商」卡片——Cloudflare 实例地址 / 管理员密码 / 邮箱域名、DuckMail 接口地址。
- **影响文件**：新增 `src/tempmail.ts` / `migrations/0005_temp_email_providers.sql`；修改 `src/routes/tempEmails.ts`、`src/routes/settings.ts`、`src/types.ts`、`public/assets/app.js`。
- **需要迁移**：✅ **是**。`0005` 给 `temp_emails` 加凭证列，部署前必须先跑：
  ```bash
  pnpm exec wrangler d1 migrations apply outlook-email-db --remote
  ```
- ⚠️ **安全**：DuckMail 账号密码 / token 明文存 D1（与项目现有 refresh_token 存储方式一致）。

### 6. 账号 Token 刷新按钮（单个 + 批量）

账号列表新增两处刷新入口（此前只能靠「测试」间接刷新）：

- **单行「刷新」按钮**：`POST /api/accounts/:id/refresh`，刷新该账号 token 并提示走的是 Graph 还是 IMAP。
- **批量栏「批量刷新」**：对选中账号逐个刷新，服务端单次上限 40 个（留足 Cloudflare 子请求预算），返回成功/失败计数。
- 二者复用 `acquireToken`（刷新 + 持久化轮换后的 refresh_token / scope / 协议 / 状态），与设置页「立即刷新一批」的区别是**针对选中/点击的具体账号**，而非最久未刷的 N 个。
- **影响文件**：`src/routes/accounts.ts`、`public/assets/app.js`
- **需要迁移**：❌ 否，`wrangler deploy` 即可。

### 5. WebDAV 自动备份

- **改动**：新增 WebDAV 自动备份（手动 + 定时），把全部账号导出为文本上传到坚果云 / Nextcloud 等；保留最近 N 份，自动删旧（PROPFIND 列出 + DELETE）。
- **触发**：手动 `POST /api/settings/webdav-backup-now`；定时挂在现有 Cron Trigger 上，按「间隔小时」闸门触发。另有 `POST /api/settings/webdav-test` 连接测试（PUT 探测文件再 DELETE）。
- **配置**：系统设置「WebDAV 自动备份」卡片——开关 / 地址 / 用户名 / 密码 / 间隔 / 保留份数。
- **影响文件**：新增 `src/webdav.ts`；修改 `src/routes/settings.ts`、`src/index.ts`、`public/assets/app.js`。
- **需要迁移**：❌ 否，配置存现有 settings 表，`wrangler deploy` 即可。
- ⚠️ **安全**：备份文件含**全部账号的明文密码与 refresh token**，请确保 WebDAV 目标私密。

### 4. 批量标签 + 每页条数下拉 + 收件箱全选

三项使用体验改进（纯前端 + 后端 batch 接口，无新迁移）：

- **账号批量加/移除标签**：账号批量操作栏新增「添加标签」「移除标签」，勾选账号后在弹窗里选标签，一次性应用到所有选中账号，不必再逐个进编辑页。
  - 后端 `POST /api/accounts/batch` 新增 `add-tags` / `remove-tags` 两个 action（`INSERT OR IGNORE` 幂等，参数按 D1 100 上限分块）。
  - 顺带修复原本失效的「移动分组」：此前未传 `group_id` 被后端当未知操作，现改为弹窗选分组。
- **账号列表每页条数可选**：分页栏加「每页 10/20/30/50/80/100 条」下拉框，选择存 `localStorage` 跨会话记住（默认 50）。
- **收件箱全选**：邮件列表顶部新增「全选本页（已加载 N 封）」复选框，配合「删除选中」可快速批量删；「加载更多」后计数刷新、全选状态重置，避免误删新加载的邮件。
- **影响文件**：`public/assets/app.js`、`src/routes/accounts.ts`
- **需要迁移**：❌ 否，`wrangler deploy` 即可。

### 3. 账号列表分页（前端）

- **改动**：账号管理页的列表改为**分页**显示（默认每页 50 条，可在分页栏下拉切换，见 #4）。此前一次性渲染全部账号，账号量大（数百上千）时首屏 DOM 卡顿明显。
- **实现**：纯前端分页——数据仍一次性加载到内存，但只渲染当前页的行；底部提供首页/上一页/下一页/末页导航，翻页不重新请求后端。
- **附带修正**：批量选择改为**跨页保持**的选择集合，翻页/筛选不再丢失已选项；表头「全选」复选框只作用于**当前页**。
- **影响文件**：`public/assets/app.js`
- **需要迁移**：❌ 否，`wrangler deploy` 即可。

### 2. 修复 IMAP 账号「点开邮件白屏 / 报错」

- **根因**：IMAP 详情此前用 `BODY.PEEK[]` 拉取**整封原始邮件**（含所有附件的 base64 内容），再在 Worker 里整体解析 MIME。带附件/图片的邮件会撑爆 Cloudflare 免费层的 10ms CPU 限制，导致 Worker 崩溃、前端白屏。
- **修复**：改为**两步取信**——先只取 `BODYSTRUCTURE`（结构元数据，极小）定位正文分块，再**只抓正文那一块** `BODY.PEEK[<part>]`（并加 256 KB 上限），附件完全不下载。与 Graph 通道行为对齐，负载与列表一样轻。
- **已知限制**：IMAP 账号仍**不支持下载附件**（正文中的验证码/链接/文字均正常）。
- **影响文件**：`src/imap.ts`、`src/imapParse.ts`、`test/imap.test.ts`
- **需要迁移**：❌ 否，`wrangler deploy` 即可。

### 1. 新增 IMAP 双通道 + 修复 `AADSTS90023`

- **改动 A（scope 修复）**：刷新 token 时不再用 `.default`，改为逐级尝试颗粒化 Graph scope（`Mail.ReadWrite` → `Mail.Read` → `.default`）。用默认 Thunderbird ID 手动授权拿到的令牌现在能正常刷新，不再报 `AADSTS90023: No applicable permissions were found`。
- **改动 B（IMAP 通道）**：仅授权 IMAP 资源的令牌（购买 / 领来 / 第三方刷新出来的常见此类）现在可直接导入使用，走 IMAP over XOAUTH2。系统按 `auto` 策略首次访问自动探测该走 Graph 还是 IMAP，并记住结果。
- **影响文件**：新增 `src/imap.ts` / `src/imapParse.ts` / `src/mail.ts` / `migrations/0004_mail_protocol.sql`；修改 `src/graph.ts`、`src/cron.ts`、`src/types.ts`、`src/routes/{accounts,emails,external}.ts`、`public/assets/app.js`。
- **需要迁移**：✅ **是**。这是唯一引入新迁移的一次，部署前必须先跑：
  ```bash
  pnpm exec wrangler d1 migrations apply outlook-email-db --remote
  ```
