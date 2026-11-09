/**
 * @boois/dsh-delete-sessions — 给 DeepSeek Harness 增加真正的「删除会话」。
 *
 * DSH 内建只有「归档」（archive）：它只把会话 id 加进 `archivedSessionIds`
 * 集合，磁盘上的会话日志（`~/.dsh/sessions/<project>/<id>/session.v4.jsonl.zstd`）
 * 与投影缓存（`~/.dsh/storages/session_projcache/sessions/<id>.json`）永远不删。
 *
 * 本插件在侧栏每个会话的「…」菜单里加一个「删除会话」项：浏览器先 `GET plan`
 * 读取影响面（是否活动、指向它的定时任务、子代理子会话），确认后 `POST delete`
 * 由宿主执行删除。相对上游 0.2.2 的关键差异见 `docs/AUDIT-0.2.2.md` 与 README：
 *
 *   1. 鉴权走宿主 `connection` 服务的 `admit()`，并要求 owner principal，与宿主
 *      保护自身破坏性路由的判据一致（`dsh-client-connection/lib/index.js:742-750`、
 *      `:830`）；上游自建的「回环 Origin 白名单 + 缺 Origin 放行」已删除。
 *   2. 活动会话先 `archiveSession` 落下唤醒闸门，再 `workspace/session-stop` →
 *      `sessions.flush` → 有界等待实例退出；仍在则 409，不删文件、不广播。
 *   3. 删除前扫描 schedule 任务（`target` / `involvedSessionIds` / `lastDelivery` /
 *      `pendingDelivery` / `deliveryHistory` / `session-schedule-<sha256(taskId)>`），
 *      有命中需显式确认，确认后暂停任务再删（修掉「定时任务把已删会话重建」）。
 *   4. 不再 `unarchiveSession`：文件将不存在，保持归档态让唤醒闸门继续关闭。
 *   5. 每一步的失败收集进 `failures[]`；只有删后 `stat()` 复核确认日志消失才广播
 *      `api-session/removed`，部分失败返回 500 并带明细。
 *   6. 删除目标优先 `stat().location.path`，只删该文件本身，目录空了再 `rmdir`；
 *      `locate()` 降级为可选加速，扫描回退失败不再静默 return。
 *   7. 递归删除子代理子会话（`subagent.listChildren` + 投影缓存里的 `parentSession`
 *      行并集）。
 *   8. spill 明文临时文件按 `session-<sha256(sessionId)[0:12]>` 规则在 `%TEMP%`
 *      的 `dsh-spill-*` 根内尽力清理（`dsh-spill-local/lib/index.js:69-71`）。
 *
 * 明确不覆盖的残留（隐私边界，README 有专节）：附件内容寻址对象
 * （`~/.dsh/attachments/v1`，宿主侧无 GC）、导出到磁盘的会话 HTML 副本、客户端
 * leveldb 痕迹、OTel 已外发日志、扇区级可恢复（`rm` 不是安全擦除）。
 *
 * @module @boois/dsh-delete-sessions
 */
import { createHash } from 'node:crypto';
import { rm, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Cordis 插件名（须与包名一致，装载器按此认领模块）。 */
export const name = '@boois/dsh-delete-sessions';

/**
 * 本插件需要的宿主服务。`storageDomain` 进声明是为了保证激活顺序：投影缓存与
 * schedule 域必须在删除流程可读写时已挂载，HMR 重载后也会自动重连。
 * webServer / connection / subagent 走可选注入，headless profile 仍可加载。
 */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'sessions', 'storageDomain'];

/** 同源只读预检路由（scoped 包名跨两段路径，宿主装载链已支持）。 */
export const PLAN_PATH = '/plugins/@boois/dsh-delete-sessions/plan';

/** 同源删除路由。 */
export const DELETE_PATH = '/plugins/@boois/dsh-delete-sessions/delete';

/** 停止活动后等待实例退出的上限与步长（取代上游固定 500ms 睡眠）。 */
const SETTLE_DEADLINE_MS = 5000;
const SETTLE_STEP_MS = 250;

