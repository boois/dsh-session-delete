# @boois/dsh-delete-sessions

> **本仓库是上游 <https://github.com/Linusteller/dsh-session-delete> 的 fork，由 @boois 维护。**
> 包名已改成 scoped 的 `@boois/dsh-delete-sessions`（当前版本 **v0.3.0**）：它和上游 npm 包 `dsh-delete-sessions` 是两个不同的包名，装在一起也**不互相覆盖**、不抢同一个装载 id。上游的问题修在这里，上游本体不受影响。

给 DeepSeek Harness 增加真正的 **「删除会话」**：从侧栏每个会话的「…」菜单永久删除它，而不是只能「归档」。0.3.0 之后它还多做一件事——删之前先告诉你**这一刀会带走什么**，删不干净就**明说**。

## 为什么需要这个插件

DSH 内建的「归档」（archive）只做一件事：把会话 id 加进 `archivedSessionIds` 集合，把它从分组界面里藏起来。它**从不删除磁盘文件**——会话日志（`~/.dsh/sessions/<project>/<id>/session.v4.jsonl.zstd`）和投影缓存（`~/.dsh/storages/session_projcache/sessions/<id>.json`）会一直留在硬盘上。

对隐私敏感的场景，「藏起来」不是「删掉」。本插件补上缺失的「删除」：先落闸门 → 停活动 → 等收敛 → 删投影缓存与日志文件 → 复核文件确实消失 → 才广播移除事件让界面刷新。

## 为什么要改它

动机很实在：**它是我们本地唯一能真正删会话的工具**（宿主只有归档）。但 0.2.2 版本有三条严重问题，每一条都够让「删除」这个动作变得不可信：

1. **删除端点没有鉴权。** `/plugins/dsh-delete-sessions/delete` 不走宿主任何一条鉴权链，而自建的守卫在 `origin` 头缺失时**直接放行**——实测本机任意进程、任意 `http://localhost:<任意端口>` 的来源都能触发不可逆删除。详见 `docs/AUDIT-0.2.2.md`。
2. **删的是文件，不是会话。** 它不销毁内存里的会话实例，只固定睡 500ms 就去删文件；而宿主的写路径在 append/flush 前会 `mkdir -p` 重建目录 → 结果就是「**界面里没了、磁盘还在**」。详见 `docs/AUDIT-0.2.2.md`。
3. **删之前先把门打开。** 它删文件前先 `unarchiveSession`，等于亲手摘掉唤醒闸门；定时任务随后会用**同一个 id** 把「已删」的会话连同历史 prompt 一起重建出来。详见 `docs/AUDIT-0.2.2.md`。

两条高危，同样值得单列：

- **子代理子会话完全不清理，而且在 UI 里不可见**：子会话 id 是裸 UUID、不在工作区记账里，父会话删掉后这些完整对话+工具输出永久静默残留。详见 `docs/AUDIT-0.2.2.md`。
- **「任何一步失败都会整体报错」是宣传，不是实现**：4 处 `catch` 吞掉错误后照常广播「已删除」，界面按广播删行，磁盘原封不动。详见 `docs/AUDIT-0.2.2.md`。

## 0.3.0 改了什么

逐条对应上面的问题，事实与实现一一对齐：

1. **鉴权接回宿主。** 删除端点改为调用宿主 `connection` 服务的 `admit()`，并要求 `peer.principal.kind === 'owner'`——与宿主保护自己破坏性路由的判据一致（`dsh-client-connection/lib/index.js:830`）；自建的「回环 Origin 白名单 + 缺 Origin 放行」整套删掉。Origin 存在时还须与请求 `Host` **精确同源**（端口参与比较）。
   → 你能看到的效果：命令行脚本、别的网页、别的端口统统删不动；在 DSH 界面里点删除照旧顺畅。
2. **新增只读预检端点 `plan`。** 路由随包名一起 scoped：`GET /plugins/@boois/dsh-delete-sessions/plan?sessionId=…` 返回 `{ exists, live, archived, tasks[], children[], spillDir }`，删除路由是 `POST /plugins/@boois/dsh-delete-sessions/delete`。确认框据此显示影响面（会话是否活动、有多少定时任务指向它、有多少子代理子会话）。
   → 你能看到的效果：点「确认」之前就知道这一刀会带走多少东西。
3. **会话状态闸门。** 活动会话一律先 `archiveSession`（落下唤醒闸门）→ `workspace/session-stop` → `sessions.flush` → 有界重试等待实例退出；实例仍在就返回 **409**，**不删文件、不广播**。
   → 你能看到的效果：再也不会出现「行没了、文件还在」；活动会话会提示你「宿主释放后重试」，而不是假装删掉了。
