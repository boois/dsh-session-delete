## 这份报告在审什么

- **被审对象**：npm 包 `dsh-delete-sessions@0.2.2`，对应上游仓库 commit `d0c85e3178960baa91beb6ef9150fdb974be880b`（npm registry 记录的 `gitHead`）。
- **与本仓库的关系**：本仓库已验证「已安装文件与上游仓库文件逐字节一致（LF 归一后 7/7 相同）」，因此下文全部结论**直接适用于本仓库的源码基线**，不是只针对某台机器的安装副本。
- **证据缩写**：`<core>` 指 DSH 0.2.2-rc.1 运行时 `app.asar` 解包后的 `node_modules\@deepseek-ai` 目录；`P` / `C` 指插件的 `lib/index.js`、`lib/client.js`。
- **审计方式**：源码逐行读 + 与宿主核心契约逐条比对 + 磁盘实况取证，并包含**非破坏性运行时探测**（只用不存在的 session id 打删除路由，不触碰任何真实会话）；探测之后把插件停用并复测，得到 `405`，确认路由随插件停用而下线。
- **取证脚本**：上述每一步都可复现，脚本在本仓库 [`tools/audit/`](../tools/audit/README.md)（asar 解包核对、npm 包字节一致比对、tar 内容清单、只读端点探针），含运行方法与当时及今天的实测输出。正文一字未改。

---

# 审计：`dsh-delete-sessions` 0.2.2（DSH 第三方插件）

- 审计对象：`C:\Users\ming\.dsh\profiles\desktop\node_modules\dsh-delete-sessions\`（profile 级 bundle，官方=否，enabled=true，fiberPhase=**active**）
- 宿主：DeepSeek Harness 0.2.2-rc.1（桌面 profile `desktop`，web `http://127.0.0.1:7087`）
- 方法：插件 4 个源文件逐行读 + 与官方核心源码逐条比对（`app.asar` 解包 6931 文件）+ 磁盘实况取证 + **非破坏性运行时探测**（只用不存在的 session id 打删除路由）
- 证据缩写：`<core>` = `C:\Users\ming\Documents\deepseek-harness\default-workspace\audit-dsh-delete-sessions\core\dsh\node_modules\@deepseek-ai`；`P` = 插件 `lib/index.js`；`C` = 插件 `lib/client.js`
- 时间：2026-11-09（安装 13:47，审计 13:50–14:55）

## 0. 结论速览

插件**没有恶意行为**：无遥测、无外联、无 `eval`/`new Function`、无子进程、无凭据读取、无路径穿越、无 XSS 注入点；对宿主 9 处契约（服务名、workspaceRegistry 方法形状、`stat/locate`、投影缓存域表键、`workspace/session-stop` 签名、`api-session/removed` 负载、路由注册签名、槽名与 props、primitives/store 用法）**全部核验为正确**，客户端半确实能渲染出红色「删除会话」项并弹出确认框。

真实风险集中在三处：**删除端点绕过宿主鉴权**、**活动会话删不掉且会被复活**、**"永久删除全部对话记录"的声明在真实磁盘上不成立**（子代理子会话、spill 明文、附件、定时任务记录都不清）。

| 级别 | 编号 | 一句话 |
|---|---|---|
| 严重 | S1 | 删除路由绕过宿主全部鉴权层，缺 Origin 即放行；本机任意进程 / 任意 `localhost:PORT` 页面可触发不可逆删除 |
| 严重 | S2 | 不销毁内存会话、不等停止收敛（固定睡 500ms）→ 活动会话删不干净并可复活 |
| 高 | S3 | 不写归档闸门，反先 `unarchive` → 定时任务用同一 id 把"已删"会话重建出来 |
| 高 | M1 | 子代理子会话日志/投影完全不清理，且在 UI 里不可见 = 静默永久残留 |
| 高 | M2 | README「任何一步失败都会整体报错，避免界面里没了磁盘还在」与实际不符：4 处吞错后照常广播「已删」 |
| 中 | M3 | spill 明文工具输出（键 `sha256(sessionId)`）永留 %TEMP%，插件自己也算不出键 |
| 中 | M4 | 附件内容寻址对象成孤儿（本机 656 KB 明文），宿主侧也无 GC |
| 中 | M5 | 删除目标建在自陈为「诊断钩子」的 `locate()` 上；回退分支的动态 import 在桌面 profile 必然失败 = 死代码 |
| 中 | M6 | `dirname(located.path)` 删整目录：今天等价，核心布局演进时会连删兄弟会话 |
| 低 | L1–L7 | 菜单项无权限门禁、无 undo/提示、注入 style 生命周期、order 注释不实、无 `engines.dsh` 护栏、`assets/` 声明未发布、明文+非安全擦除 |