/** 删除文件时，遇到 Windows EBUSY/EPERM/EACCES 的重试次数与间隔。 */
const RM_RETRY = 6;
const RM_RETRY_GAP_MS = 150;

/** 投影缓存删除的重试次数与间隔（派生数据，失败只记 warnings）。 */
const CACHE_RETRY = 3;
const CACHE_RETRY_GAP_MS = 100;

/** 最大请求体（只承载 sessionId 与两个确认标志）。 */
const MAX_BODY_BYTES = 16 * 1024;

/** 递归删除子会话的深度上限（防自引用环）。 */
const MAX_CHILD_DEPTH = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 权威鉴权：交给宿主 `connection` 服务。`admit()` 已包含 Host/Origin 围栏
 * （`isTrusted`）与浏览器 cookie / API token 校验，返回 `{ peer }` 或
 * `{ rejection: 403 | 401 }`。破坏性操作额外要求 owner principal，与宿主
 * 自己保护 fetch 路由的判据一致（`dsh-client-connection/lib/index.js:830`）。
 *
 * 追加一道同源自检：`origin` 存在时必须与请求 `host` 精确同源（端口参与比较），
 * 这样即使宿主 `trustedHosts` 配置放宽，删除也只接受本站页面发起的请求。
 * 同一页面的 GET 不带 `origin`，此时以 `admit()` 的结论为准。
 *
 * @param ctx - 插件上下文。
 * @param req - 请求。
 * @returns `{ ok: true }` 或 `{ ok: false, status, error }`。
 */
function authorize(ctx, req) {
  const connection = ctx.get('connection');
  if (typeof connection?.admit !== 'function') {
    return { ok: false, status: 503, error: 'connection service unavailable; refusing destructive delete' };
  }
  const admission = connection.admit(req);
  if (admission === undefined || typeof admission !== 'object') {
    return { ok: false, status: 401, error: 'unauthenticated' };
  }
  if ('rejection' in admission) {
    const status = Number(admission.rejection) || 401;
    return { ok: false, status, error: status === 403 ? 'origin not trusted' : 'unauthenticated' };
  }
  if (admission.peer?.principal?.kind !== 'owner') {
    return { ok: false, status: 403, error: 'only the owner peer may delete a session' };
  }
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, error: 'origin not trusted' };
    }
    const requestHost = String(req.headers?.host ?? '').toLowerCase();
    if (originHost.toLowerCase() !== requestHost) {
      return { ok: false, status: 403, error: 'origin is not the same authority as the request host' };
    }
  }
  return { ok: true };
}

/** 读取一个小 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 应答 JSON。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 是否有文件系统占用类错误（Windows 删除被占用的文件时会报告）。 */
function isBusyError(error) {
  const code = error && error.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/** 带重试删除单个目标；`recursive` 关闭，只删明确指向的那一个。 */
async function rmWithRetry(target, attempts = RM_RETRY) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(target, { force: false });
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (!isBusyError(error)) throw error;
      lastError = error;
      await sleep(RM_RETRY_GAP_MS);
    }
  }
  throw lastError;
}

/** 带退避执行一个异步操作（用于投影缓存删除）。 */
async function retry(fn, attempts, gapMs) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(gapMs);
    }
  }
  throw lastError;
}

/** 打开一个已挂载的存储域（不 open，避免与属主插件争抢生命周期）。 */
function openedDomain(ctx, name) {
  const domain = ctx.get('storageDomain');
  if (typeof domain?.get !== 'function') return undefined;
  try {
    return domain.get(name);
  } catch {
    return undefined;
  }
}

/** 安全读取一个域的表句柄。 */
function openedTable(ctx, domainName, tableName) {
  const domain = openedDomain(ctx, domainName);
  if (typeof domain?.table !== 'function') return undefined;
  try {
    const table = domain.table(tableName);
    return typeof table?.entries === 'function' ? table : undefined;
  } catch {
    return undefined;
  }
}