4. **定时任务闸门。** 删除前扫描 `schedule` 域的 `tasks` 表：`target.sessionId` / `involvedSessionIds` / `lastDelivery.targetSessionId` / `pendingDelivery.targetSessionId` / `deliveryHistory.records[].targetSessionId`，外加 `new_once` 任务由任务 id 派生的保留会话 id `session-schedule-<sha256(taskId)>`。有 `status === 'active'` 的命中且未显式确认时返回 **409** 并列出这些任务；勾选确认后按运行时自己在用的同一条写回路径（`tasks.put(id, …)`）把它们置为 `paused` 并发出 `schedule/changed`，再执行删除。
   → 你能看到的效果：删完不会在某次投递之后「诈尸」。
5. **不再 `unarchiveSession`。** 保持归档状态就是让唤醒门保持关闭；`unpinSession` 保留为幂等清理。
   → 你能看到的效果：被删会话不会被任何 wake 路径重新拉起来。
6. **失败不再被吞。** 所有步骤的结果收集进 `failures[]`；只有日志文件**确认消失**（删后用 `stat()` 复核）才广播 `api-session/removed`；部分失败返回 **500** 并附上明细。
   → 你能看到的效果：报错就是真没删干净，而且告诉你哪一步没成；界面不会先替你「演」一遍删除成功。
7. **删除目标改用稳定字段 `stat().location.path`。** 只删该文件本身，目录空了再 `rmdir`（核心布局演进时不会连删兄弟会话）；`locate()` 降级为可选加速，它的失败与 `@deepseek-ai/dsh-home-paths` 动态 import 失败都记入日志，不再静默 `return`。
   → 你能看到的效果：定位不到时日志里有线索，而不是安静地什么都没删。
8. **递归删除子代理子会话。** 同一 `projectKey` 下的 child 会话（日志文件 + 投影缓存行）一并删除，并在结果里报告 `children`。
   → 你能看到的效果：删父会话时，子代理那些看不见的对话一起走。
9. **投影缓存更结实。** `storageDomain` 进入 `inject` 声明（保证激活顺序与 HMR 重连后仍可用），删除动作移到文件删除**之后**，并带退避重试；失败进 `warnings[]`。
   → 你能看到的效果：热重载之后依然清得掉缓存行，不会被静默跳过。
10. **spill 明文临时文件尽力清理。** 按 `session-<sha256(sessionId)[0:12]>` 规则（`dsh-spill-local/lib/index.js:69-71`），在 `%TEMP%` 的 `dsh-spill-*` 根内**先探测存在再删**（`rm(force: true)` 对不存在的路径不报错，不能拿它当「删到了」）；真正删掉的路径进 `deleted[]`，探测/删除异常进 `warnings[]`。
    → 你能看到的效果：那些躺在临时目录里的明文工具输出跟着一起消失，而且返回的清单不掺水。
11. **客户端体验。** 注入 `<style>` 移到模块工厂期（交给装载器认领/回收，修掉卸载残留与升级后陈旧样式）；确认框明确写「**不可撤销**」并显示 `plan` 的影响面；权限不足时由服务端 403/409 给出可读原因。
    → 你能看到的效果：升级后样式不再陈旧；点确认前躲不开「不可撤销」这行字。
12. **发布护栏。** 加上 `engines.dsh` 版本护栏；`files` 纳入 `docs/`；市场截图 `assets/` 已存在于仓库（0.2.2 发版时尚未提交，所以 tarball 缺图、市场页图裂）。
    → 你能看到的效果：宿主版本不匹配时在安装期就被拦住，而不是运行时静默降级；市场页截图正常显示。

## 明确不覆盖的残留（隐私边界）

「删除会话」删的是会话日志与投影缓存这一条链，**下面这些它删不掉**，请自行处理，也别把插件文案理解成覆盖它们：

- **附件内容寻址对象**：`~/.dsh/attachments/v1`，宿主侧没有 GC，会话删掉后成为孤儿对象。
- **导出到磁盘的会话 HTML 副本**：你手动导出过的文件在插件管辖范围之外。
- **客户端 leveldb 痕迹**：桌面端 Local Storage 里残留的 session id 等痕迹。
- **OTel 已外发日志**：经遥测链路发出去的日志**不可撤回**。
- **扇区级可恢复**：删除用 `rm`，**不是安全擦除**；数据在磁盘上仍可能被恢复。

## 安装

### 方式一：git 依赖（推荐）

在 DSH 插件安装里把 spec 填成：

```
git+ssh://git@github.com/boois/dsh-session-delete.git#hardened
```

DSH 的安装链本身支持 git spec（连接探测与 SSH 回退，`dsh-plugin-manager/lib/index.js:144-205`、`:2698-2711`），scoped 包名在客户端装载链上也是被支持的（`dsh-client-modules/lib/index.js:232-234`）。安装为 bundle 时仓库自带的 `cordis.patch.yml` 会自动插入加载行。

> ⚠️ 同一个 profile 里**不要同时启用上游包** `dsh-delete-sessions`：那会摆出两套删除入口，一个有鉴权一个没有，出事的时候很难看。装 fork 之前先把上游包停用。

### 方式二：手动安装

1. 把本仓库内容放到 profile 的 `node_modules/@boois/dsh-delete-sessions`（或用 `link:` 依赖）。
2. 在该 profile 自己的 `cordis.patch.yml` 里加一行，`id` 与 `name` 都必须等于包名：