## 1. 插件构成与供应链

| 文件 | 大小 | SHA256 |
|---|---|---|
| `lib/index.js` | 10,825 B | `764D3AC8…541C65` |
| `lib/client.js` | 9,850 B | `341E5BAF…DA2588` |
| `package.json` | 1,467 B | `DA053730…01166B` |
| `README.md` / `cordis.patch.yml` / `LICENSE` / `screenshots.json` | 3,137 / 401 / 1,062 / 69 B | 见取证记录 |

- 全部为 pnpm **HardLink**（registry tarball，非 `link:`/复制）；`pnpm-lock.yaml` 有 `resolution.integrity: sha512-x0ICib44…`；安装日志 `.plugin-manager\logs\operation-mUkjwy\pnpm.log`（`downloaded 1`，pnpm 11.28.5，store `AppData\Local\pnpm\store\v11`）；操作审计 `Roaming\@deepseek-ai\dsh-desktop\plugin-operations\operations.jsonl` 记录 `install → enable settled 0.2.2 → bundle enable`（**不含 registry / 源哈希**）。
- 作者 `linusteller`，MIT，仓库 `github.com/Linusteller/dsh-session-delete`；**`dependencies` 为空**，peer 仅可选 `@deepseek-ai/cordis >=4`；`engines` 只有 `node >= 18`，**无 `engines.dsh` 护栏**。
- 装载路径合法：`dsh.client.platform:"web"` + `exports["./client"]` 命中 `<core>\dsh-client-modules\lib\index.js:783-803`；模块 id `'dsh-delete-sessions'` == 包名（`:877` 强校验）；`require` 的三个 id 都在壳层 seed 表内（壳层 `index-BgUyXZcc.js:195 @947185`）。
- **无重复加载**：profile `cordis.patch.yml` 无该 id 的 insert 行，插件自带 patch 只插 1 行；`plugin_manager` 只见一条 `include:dsh-delete-sessions`。
- 小缺陷：`files`/`screenshots.json` 声明 `assets/01-…png`、`assets/02-…png`，包内**无 `assets/` 目录** → 市场页图裂（`createRequire(...).resolve('<id>/assets/…')` 恒 404，`dsh-client-modules\lib\index.js:1062-1088`）。

## 2. 运行时实测（非破坏性，探测 id = `session-audit-nonexistent-0000`）

`POST http://127.0.0.1:7087/plugins/dsh-delete-sessions/delete`

| 条件 | 结果 | 说明 |
|---|---|---|
| `Origin: http://127.0.0.1:7087` | `404 {"ok":false,"error":"session not found"}` | 路由在线，id 校验先于一切 |
| **无 Origin** | 同上 `404` | **鉴权未拦截**（见 S1） |
| `Origin: http://localhost:7087` | `404` | 主机名匹配即放行 |
| `Origin: http://127.0.0.1:9999` | `404` | **端口不参与校验** |
| `Origin: https://evil.example` | `403 origin not trusted` | Origin 检查存在 |
| `Origin: null` | `403` | — |
| `GET` | `405 method not allowed` | 方法限制存在 |

监听面：仅 `127.0.0.1:7087`（PID 50148）。核心拒绝通配绑定（`<core>\dsh-host-webserver\lib\index.js:304`，报"binding every interface would expose remote code execution to the network"），但 `--host 10.0.0.7` 是官方支持项（`<core>\dsh-web-app\lib\startup.js:25,30`）。

## 3. 严重

### S1 删除端点绕过宿主全部鉴权层

宿主的鉴权不在 webServer 上，而在**每条正经路由自带**：