/** schedule 任务没有落盘目标时的稳定会话 id（`dsh-schedule/lib/types/storage.js:49-51`）。 */
function defaultScheduleSessionId(taskId) {
  return `session-schedule-${createHash('sha256').update(String(taskId)).digest('hex')}`;
}

/**
 * 找出所有指向该会话的定时任务。命中任一即视为「删了也会被重建 / 记录会指向
 * 不存在的会话」：`target.sessionId`、`involvedSessionIds`、`lastDelivery`、
 * `pendingDelivery`、投递历史，以及 new_once 任务由任务 id 派生的稳定会话 id。
 *
 * @returns `[{ id, title, status, reason }]`；profile 未启用 schedule 时为空。
 */
export function tasksReferencing(ctx, sessionId) {
  const table = openedTable(ctx, 'schedule', 'tasks');
  if (table === undefined) return [];
  const found = [];
  try {
    for (const [key, task] of table.entries()) {
      if (task === undefined || task === null) continue;
      const taskId = task?.record?.id ?? key;
      const title = typeof task?.record?.title === 'string' ? task.record.title : String(taskId);
      const reasons = [];
      if (task?.target?.sessionId === sessionId) reasons.push('target');
      if (Array.isArray(task?.involvedSessionIds) && task.involvedSessionIds.includes(sessionId)) reasons.push('involved');
      if (task?.lastDelivery?.targetSessionId === sessionId) reasons.push('lastDelivery');
      if (task?.pendingDelivery?.targetSessionId === sessionId) reasons.push('pendingDelivery');
      if (Array.isArray(task?.deliveryHistory?.records) && task.deliveryHistory.records.some((r) => r?.targetSessionId === sessionId)) reasons.push('history');
      if (defaultScheduleSessionId(taskId) === sessionId) reasons.push('reserved');
      if (reasons.length === 0) continue;
      found.push({ id: String(taskId), title, status: task?.status ?? 'active', reasons });
    }
  } catch (error) {
    ctx.logger?.warn?.(`delete-sessions: 扫描定时任务失败：${String(error)}`);
  }
  return found;
}

/**
 * 暂停给定任务后再删会话。写回走运行时自己在用的同一条路径
 * （`tasks.put(id, scheduleTaskSchema.parse(task))`，`dsh-schedule/lib/index.js:2168`），
 * 运行时每轮 drive 从表里现读任务，因此暂停会生效。
 *
 * @returns `{ paused: string[], failures: string[] }`。
 */