```yaml
- insert:
    - id: @boois/dsh-delete-sessions
      name: '@boois/dsh-delete-sessions'
```

> 注意：手动加行后**不要再**让仓库里那份 `cordis.patch.yml` 也被应用，否则同一插件会因 id 冲突重复加载。

3. 重启 DeepSeek Harness。

## 使用

1. 在侧栏任意会话上点「…」。
2. 菜单里会多出「删除会话」（红色危险项，与「删除工作区」同一条着色路径）。
3. 点击后弹出确认框：先只读预检，列出影响面——会话是否正在活动、指向它的定时任务、会被连带删除的子代理子会话；按钮写的是「**永久删除（不可撤销）**」，预检期间和预检失败时按钮禁用。
4. 若预检发现有 `active` 的定时任务指向它，必须勾上「同时暂停这些任务」才放开按钮。
5. 确认后才真正删除；成功后宿主广播移除事件，行随即从列表消失。403 / 409 / 500 的机器可读原因直接显示在对话框里。

![侧栏菜单里的「删除会话」](assets/01-session-menu.png)
![带影响面提示的确认框](assets/02-confirm-dialog.png)

## 行为细节

删除按固定顺序执行，任何一步失败都会如实返回并给出明细：

1. **枚举子会话（只读）** —— 抢在任何删除动作之前读 `subagent.listChildren` 与投影缓存的 `parentSession` 行：父会话日志一删，子会话目录就读不到了，所以必须最先拿到清单。
2. **落闸门** —— `archiveSession` 让唤醒门关着；`schedule` 里命中该会话的 `active` 任务先要求确认并暂停，暂停失败就不删。
3. **停活动并等收敛** —— `workspace/session-stop` → `sessions.flush` → 有界重试（5s / 250ms 步长）等实例退出；实例还在就 409 收工，**不碰文件、不广播**。
4. **摘除记账** —— `unpinSession`（幂等）与各工作区 `detachSession`；**归档状态保持不动**，让唤醒闸门继续关闭。
5. **删日志文件** —— 用 `stat().location.path` 拿到稳定路径，只删这个文件，目录空了再 `rmdir`（绝不递归删兄弟会话）。
6. **删投影缓存** —— 走 storage-domain 的 `session_projcache` 域，带退避重试，失败进 `warnings[]`（派生数据，下次冷读会重建）。
7. **清理 spill 明文临时文件** —— 见上文第 10 条。
8. **递归删子会话** —— 对第 1 步的清单跑同一套流程（深度上限 8 防环），结果进 `children[]`。
9. **复核后广播** —— `stat()` 复核日志文件确实消失，才发出 `api-session/removed` 让浏览器移除该行；没通过复核就不广播并返回 500。

## 测试

```
npm test
```

= `node --check lib/index.js` + `node --check lib/client.js` + `node tests/selfcheck.mjs`。
`tests/selfcheck.mjs` 用一个**假 ctx** 跑纯逻辑断言：鉴权门槛（无 `connection` 服务 / 非 owner peer / `admit` 拒绝 / 三种跨源 Origin / 同源放行）、任务扫描的五种命中字段与 `new_once` 保留 id、子会话并集、spill 精确名匹配、`plan` 的 not-found 与路由方法约束。它**只使用不存在的 session id**，不读写 `~/.dsh` 下任何真实数据，因此可以随时跑。

## 安全

- 删除端点走宿主 `connection` 服务的 `admit()`，且要求 `peer.principal.kind === 'owner'`（宿主保护自己破坏性路由的同一条判据）；`GET` 与跨源请求一律拒绝。
- `origin` 存在时必须与请求 `Host` **精确同源**（含端口）；缺失时不再自动放行。
- session id 先经 `sessionPersistence.stat()` 校验真实存在，才继续删除；`plan` 是只读端点。
- 删除路径来自 `stat().location.path`，由 DSH 自身的 `encodeSegment` 编码，无路径穿越；请求体只承载一个 `sessionId`（上限 16 KiB）。
- 无遥测、无外联、无 `eval`、无子进程、不读凭据。

## 局限

- **活动会话要等宿主释放才能删**：实例仍在进程里时返回 409，请在会话空闲后重试（核心目前没有公开的会话销毁接口）。
- **定时任务只暂停、不删除**：插件不会替你销毁任务；要彻底清掉请到定时任务里自己删。
- **残留面见上文「明确不覆盖的残留」**：附件对象、导出副本、leveldb 痕迹、OTel 外发日志、扇区级恢复都不在覆盖范围内。
- 投影缓存是派生数据：删除失败只进 `warnings[]`，下次冷读会重建。
- 子会话递归依赖同一 `projectKey` 下的记账；跨 projectKey 的子会话不在射程内。
- 删除**不可撤销**：没有回收站、没有 undo，确认前请先看确认框里的影响面。

## License

MIT（沿用上游作者 linusteller 的授权；fork 由 @boois 维护）