- `/api` 前缀先 `connection.admit(req)`（401/403）：`<core>\dsh-client-connection\lib\index.js:1049`，服务名 `"connection"`（`:710`），`admit()` 定义 `:742`；
- Host/Origin 同源围栏 + 浏览器持久 cookie：`:241-249`、`BrowserAuth`（`:1034`）、`authorizeIndex`（`:808`）；静态 fallback 也要过（`<core>\dsh-host-frontend-static\lib\index.js:115-132`）；
- 方法级授权 `remoteAccess.decide`：`<core>\dsh-api-remote-access\lib\index.js:208-243`；
- webServer 自身只做派发：`<core>\dsh-host-webserver\lib\index.js:459-471`；注释 `:417` 明说"webServer 不检查 cookie/Host/Origin，**调用方自己负责准入**"。

插件路由 `/plugins/dsh-delete-sessions/delete`（`P:278-282`，`kind:'exact'`）**不在 `/api` 前缀下**，三道防线一道都不走；自建守卫只有 Origin，且：

```js
// P:50  loopbackOrigin()
if (origin === undefined) return true            // 无 Origin 头 → 放行
// 主机名白名单 localhost|127.0.0.1|[::1]|::1，端口不参与
```

后果（本机实测已证）：
1. **本机任意进程**（浏览器发出的一律带 Origin，命令行/脚本不带）无需任何凭据即可 POST 删除；配合 `~/.dsh/storages/session_projcache/sessions/<id>.json` 目录名即 id，可**枚举全部会话 id 后批量不可逆删除**（无确认、无 undo）。
2. **任何跑在 `http://localhost:<任意端口>` 的网页**都满足 Origin 条件（DSH 用户常年开着 vite/webpack dev server）。`fetch` 跨端口是 CORS 跨源，但 `content-type: application/json` 会先触发 preflight——插件路由不处理 OPTIONS，preflight 失败即挡住，所以**当前不构成直接可利用的 CSRF**；防线是 CORS 的副产物，不是插件的设计。
3. 一旦换绑定（`--host`、反代常剥 Origin），破坏面直接扩到可达网络。

修复（按优先）：
- 路径挂到 `/api/plugins/dsh-delete-sessions/delete`，复用 `admit`；或注册前先 `const admission = ctx.get('connection').admit(req)`，未准入直接 401。
- 严格 Origin：要求 `origin === 请求 Host 的确切 origin`（端口参与比较），**删掉 `origin === undefined` 放行**；对无 Origin 的请求要求自定义头（`x-dsh-delete-token`）并接受 `Sec-Fetch-Site: same-origin`。
- 处理 `OPTIONS`，用显式 CORS 策略（只允许同源）取代"靠 preflight 挡住"。
- 二次确认语义：请求体带会话标题匹配（`expectedTitle`）+ 一次性 nonce，避免脚本盲删。

### S2 活动会话删不掉、且会复活

删除序列（`P:191-231`）：`ctx.parallel('workspace/session-stop',{sessionId})` → **固定睡 500ms**（`P:41,198`）→ `unarchiveSession` → `unpinSession` → 遍历 `list()` 做 `detachSession` → 删投影缓存行 → 删日志目录 → `emit('api-session/removed')`。

- 停完没有屏障：官方 `archive-admission` 文档明写该广播"**Nothing is awaited to settlement**"（`<core>\dsh-agent\lib\types\archive-admission.js:20-34`）；工具调用是协作式取消，一个正在跑的长命令 / 子代理回收 / job kill 完全可能超过 500ms。
- 内存会话无法摘除：live 实例的 detach 能力只归 carrier（`<core>\dsh-session\lib\index.js:1889-1905`），公开面只有 `create`（`:1781`）、`flush`（`:1970`）、`get`（`:1999`）；`session/disposed` 是内部路径（`:1949`）。插件从不调用任何销毁 → 实例连同其 store/写句柄留在进程里。
- 写路径会**递归重建目录**：`<core>\dsh-session-persistence-jsonl\lib\index.js:3205,3215-3225`（append/flush 前 `mkdir -p`）。
- 唤醒门被撤：插件不 `archiveSession`，而 `agent/pre-step` 门读的正是 durable 归档集（`<core>\dsh-workspace\lib\index.js:518-520`；`dsh-agent\lib\types\archive-admission.js`）；插件反而先 `unarchiveSession`（`P:202`）→ 该会话之后任何 wake 都能重建日志目录。