export async function pauseTasks(ctx, tasks) {
  const table = openedTable(ctx, 'schedule', 'tasks');
  const paused = [];
  const failures = [];
  if (table === undefined) {
    return { paused, failures: tasks.map((task) => `${task.id}: schedule 域不可写`) };
  }
  for (const task of tasks) {
    if (task.status !== 'active') {
      paused.push(task.id);
      continue;
    }
    try {
      const current = typeof table.get === 'function' ? await table.get(task.id) : undefined;
      if (current === undefined) {
        failures.push(`${task.id}: 任务记录不可读`);
        continue;
      }
      await table.put(task.id, { ...current, status: 'paused' });
      paused.push(task.id);
    } catch (error) {
      failures.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (paused.length > 0) {
    try {
      ctx.emit('schedule/changed');
    } catch {
      /* 通知失败不影响暂停结果 */
    }
  }
  return { paused, failures };
}

/**
 * 枚举子代理子会话：官方 `subagent.listChildren` 给出目录里的直接子会话，
 * 投影缓存行里的 `header.parentSession` 补上目录已裁剪的历史子会话。
 *
 * @returns 去重后的子会话 id 列表。
 */
export async function childrenOf(ctx, sessionId) {
  const ids = new Set();
  const subagent = ctx.get('subagent');
  if (typeof subagent?.listChildren === 'function') {
    try {
      const listed = await subagent.listChildren(sessionId);
      const entries = Array.isArray(listed) ? listed : listed?.entries ?? [];
      for (const entry of entries) {
        const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.childId;
        if (typeof id === 'string' && id !== '' && id !== sessionId) ids.add(id);
      }
    } catch (error) {
      ctx.logger?.debug?.(`delete-sessions: listChildren(${sessionId}) 不可用：${String(error)}`);
    }
  }
  const cache = openedTable(ctx, 'session_projcache', 'sessions');
  if (cache !== undefined) {
    try {
      for (const [key, record] of cache.entries()) {
        const parent = record?.header?.parentSession ?? record?.parentSession;
        if (parent === sessionId && key !== sessionId) ids.add(key);
      }
    } catch (error) {
      ctx.logger?.debug?.(`delete-sessions: 投影缓存父链扫描失败：${String(error)}`);
    }
  }
  return [...ids];
}

/** spill 会话目录名（`session-<sha256(sessionId)[0:12]>`）。 */
function spillSessionDirName(sessionId) {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
}

/**
 * 尽力清理 spill 明文临时文件：spill 根是每进程随机的 `%TEMP%\dsh-spill-*`，
 * 因此扫描所有 `dsh-spill-*` 根，命中同名会话目录才删（不递归进无关目录）。
 *
 * @returns `{ removed: string[], note?: string }`。
 */
export async function cleanSpill(sessionId) {
  const targetName = spillSessionDirName(sessionId);
  const removed = [];
  let roots;
  try {
    roots = await readdir(tmpdir(), { withFileTypes: true });
  } catch (error) {
    return { removed, note: `无法枚举临时目录：${String(error)}` };
  }
  let note;
  for (const entry of roots) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-spill-')) continue;
    const candidate = join(tmpdir(), entry.name, targetName);
    // 先探测存在性：`rm(force: true)` 对不存在的路径不报错，不能拿它当「删到了」。
    let exists = false;
    try {
      await readdir(candidate);
      exists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') note = `spill 根 ${entry.name} 探测失败：${String(error)}`;
    }
    if (!exists) continue;
    try {
      await rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch (error) {
      note = `spill 目录 ${join(entry.name, targetName)} 清理失败：${String(error)}`;
    }
  }
  return note === undefined ? { removed } : { removed, note };
}

/** 会话是否真实存在（live 或持久化均可）。 */
async function sessionExists(ctx, sessionId) {
  if (ctx.sessions.get(sessionId) !== undefined) return true;
  try {
    return (await ctx.sessionPersistence.stat(sessionId)) !== undefined;
  } catch {
    return false;
  }
}

/** 读取会话元数据：live header 优先，其次持久化 stat（含 `location`）。 */
async function readMeta(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live !== undefined) return { meta: live.header, stat: undefined, live };
  let stat;
  try {
    stat = await ctx.sessionPersistence.stat(sessionId);
  } catch {
    stat = undefined;
  }
  return { meta: stat?.header, stat, live: undefined };
}

/**
 * 解析日志文件路径：优先持久化 `location.path`（稳定字段，核心布局演进时最可靠），
 * 其次 `locate(meta)`（可选加速），最后扫描 `~/.dsh/sessions` 找同名目录。
 *
 * @returns `{ file, dir, note }`；无法定位时 `file` 为 undefined 且 `note` 说明原因。
 */
async function resolveLogPath(ctx, sessionId, meta, stat) {
  const locatedField = stat?.location?.path;
  if (typeof locatedField === 'string' && locatedField !== '') {
    return { file: locatedField, dir: dirname(locatedField) };
  }
  if (typeof ctx.sessionPersistence.locate === 'function') {
    try {
      const located = ctx.sessionPersistence.locate(meta);
      if (typeof located?.path === 'string' && located.path !== '') {
        return { file: located.path, dir: dirname(located.path) };
      }
    } catch (error) {
      ctx.logger?.debug?.(`delete-sessions: locate(${sessionId}) 失败，转扫描回退：${String(error)}`);
    }
  }
  let home;
  try {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths');
    home = resolveDshHome();
  } catch (error) {
    return { note: `无法定位 DSH home（缺 @deepseek-ai/dsh-home-paths 解析）：${String(error)}` };
  }
  const sessionsRoot = join(home, 'sessions');
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    return { note: `无法枚举 ${sessionsRoot}：${String(error)}` };
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(sessionsRoot, project.name);
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name !== sessionId) continue;
      const sessionDir = join(dir, child.name);
      let names;
      try {
        names = await readdir(sessionDir);
      } catch {
        names = [];
      }
      const file = names.includes('session.v4.jsonl.zstd') ? join(sessionDir, 'session.v4.jsonl.zstd') : undefined;
      return { file, dir: sessionDir };
    }
  }
  return { note: `在 ${sessionsRoot} 下未找到会话目录` };
}