后果：删活动会话 = 「目录被后续 flush 重建 / 投影缓存在 `turn:end`、disposal 点重写（`dsh-session-projection-cache\lib\index.js:128-133`）/ UI 行已按 `api-session/removed` 消失」= **磁盘还在、界面里没了**，正是 README 声称杜绝的状态。

修复：
- 顺序改为：`archiveSession(sessionId)`（先落下唤醒闸门）→ `stop` → `await ctx.sessions.flush(session)` → 删文件 → 复核；最后一步之后 `await sessionPersistence.stat(id)`，仍存在则**报 500 且不广播**。
- 用 `ctx.on('workspace/session-stop')` 参与方自身的收敛信号取代固定 `STOP_SETTLE_MS`；若必须等，退避重试而非单发 500ms。
- 活动实例的处理写清边界：核心当前无公开 dispose（本次已确证：全仓无 `session/delete`、`dsh-workspace` 无 `rm`），插件应显式声明"仅删除冷会话；热会话需宿主释放后重试"，并在存在 live 实例时返回 409 而不是继续删。

### S3 定时任务会把「已删」会话复活（已逐行复核）

- 归档守卫只读归档集：`<core>\dsh-schedule\lib\index.js:1340-1341` `archived(sessionId) => workspaceRegistry.archivedSessionIds.includes(...)`；插件在删文件**之前**已把 id 摘出归档（`P:202`）→ 守卫永久失效。
- 复活链：`:1348-1354` `recoverOutstandingExecution → activate(receipt.targetSessionId)`；`:1495-1497` `activate` → `:1499-1507` `createAgent` → `sessionController.create({ sessionId })`，用**同一个 id** 重建会话。
- 稳定 id：`<core>\dsh-schedule\lib\types\storage.js:49-51` `session-schedule-<sha256(taskId)>`；任务记录里持久化 `lastDelivery.targetSessionId`、`involvedSessionIds`、`deliveryHistory` 的 prompt 正文（`:57-67`）。
- 插件对 `schedule` 域（`dsh-schedule\lib\types\storage.js:119-122`，`~/.dsh/storages/schedule/tasks/<taskId>.json`）**零处理**。

后果：删掉一个被计划任务指向的会话 → 下次投递把日志目录按原 id 重建，历史 prompt 写进"已删除"的会话；任务本身继续活着。

修复：删除流程第 0 步扫 `schedule` 域，凡 `target.sessionId === id` / `involvedSessionIds` 含 id / `lastDelivery.targetSessionId === id` 的任务，先 `pause`+`delete`（或把该会话从任务里摘除）；删除时保持归档状态，不 `unarchive`。

## 4. 高

### M1 子代理子会话不清理，且在 UI 不可见

- 子会话 id 是裸 UUID：`<core>\dsh-subagent\lib\index.js:1403` `childId = spec.childId ?? randomUUID()`；目录 = `sessions/<projectKey>/<uuid>/session.v4.jsonl.zstd`。
- 这些 id **不在** `~/.dsh/storages/workspace.json` 的 `sessionIds` 记账里（磁盘实证）→ 插件的 `list()`+`detachSession` 循环（`P:213-216`）碰不到。
- 插件只删 `meta.id` 一个目录（`P:125-165`），不递归 `childIds`。
- 可见性：会话搜索按父会话授权过滤（`<core>\dsh-tool-session-query\lib\index.js:767` `parentValues`）→ 父会话删除后，这些完整对话+工具输出在 UI 里**永久不可见**。

磁盘实证（本机 15 个会话目录中 3 个是裸 UUID 子会话）：`55221956-…` 55,318 B、`7dd286cb-…` 34,346 B、`c633c6f4-…` 67,508 B，各自同名投影缓存 12,703 / 12,285 / 11,656 B —— 正是本次审计派出的三个子代理，删掉本会话不会带走它们。

修复：删除时从会话日志折出 `childIds`（`dsh-subagent` 记账），对每个子 id 递归同一流程（含投影缓存、spill、附件引用）。