/**
 * 删除一个会话的日志文件与（变空后的）目录，并复核日志确实消失。
 *
 * 只删解析出来的那一个文件；随后 `rmdir` 只在目录已空时成功，绝不递归删兄弟会话。
 *
 * @returns `{ ok, removed[], failures[] }`。
 */
async function removeSessionLog(ctx, sessionId, meta, stat) {
  const failures = [];
  const removed = [];
  const resolved = await resolveLogPath(ctx, sessionId, meta, stat);
  if (resolved.note !== undefined) failures.push(resolved.note);
  if (resolved.file !== undefined) {
    try {
      await rmWithRetry(resolved.file);
      removed.push(resolved.file);
    } catch (error) {
      failures.push(`日志文件删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolved.dir !== undefined) {
      try {
        await rmdir(resolved.dir);
        removed.push(resolved.dir);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
          failures.push(`会话目录清理失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  let after;
  try {
    after = await ctx.sessionPersistence.stat(sessionId);
  } catch {
    after = undefined;
  }
  if (after !== undefined) failures.push('删后复核：会话日志仍存在');
  return { ok: after === undefined && failures.length === 0, removed, failures };
}

/** 删除投影缓存行（派生数据；失败只记 warnings，不阻断）。 */
async function removeProjectionCache(ctx, sessionId) {
  const table = openedTable(ctx, 'session_projcache', 'sessions');
  if (table === undefined) return { skipped: true };
  if (typeof table.delete !== 'function') return { skipped: true };
  try {
    await retry(() => table.delete(sessionId), CACHE_RETRY, CACHE_RETRY_GAP_MS);
    return { ok: true };
  } catch (error) {
    return { failure: `投影缓存删除失败（下次冷读会重建）：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 让会话进入可删状态：归档（落下唤醒闸门，阻止 create-on-demand 重建）→
 * `workspace/session-stop`（与归档「停止并归档」同一条路径）→ flush →
 * 有界等待实例退出。
 *
 * @returns `{ settled: boolean, archived: boolean }`。
 */
async function quiesce(ctx, sessionId) {
  let archived = false;
  if (typeof ctx.workspaceRegistry.archiveSession === 'function') {
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId);
      archived = true;
    } catch (error) {
      ctx.logger?.warn?.(`delete-sessions: archiveSession(${sessionId}) 失败（唤醒闸门未落下）：${String(error)}`);
    }
  }
  try {
    await ctx.parallel('workspace/session-stop', { sessionId });
  } catch (error) {
    ctx.logger?.warn?.(`delete-sessions: session-stop(${sessionId}) 失败：${String(error)}`);
  }
  const live = ctx.sessions.get(sessionId);
  if (live !== undefined && typeof ctx.sessions.flush === 'function') {
    try {
      await ctx.sessions.flush(live);
    } catch (error) {
      ctx.logger?.warn?.(`delete-sessions: flush(${sessionId}) 失败：${String(error)}`);
    }
  }
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  for (;;) {
    if (ctx.sessions.get(sessionId) === undefined) return { settled: true, archived };
    if (Date.now() >= deadline) return { settled: false, archived };
    await sleep(SETTLE_STEP_MS);
  }
}

/**
 * 会话的完整删除清理。返回 `{ ok, deleted, children, tasksPaused, failures, warnings }`。
 *
 * 顺序经过刻意设计：先让会话进入可删状态（归档闸门 → 停止 → flush → 等退出），
 * 再关闭会把它重建的入口（定时任务），再摘除记账（置顶/工作区），最后才删数据
 * （日志文件 → 目录 → 投影缓存 → spill），删后 `stat()` 复核通过才广播移除。
 * 任何一步失败都进入 `failures`，绝不静默成功。
 *
 * @param ctx - 插件上下文。
 * @param sessionId - 目标会话 id。
 * @param options - `{ confirmTasks }`：显式确认可暂停指向该会话的定时任务。
 */
export async function deleteSession(ctx, sessionId, options = {}) {
  const failures = [];
  const warnings = [];
  const deleted = [];
  const childrenDeleted = [];

  // 0. 校验：id 必须真实存在（live 或持久化）。
  const { meta, stat, live } = await readMeta(ctx, sessionId);
  if (meta === undefined) return { ok: false, code: 'not-found', failures: ['session not found'] };

  // 1. 先枚举子代理子会话：`subagent.listChildren` 走 `sessionQuery.observeSession`
  //    读父会话的 subagentCatalog 投影，父会话日志一删就读不到了，因此必须抢在
  //    任何删除动作之前拿到清单。
  const children = await childrenOf(ctx, sessionId);

  // 2. 让会话进入可删状态。实例仍在则拒绝删除：写路径会 mkdir 重建目录，
  //    删了只会得到「界面里没了、磁盘还在」。
  const needsQuiesce = live !== undefined || ctx.sessions.get(sessionId) !== undefined;
  if (needsQuiesce) {
    const { settled } = await quiesce(ctx, sessionId);
    if (!settled) {
      return {
        ok: false,
        code: 'session-active',
        failures: ['会话实例仍在运行，宿主未释放它；稍后重试（本次未删除任何文件）'],
      };
    }
  }

  // 3. 关闭重建入口：指向该会话的定时任务。未确认时拒绝，确认后暂停。
  const tasks = tasksReferencing(ctx, sessionId).filter((task) => task.status === 'active');
  if (tasks.length > 0 && options.confirmTasks !== true) {
    return { ok: false, code: 'tasks-reference', tasks, failures: ['有定时任务指向该会话，需先确认暂停'] };
  }
  const tasksPaused = [];
  if (tasks.length > 0) {
    const pause = await pauseTasks(ctx, tasks);
    tasksPaused.push(...pause.paused);
    failures.push(...pause.failures);
    if (pause.failures.length > 0) {
      return { ok: false, code: 'tasks-reference', tasks, tasksPaused, failures: [...failures, '定时任务未能全部暂停（本次未删除任何文件）'] };
    }
  }

  // 4. 摘除记账：置顶（幂等；归档保持不动，让唤醒闸门继续关闭）。
  try {
    await ctx.workspaceRegistry.unpinSession(sessionId);
  } catch (error) {
    warnings.push(`unpinSession 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue;
    try {
      await workspace.detachSession(sessionId);
    } catch (error) {
      failures.push(`工作区 ${workspace.id ?? '?'} detach 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5. 删数据：日志文件 → 空目录 → 复核。
  const log = await removeSessionLog(ctx, sessionId, meta, stat);
  deleted.push(...log.removed);
  failures.push(...log.failures);

  // 6. 投影缓存（派生数据，失败只告警：下次冷读会重建）。
  const cache = await removeProjectionCache(ctx, sessionId);
  if (cache.failure !== undefined) warnings.push(cache.failure);

  // 7. spill 明文临时文件。
  const spill = await cleanSpill(sessionId);
  deleted.push(...spill.removed);
  if (spill.note !== undefined) warnings.push(spill.note);

  // 8. 子代理子会话：同一删除流程；深度上限防自引用环（子会话默认连带暂停其任务）。
  const depth = (options.depth ?? 1) + 1;
  if (children.length > 0 && depth > MAX_CHILD_DEPTH) {
    warnings.push(`子会话递归已达深度上限 ${MAX_CHILD_DEPTH}，剩余 ${children.length} 个需手动处理`);
  } else {
    for (const childId of children) {
      const child = await deleteSession(ctx, childId, { confirmTasks: true, depth });
      if (child.ok) {
        childrenDeleted.push(childId);
        deleted.push(...child.deleted);
        warnings.push(...child.warnings);
      } else {
        failures.push(`子会话 ${childId} 未删除（${child.code ?? 'unknown'}）：${(child.failures ?? []).join('; ')}`);
      }
    }
  }

  // 9. 只有日志确认消失才广播移除；否则宁可让 UI 保留该行。
  if (log.ok) ctx.emit('api-session/removed', sessionId);
  for (const childId of childrenDeleted) ctx.emit('api-session/removed', childId);

  const ok = log.ok && failures.length === 0;
  return { ok, code: ok ? undefined : 'partial', deleted, children: childrenDeleted, tasksPaused, failures, warnings };
}

/** 只读预检：确认框据此显示影响面，不做任何修改。 */
export async function planDelete(ctx, sessionId) {
  const { meta, live } = await readMeta(ctx, sessionId);
  if (meta === undefined) return { ok: false, code: 'not-found', exists: false };
  const tasks = tasksReferencing(ctx, sessionId);
  const children = await childrenOf(ctx, sessionId);
  return {
    ok: true,
    exists: true,
    live: live !== undefined,
    archived: (() => {
      try {
        return Array.isArray(ctx.workspaceRegistry.archivedSessionIds)
          && ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
      } catch {
        return undefined;
      }
    })(),
    tasks,
    children,
    spillDir: spillSessionDirName(sessionId),
  };
}

/** 从请求中取出 sessionId（POST body 或 GET query）。 */
function sessionIdFromRequest(req, body) {
  if (typeof body?.sessionId === 'string') return body.sessionId.trim();
  const url = new URL(req.url ?? '', 'http://localhost');
  return (url.searchParams.get('sessionId') ?? '').trim();
}

/** 预检路由：GET + owner。 */
export async function handlePlanRequest(ctx, req, res) {
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const auth = authorize(ctx, req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }
    const body = method === 'POST' ? await readJsonBody(req) : {};
    const sessionId = sessionIdFromRequest(req, body);
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'sessionId required' });
      return;
    }
    const plan = await planDelete(ctx, sessionId);
    sendJson(res, plan.ok ? 200 : 404, plan);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 删除路由处理器：owner 鉴权 + 同源自检，body 为 `{ sessionId, confirmTasks }`。
 */
export async function handleDeleteRequest(ctx, req, res) {
  try {
    if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const auth = authorize(ctx, req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }
    const body = await readJsonBody(req);
    const sessionId = sessionIdFromRequest(req, body);
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'sessionId required' });
      return;
    }
    if (!(await sessionExists(ctx, sessionId))) {
      sendJson(res, 404, { ok: false, error: 'session not found' });
      return;
    }
    const result = await deleteSession(ctx, sessionId, { confirmTasks: body?.confirmTasks === true });
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        deleted: result.deleted,
        children: result.children,
        tasksPaused: result.tasksPaused,
        warnings: result.warnings,
      });
      return;
    }
    const status = result.code === 'not-found' ? 404 : result.code === 'session-active' || result.code === 'tasks-reference' ? 409 : 500;
    sendJson(res, status, {
      ok: false,
      code: result.code,
      error: result.failures.join('; '),
      failures: result.failures,
      warnings: result.warnings,
      tasks: result.tasks,
      tasksPaused: result.tasksPaused,
      deleted: result.deleted,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Cordis 插件入口。 */
export function apply(ctx) {
  // webServer 为可选服务：headless profile 无路由，但插件本体仍加载。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => {
          const server = webCtx.webServer;
          if (typeof server?.register !== 'function') return;
          server.register({
            kind: 'exact',
            path: DELETE_PATH,
            handler: (req, res) => handleDeleteRequest(ctx, req, res),
          });
          server.register({
            kind: 'exact',
            path: PLAN_PATH,
            handler: (req, res) => handlePlanRequest(ctx, req, res),
          });
        }, '@boois/dsh-delete-sessions: routes');
      });
    }
  } catch (error) {
    ctx.logger?.warn?.(`delete-sessions: 无 webServer，删除路由未注册：${String(error)}`);
  }
}