### M2 声明与实现不符：吞错后照常广播「已删」

README:44 原文主张「任何一步失败都会整体报错，避免界面里没了磁盘还在」。实际：

| 步骤 | 代码 | 失败行为 |
|---|---|---|
| `unarchiveSession` / `unpinSession` | `P:202-210` | `catch` 后继续 |
| 投影缓存删除 | `P:220-225` | `catch` 后继续 |
| 日志目录定位 | `P:141,148` | 定位失败**静默 `return`** |
| 广播 | `P:231` | 上述任一失败后**照常执行** |

`P` 自身注释写着要避免「UI 里没了、磁盘还在」，实现恰好产出该状态。修复：把每步结果收集为 `failures[]`；除幂等记账类外，任何失败 → 返回 500 + `errors`，**不广播**；广播只在日志目录确认消失后发出。README 增加"不覆盖：附件对象、spill、导出副本、OTel 已外发、子代理子会话、schedule 记录、客户端 leveldb 痕迹"。

## 5. 中

- **M3 spill 明文残留**：键规则 `session-<sha256(sessionId)[0:12]>`（`<core>\dsh-spill-local\lib\index.js:70`，root 前缀 `:17/:35`），实盘 `C:\Users\ming\AppData\Local\Temp\dsh-spill-jZ61NW\` 4 目录 6 文件 **1,008.4 KB** 明文工具输出（如 `session-231ca18f5ede\e615fc6ccff0-glob-results.txt` 746,514 B）；已验证映射 `sha256("session-eab6a232-…") = 0339bbed6f57…`。插件无任何 %TEMP% 逻辑，也拿不到该键。修复：用同一 hash 规则拼路径删除（并在包内 `dependencies` 声明所需能力，不要靠猜宿主实现）。
- **M4 附件孤儿**：`~/.dsh/attachments/v1/objects/<2hex>/<sha256>` 本机 3 对象 **656,481 B** 明文裸字节（`<core>\dsh-attachment-local\lib\index.js:298`）；该模块**全文无 sessionId 记账**，引用只存在于会话日志事件里 → 会话一删即成永久孤儿。宿主侧也无 GC（属宿主已知泄漏）；插件应至少声明该边界，理想做法是删前枚举日志里的附件引用并交给宿主 GC。
- **M5 删除目标建在诊断钩子上 + 回退是死代码**：`locate(meta)` 官方注释自陈 "**Refusal-diagnostics hook**"（`<core>\dsh-session-persistence-jsonl\lib\index.js:2446`，实现 `:2450`），稳定字段是 `stat().location.path`（`:2590`）。回退分支 `await import('@deepseek-ai/dsh-home-paths')`（`P:138`）在桌面 profile **必然** `ERR_MODULE_NOT_FOUND`：profile `node_modules` 顶层只有 `dsh-delete-sessions` + `.pnpm`，`.modules.yaml` 的 `hoistedLocations` 无 `@deepseek-ai` 作用域；loader 的宿主基址只用于解析 entry 自身（`<core>\cordis-plugin-loader\lib\index.js:338-352`），插件内部 import 按自身 URL 向上解析。被 `catch { return; }`（`P:140-142`）静默吞掉 → 一旦 `locate` 漂移，日志**静默不删**。修复：改用 `stat().location.path`，并把 `locate` 当可选加速；动态 import 失败要 `logger.warn`，不能静默。
- **M6 删整目录的演进风险**：`dirname(located.path)`（`P:128-131`）今天精确（每会话独占目录：核心注释 `dsh-session-persistence-jsonl:912-921`；本机 15/15 目录只含 `session.v4.jsonl.zstd`，Windows 无 `session.lock`，`:618-648`）→ **当前过度删除面为 0**。但该目录被核心定义为"one session 拥有、供未来 session-local 工件使用"，且历史上存在过 flat 布局 `<id>.jsonl.zstd`（`:3545-3553`）→ 布局一旦变化，`dirname` 会连删兄弟会话。修复：删 `located.path` 文件本身，目录空了再 `rmdir`。
- **M7 投影缓存删除的健壮性**：域名/表/键**全对**（`<core>\dsh-session-projection-cache\lib\index.js:90,100`；键 = sessionId `:194,:269`；`storageDomain` 服务名 `<core>\dsh-storage-domain\lib\index.js:475`；`ctx.get` 不要求 inject `<core>\cordis\lib\index.js:1347`；`table().delete()` 走写链、内存+磁盘一致 `:190,:277-285`）。缺陷：`storageDomain` 未在 `inject` 声明（`P:35`）→ 无激活顺序保证，该域 HMR 重启后 `get` 返回 `undefined` 即静默跳过；删除失败被吞（见 M2），且日志有 6 次退避重试、投影缓存**没有**。修复：`inject: [..., 'storageDomain']`，失败进 `failures[]`。

## 6. 低

1. **L1 菜单项无权限门禁**：宿主内置项都过 `allowed()`/`useSessionAccess`（`<core>\dsh-client-ui-workspace\lib\client.js:4343,:4357`），插件行（`C:174-188`）不查 → 无 `session/delete` 权限时仍可见可点，点击后才由路由 403/404 报错。
2. **L2 不可逆且无 undo/提示**：归档路径有 undo（宿主 `RowActionToast`），插件删除后无 toast、无回收站、无宽限窗（可加 5 秒软删除 + 撤销）。
3. **L3 注入 style 的生命周期**：`ensureStyle()` 在对话框 `useEffect` 里 `document.head.appendChild`（`C:48-71`），不在模块工厂期 → 不被 loader 样式认领/回收（`<core>\dsh-client-modules\lib\client.js:814,820,826-827` `claimStyles/removeOwnedStyles`）→ 卸载/HMR 后节点残留；升级改了 CSS 时因 id 命中，**新样式永不写入**（陈旧样式）。
4. **L4 order 注释不实**：`C:5` 称"归档会话(order 400)正下方"。宿主内置项全走 `ctx.contextMenus.register`：pin 100 / rename 200 / fork 300 / **copy Session ID 450** / **archive 600**(`afterContent:true`)（`dsh-client-ui-workspace\lib\client.js:4345-4382`）；槽目录原文：槽位条目渲染在内置项**之前**，"Slot priority cannot replace them"（`dsh-cordis-client-runner\lib\client.js:7218-7219`）。实际落点＝「复制 Session ID 之下、归档之上」。功能无碍，文案不实；该槽 `occupants: []`（`:7258`），本机没有它假定的 400/450 邻居。
5. **L5 无版本护栏**：`engines` 只有 `node>=18`，无 `engines.dsh`，而它耦合 **14 处宿主 API**（`sessionPersistence.stat/locate`、`workspaceRegistry.list/unarchive/unpin`、`entity.detachSession`、`ctx.parallel('workspace/session-stop')`、`sessions.get`、`storageDomain` 域表、`emit('api-session/removed')` 白名单、`webServer.register`、`dsh.client.platform`、槽名/props、`hooks→useX` 约定、`createSnapshotStore`、4 个 primitives 导出、`/plugins` combo 装载）。宿主小版本漂移即静默降级（见 M5）。建议加 `engines.dsh` 范围并在启动时对每个契约做能力探测（缺则显式 warn 并禁用菜单项）。
6. **L6 `assets/` 声明未发布** → 市场页截图 404。
7. **L7 隐私面**：`session.v4.jsonl.zstd` 只 zstd 无加密，插件用 `rm` 非安全擦除（扇区级可恢复）；删除不触及导出副本（本机 `Downloads\agentbox-session-…html` 676,402 B 明文，文件名含会话 id）、客户端 leveldb 痕迹（`Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\000005.ldb` 内可见多个 session id）、OTel 已外发日志（`<core>\dsh-session-telemetry-otel\lib\index.js:13-21,:149-155` 带 sessionId 经 HTTP 外发，**不可撤回**）。这些是宿主/环境既有面，插件的"永久删除全部对话记录"文案不应暗示覆盖它们。
8. **搜索索引（条件性）**：派生索引自愈（`<core>\dsh-session-query-sqlite\lib\index.js:656-688,:760-767` persistentDeletes → `DELETE FROM persisted_docs/persisted_sessions`），日志删除成功即跟随清理；若日志删不掉（M5 路径），索引继续命中已删会话正文。本机 `config.path` 由 launcher 注入且 `.dsh` 下 0 个 `.sqlite/.db` → 索引实际路径无法判定。

## 7. 核查通过项（防误报）

1. `inject = ['sessionPersistence','workspaceRegistry','sessions']` 三个服务名全部存在（`<core>\dsh-session\lib\index.js:1748`、`dsh-workspace\lib\index.js:376`、`dsh-session-persistence\lib\index.js:265`，jsonl 后端继承 `dsh-session-persistence-jsonl:2403`）；缺服务时 Cordis 只把插件置未激活、不炸 profile（`<core>\cordis\lib\index.js:611-637`）。
2. `workspaceRegistry.list()` 同步（`:454`，注释" Synchronous workspace projection"）；`entity.detachSession(sessionId)` 无 workspaceId 首参（`:148`）；`unarchiveSession` `:553` / `unpinSession` `:598` 幂等且返回 Promise → 插件用法正确。
3. `sessions.get(id)`（`:1999`）、`sessionPersistence.stat(id)` 不存在返回 `undefined` 不抛（`dsh-session-persistence-jsonl:2570-2597`）。
4. `locate(meta)` 参数是 header、返回 `{path}`；`dirname` 恰为单会话目录；一并删掉的兄弟文件（`session.lock` `:648/:2975`、历史代 `session.v3.jsonl.zstd` `:3556`、`session.migration.*.tmp` `:1957`、写入临时 `*.<hex>.tmp` `:3266`）**属正确范围**，附件不在该目录（`dsh-attachment-local:1000`）。
5. `ctx.parallel('workspace/session-stop', { sessionId })` 与官方派发逐字同形（`<core>\dsh-workspace\lib\index.js:623`），监听方 payload 一致（`dsh-agent:36`、`dsh-jobs:32`、`dsh-subagent:2534`、`dsh-schedule:2192`）；无人监听时 `parallel` = `allSettled([])` 不抛（`cordis:853-857`）。
6. `api-session/removed` 在转发白名单且负载约定是**裸 sessionId**（`<core>\dsh-api-remotes\lib\types\remote-events.js:22`；签名 `dsh-api-session-controller\lib\typert.host.js:4904-4906`；官方发送方同模块 `:3829`；浏览器侧 `lib\client.js:4286` → `handleSessionRemoved` → `recordMutation({kind:'remove'})` 精确按 id 删行 `manager.js:620-643,:778-779`）。主面板回落由宿主自理（`dsh-client-ui-session\lib\client.js:929-940`）→ 插件无需自己处理选中态。
7. 路由注册签名正确（`webServer.register({kind:'exact'})` `:375-382`，重复抛错、返回 disposer，插件放在 `effect` 里回收 ✔）；exact 优先于 `/plugins` 前缀资源路由，POST 不被吞（`dsh-host-webserver:579-586` 对资源才 405）。
8. 浏览器契约全部命中官方定义：槽 `sidebar.workspaces.session.menu.item` 的 `ownerProps {sessionId, displayTitle}` + 官方示例同款解构（`dsh-cordis-client-runner\lib\client.js:7215-7261`）；`hooks:{x}→useX` 映射有实现（`dsh-client-ui-renderer\lib\client.js:444-459` + `II()` 于壳层 `:122 @488873`）；`shell.overlay` 是官方常驻浮层，occupants 里就有 `SessionArchiveConfirmDialog`（`:5991-6009`）；`createSnapshotStore` 返回 `{getSnapshot,subscribe,update,set}`（壳层 `:122 @487521`），插件**没有**把 store 当 hook 调，而是经 hooks 绑定成 selector hook（`renderer:155-160` `useSyncExternalStoreWithSelector`）→ 与宿主归档确认同构（`dsh-client-ui-workspace:5817,:5875,:4200`），**确认框会出现**。
9. primitives 导出齐备且用法合法：`MenuItemButton{children,shortcut,icon,current,disabled,disabledReason,danger,separatorBefore,onSelect}`（壳层 `:131 @659975`）、`Modal{open,onClose,title,closeLabel,description,children,footer,className,…}` 且 **createPortal 到 body**（`:131 @684921`，故不受 overlay 层 click-through 影响）、`Button` 变体表含 `outline`、`IconTrashOutlineRegular` 存在（`:193 @890444`）且宿主「删除工作区」用的就是它（`dsh-client-ui-workspace:5943,:5975`）；`danger:true` 走宿主真危险色 `--dsw-alias-state-error-primary`（`index-lh_YM6sT.css` `._danger_…`）。
10. 装载与安全边界：combo 只服务预生成 URL、chunk 名白名单正则 + rev 全等 + 包目录 join（`dsh-client-modules\lib\index.js:198,:1006-1023`）→ 无路径穿越/越界读；插件 `require` 的 3 个 id 都在 seed 表内。
11. 删除目标无穿越：会话目录名单由 `encodeSegment` 约束（`dsh-session-persistence-jsonl:858-870`，中和 `../`、绝对路径、NUL）；本机 15/15 id 形如 `session-<uuid>`/裸 uuid，编码恒等 → 回退分支 `child.name === meta.id`（`P:160`）在本机等价（全树扫描 0 个含 `~XXXX` 转义名）。
12. 无遥测/外联/eval/子进程/凭据：`P` 只 import `node:fs/promises` + `node:path`（`:28-29`），唯一破坏操作 `rm(target,{recursive,force})`（`:96`），body 上限 16 KiB（`:33,:88`）；`C` 唯一网络调用是同源 `fetch`（`:109-114`，`credentials:'same-origin'`）；无 `innerHTML`/`dangerouslySetInnerHTML`/`sendBeacon`/`Worker`/`iframe`，`displayTitle`/`sessionId`/服务端 `error` 均作 React 文本子节点渲染（`:151-163`）→ 无 HTML 注入。
13. 磁盘 15 个会话目录与 15 个投影缓存 1:1 对齐，无孤儿；`~/.dsh/storages/` 本机只有 `session_projcache` + `workspace.json`（1,921 B，含 `global.archivedSessionIds`）；无 `.deleting`/`.tmp` 中断残留（`dsh-storage-json:509-543` 的 rename-then-rm 在本机干净）。

## 8. 建议落地顺序

1. **S1**：路由挂 `/api/` 前缀或显式 `connection.admit(req)`；删除 `origin === undefined` 放行；Origin 精确到端口；处理 OPTIONS；加 nonce/标题匹配。
2. **S3 + S2 闸门**：保持归档（不 `unarchive`），先清理 `schedule` 任务，再删文件。
3. **S2 收敛**：`archiveSession` → `stop` → `flush` → 删 → `stat` 复核；有 live 实例返回 409；广播只在复核通过后发出。
4. **M2**：失败聚合，不吞错，不假广播；README 文案与实现对齐（并声明覆盖边界）。
5. **M1**：递归子代理子会话（含投影缓存 / spill / 附件引用）。
6. **M5/M6/M7**：`stat().location.path` 取代 `locate`；删文件再 `rmdir`；`storageDomain` 进 `inject`。
7. **M3/M4**：spill 用同规则清；附件声明边界或交宿主 GC。
8. **L1–L7**：权限门禁、undo/软删除、style 认领、注释与文案订正、`engines.dsh` + 契约能力探测、补 `assets/`、隐私文案。

## 9. 评级

以"第三方插件补齐宿主缺失能力"（本次确证：核心**没有**任何会话删除实现——全仓无 `session/delete` 端点、`dsh-workspace` 无 `rm`，官方只有归档）的尺度衡量：

- 代码质量与对宿主契约的理解：**高于市场平均**，9 处契约全部命中，装载/样式/命名/幂等设计克制，无越权与外联。
- 作为**不可逆破坏性**工具：当前**不建议直接启用**。S1（无鉴权 + 本机进程可盲删）与 S2/S3（删不干净、会复活）叠加，意味着它既可能删掉本不该删的东西（本机进程/脚本路径），又可能没删掉本该删的东西（活动会话、子会话、spill、附件、任务）。
- 打 S1/S2/S3/M1/M2 五条补丁后，可作为可接受的日常工具；M3–M7 属完善项。
