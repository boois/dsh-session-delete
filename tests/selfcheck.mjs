/**
 * 非破坏性自检：用假 ctx 验证 0.3.2 的鉴权门槛、任务扫描、spill 命名、
 * 「不存在会话」路径、路由生命周期、以及删除中止时必须回滚归档。
 * 只用不存在的 id 与 `%TEMP%` 下自建的临时目录，绝不触碰真实数据。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tasksReferencing,
  childrenOf,
  childrenOfDetailed,
  leftoverChildren,
  cleanSpill,
  planDelete,
  deleteSession,
  handleDeleteRequest,
  handlePlanRequest,
  apply,
  DELETE_PATH,
  PLAN_PATH,
} from '../lib/index.js';

const BOGUS = 'session-audit-nonexistent-0000';
const RESERVED = `session-schedule-${createHash('sha256').update('task-reserved-1').digest('hex')}`;

const tasks = [
  { record: { id: 'task-target', title: '每日日报' }, target: { kind: 'session', sessionId: BOGUS }, status: 'active' },
  { record: { id: 'task-involved', title: '历史涉及' }, target: { kind: 'new' }, involvedSessionIds: [BOGUS], status: 'paused' },
  { record: { id: 'task-history', title: '投递历史' }, target: { kind: 'new' }, status: 'ended', deliveryHistory: { records: [{ targetSessionId: BOGUS }], earlierRecordsUnavailable: false, earlierRecordsPruned: false } },
  { record: { id: 'task-reserved-1', title: '一次性新建' }, target: { kind: 'new_once', create: {} }, status: 'active' },
  { record: { id: 'task-unrelated', title: '无关' }, target: { kind: 'session', sessionId: 'session-other' }, status: 'active' },
];

const children = [
  { record: { id: 'child-a' }, header: { id: 'child-a', parentSession: BOGUS } },
  { record: { id: 'child-b' }, header: { id: 'child-b' } },
];

const ctx = {
  sessions: { get: () => undefined, flush: async () => {} },
  sessionPersistence: { stat: async (id) => (id === BOGUS ? undefined : { header: { id }, location: { path: `C:/tmp/${id}/session.v4.jsonl.zstd` } }) },
  workspaceRegistry: { list: () => [], archivedSessionIds: [], unpinSession: async () => {}, archiveSession: async () => {} },
  storageDomain: {
    get: (name) => {
      if (name === 'schedule') return { table: () => ({ entries: () => tasks.map((t) => [t.record.id, t]), get: async (id) => tasks.find((t) => t.record.id === id), put: async () => {}, delete: async () => {} }) };
      if (name === 'session_projcache') return { table: () => ({ entries: () => children.map((c) => [c.record.id, c]) }) };
      return undefined;
    },
  },
  get(name) {
    if (name === 'storageDomain') return this.storageDomain;
    if (name === 'subagent') return { listChildren: async () => [{ id: 'child-live' }] };
    return undefined;
  },
  emit() {},
  parallel: async () => {},
  logger: { warn: () => {}, debug: () => {} },
};

const makeRes = () => {
  const res = { status: 0, body: '' };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = body; };
  return res;
};
const req = (method, url, headers = {}, body = undefined) => ({
  method,
  url,
  headers,
  [Symbol.asyncIterator]: async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  },
});

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${a}${ok ? '' : `  expected=${e}`}`);
};

const found = tasksReferencing(ctx, BOGUS).map((t) => `${t.id}:${t.reasons.join('+')}`).sort();
check('任务扫描命中 target/involved/history，排除无关', found, ['task-history:history', 'task-involved:involved', 'task-target:target']);
check('new_once 任务的保留会话 id（session-schedule-<sha256(taskId)>）同样命中',
  tasksReferencing(ctx, RESERVED).map((t) => `${t.id}:${t.reasons.join('+')}`), ['task-reserved-1:reserved']);

check('子会话 = listChildren ∪ 投影缓存 parentSession 行', (await childrenOf(ctx, BOGUS)).sort(), ['child-a', 'child-live']);

const spill = await cleanSpill(BOGUS);
check('spill 清理只按精确名匹配，不存在的 id 不删任何东西', { removed: spill.removed.length, hasNote: typeof spill.note === 'string' }, { removed: 0, hasNote: false });

check('plan 对不存在的会话返回 not-found', await planDelete(ctx, BOGUS), { ok: false, code: 'not-found', exists: false });

// 0.3.3：plan 要分开报「实例驻留」(live) 与「有工作在跑」(active) —— 前者不该被
// 渲染成「正在运行」。
const planIdleLoaded = await planDelete({ ...ctx, waterfall: async () => [], sessions: { get: () => ({ header: { id: BOGUS } }), flush: async () => {} } }, BOGUS);
check('实例驻留但无活动 → live=true 且 active=false', { ok: planIdleLoaded.ok, live: planIdleLoaded.live, active: planIdleLoaded.active }, { ok: true, live: true, active: false });
const planBusy = await planDelete({ ...ctx, waterfall: async () => [{ kind: 'turn' }], sessions: { get: () => ({ header: { id: BOGUS } }), flush: async () => {} } }, BOGUS);
check('有 turn 在跑 → active=true 且带 activity 种类', { active: planBusy.active, activity: planBusy.activity }, { active: true, activity: ['turn'] });

// 鉴权门槛：connection 服务缺失 → 503（上游是放行）
let res = makeRes();
await handleDeleteRequest(ctx, req('POST', DELETE_PATH, { host: '127.0.0.1:7087' }), res);
check('无 connection 服务时拒绝删除（503）', res.status, 503);

// 非 owner peer → 403
const ownerCtx = { ...ctx, get(name) { if (name === 'connection') return { admit: () => ({ peer: { principal: { kind: 'remote' } } }) }; return ctx.get(name); } };
res = makeRes();
await handleDeleteRequest(ownerCtx, req('POST', DELETE_PATH, { host: '127.0.0.1:7087' }), res);
check('非 owner peer → 403', res.status, 403);

// admit 拒绝 → 原样映射 401
const rejectCtx = { ...ctx, get(name) { if (name === 'connection') return { admit: () => ({ rejection: 401 }) }; return ctx.get(name); } };
res = makeRes();
await handleDeleteRequest(rejectCtx, req('POST', DELETE_PATH, { host: '127.0.0.1:7087' }), res);
check('admit 拒绝 → 401', res.status, 401);

// owner + 跨源 Origin → 403（上游的「缺 origin 放行」与 localhost 端口通配已删除）
const passCtx = { ...ctx, get(name) { if (name === 'connection') return { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }; return ctx.get(name); } };
for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null']) {
  res = makeRes();
  await handleDeleteRequest(passCtx, req('POST', DELETE_PATH, { host: '127.0.0.1:7087', origin }), res);
  check(`跨源 Origin ${origin} → 403`, res.status, 403);
}
res = makeRes();
await handleDeleteRequest(passCtx, req('POST', DELETE_PATH, { host: '127.0.0.1:7087', origin: 'http://127.0.0.1:7087' }, { sessionId: BOGUS }), res);
check('同源自检通过 → 走到存在性校验 404', res.status, 404);
res = makeRes();
await handlePlanRequest(passCtx, req('GET', `${PLAN_PATH}?sessionId=${BOGUS}`, { host: '127.0.0.1:7087' }), res);
check('plan 缺 origin 的同源 GET → 200/404 业务码', res.status, 404);
res = makeRes();
await handleDeleteRequest(passCtx, req('GET', DELETE_PATH, { host: '127.0.0.1:7087' }), res);
check('删除路由只接受 POST → 405', res.status, 405);

// —— 0.3.1：路由生命周期 + 插件重载后旧 ctx 失活 ——
// 现场故障：重装插件后旧 fiber 已 disposed、旧路由仍占位，请求打进去抛
// `cannot get required service "sessions" in inactive context`（cordis:1271）。
const makeServer = () => {
  const routes = new Map();
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
};
const makeApplyCtx = (server, log) => {
  const cleanups = [];
  const ctx = { fiber: { runtime: {} }, logger: { warn: (m) => log.push(m), debug: () => {} }, get: () => undefined };
  const web = { webServer: server, logger: ctx.logger, effect: (fn) => { cleanups.push(fn()); } };
  ctx.inject = (_deps, callback) => callback(web);
  return { ctx, cleanups };
};

let log = [];
let server = makeServer();
let applied = makeApplyCtx(server, log);
apply(applied.ctx);
check('apply 注册 plan + delete 两条 exact 路由', [...server.routes.keys()].sort(), [DELETE_PATH, PLAN_PATH].sort());
check('apply 把 disposer 交回 effect（0.3.0 漏了这一步）', typeof applied.cleanups[0], 'function');
applied.cleanups[0]();
check('插件卸载后两条路由随 fiber 下线', server.routes.size, 0);

// 上一代遗留路由占位：apply 不许抛，只 warn（否则重载后整个插件再也注册不上）
log = [];
server = makeServer();
server.register({ kind: 'exact', path: PLAN_PATH, handler: () => {} });
applied = makeApplyCtx(server, log);
apply(applied.ctx);
check('遗留旧路由占位时 apply 不抛，且只注册剩下那条', {
  registered: server.routes.has(DELETE_PATH),
  warned: log.length === 1 && log[0].includes('注册失败'),
}, { registered: true, warned: true });

// 旧一代 ctx（fiber.runtime 已不存在）→ 换用最近一次 apply 的 ctx，而不是抛 inactive
server = makeServer();
applied = makeApplyCtx(server, []);
apply(applied.ctx);
const staleCtx = { fiber: { runtime: undefined }, get() { throw new Error('cannot get required service "sessions" in inactive context'); } };
res = makeRes();
await handlePlanRequest(staleCtx, req('GET', `${PLAN_PATH}?sessionId=${BOGUS}`, { host: '127.0.0.1:7087' }), res);
check('失活 ctx 自动换用最新 ctx（不再抛 inactive context）', res.status, 503);

// inactive 错误如果仍漏到 catch，必须翻成 503 + 可操作话术
const explodeCtx = { fiber: { runtime: {} }, get() { throw new Error('cannot get required service "sessions" in inactive context'); } };
res = makeRes();
await handlePlanRequest(explodeCtx, req('GET', `${PLAN_PATH}?sessionId=${BOGUS}`, { host: '127.0.0.1:7087' }), res);
check('inactive context 漏到 catch → 503 + 提示刷新/重启', {
  status: res.status,
  actionable: JSON.parse(res.body).error.includes('刷新页面'),
}, { status: 503, actionable: true });

// 连 currentCtx 都没有（重载时序极端）：仍是 503，不是 500
res = makeRes();
await handlePlanRequest(undefined, req('GET', `${PLAN_PATH}?sessionId=${BOGUS}`, { host: '127.0.0.1:7087' }), res);
check('ctx 完全缺失 → 503（不是 500 或抛异常）', res.status, 503);

// —— 0.3.2：删除中止必须回滚归档；判据是「没有在跑的工作」而不是「实例已退出」 ——
// 现场故障：0.3.x 先归档（列表里隐藏）再判断实例是否退出，宿主只取消 turn、不踢
// store，于是「会话刚用完就删」被判成 still-active 中止 —— 会话已消失但文件都在。
const TID = 'session-test-temp-0001';
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-'));
const tempDir = join(tempRoot, TID);
const tempFile = join(tempDir, 'session.v4.jsonl.zstd');
mkdirSync(tempDir, { recursive: true });
writeFileSync(tempFile, 'x'.repeat(64));

function makeDeleteCtx({ archived = [], loaded = true, activity = () => [], registry = {} } = {}) {
  const state = { archived: [...archived], unarchived: [] };
  const workspaceRegistry = {
    list: () => [],
    get archivedSessionIds() { return state.archived; },
    async archiveSession(id, options = {}) {
      if (options.stopActivity !== true) throw new Error('自检：应当带 stopActivity');
      if (!state.archived.includes(id)) state.archived.push(id);
    },
    async unarchiveSession(id) {
      state.unarchived.push(id);
      state.archived = state.archived.filter((x) => x !== id);
    },
    unpinSession: async () => {},
    ...registry,
  };
  const domain = {
    get: () => ({
      table: () => ({
        entries: () => [],
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      }),
    }),
  };
  return {
    state,
    ctx: {
      sessions: { get: () => (loaded ? { header: { id: TID } } : undefined), flush: async () => {} },
      sessionPersistence: {
        stat: async (id) => (id === TID && existsSync(tempFile) ? { header: { id }, location: { path: tempFile } } : undefined),
        // live 实例的 readMeta 只拿 header、不带 location，路径要靠 locate 解析
        locate: (meta) => ({ path: tempFile, header: meta }),
      },
      workspaceRegistry,
      storageDomain: domain,
      get(name) { return name === 'storageDomain' ? this.storageDomain : undefined; },
      emit: () => {},
      parallel: async () => {},
      waterfall: async () => activity(),
      logger: { warn: () => {}, debug: () => {} },
    },
  };
}

// 关键回归：实例仍驻留内存（标签页开着）但**没有在跑的工作** → 必须删成功
const live = makeDeleteCtx({ loaded: true, activity: () => [] });
const r1 = await deleteSession(live.ctx, TID);
check('实例驻留内存但无活动 → 删除成功（旧判据会说 session-active）', {
  ok: r1.ok,
  fileGone: !existsSync(tempFile),
  warned: Array.isArray(r1.warnings) && r1.warnings.some((w) => w.includes('驻留宿主内存')),
}, { ok: true, fileGone: true, warned: true });

// 真的有工作没停 → 中止，且归档桥接被回滚（会话不能就这么消失）
mkdirSync(tempDir, { recursive: true });
writeFileSync(tempFile, 'y'.repeat(64));
const busy = makeDeleteCtx({ loaded: true, activity: () => [{ kind: 'turn' }] });
const r2 = await deleteSession(busy.ctx, TID);
check('仍有未结束的 turn → 中止且不删文件', { ok: r2.ok, code: r2.code, fileGone: !existsSync(tempFile) }, { ok: false, code: 'session-active', fileGone: false });
check('中止时回滚本次归档（会话重新可见）', { archived: busy.state.archived, unarchived: busy.state.unarchived }, { archived: [], unarchived: [TID] });

// 用户自己归档过的会话：中止时不许替用户取消归档
const preArchived = makeDeleteCtx({ archived: [TID], loaded: true, activity: () => [{ kind: 'turn' }] });
const r3 = await deleteSession(preArchived.ctx, TID);
check('本来已归档 → 中止时不擅自取消归档', { archived: preArchived.state.archived, unarchived: preArchived.state.unarchived }, { archived: [TID], unarchived: [] });

// 定时任务未确认 → 一步都没删，同样要回滚归档
const withTask = makeDeleteCtx({ loaded: true, activity: () => [] });
withTask.ctx.storageDomain = {
  get: () => ({ table: () => ({ entries: () => [[ 'task-x', { record: { id: 'task-x' }, target: { kind: 'session', sessionId: TID }, status: 'active' } ]], get: async () => undefined, put: async () => {}, delete: async () => {} }) }),
};
const r4 = await deleteSession(withTask.ctx, TID);
check('有活动定时任务且未确认 → 中止、回滚归档、文件保留', {
  ok: r4.ok, code: r4.code, fileGone: !existsSync(tempFile), archived: withTask.state.archived, unarchived: withTask.state.unarchived,
}, { ok: false, code: 'tasks-reference', fileGone: false, archived: [], unarchived: [TID] });

rmSync(tempRoot, { recursive: true, force: true });

// —— 0.3.4：子会话枚举的兜底 ——
// 现场：子会话的投影缓存行里**没有** parentSession，而父会话日志一旦先被删，
// subagentCatalog 就再也读不到 —— 两条路同时失灵，子会话静默变孤儿。
const PARENT = 'session-test-parent-0001';
const CHILD_A = 'bb88afd7-8b12-48bc-8568-4f4d11d5fdd0';
const CHILD_B = 'c611096b-b757-467f-a88f-f8e870a9ae6c';
const headers = [
  { id: PARENT },
  { id: CHILD_A, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 },
  { id: CHILD_B, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 },
  { id: 'session-unrelated-0002' },
];
const brokenCatalogCtx = {
  get(name) {
    if (name === 'subagent') {
      return { listChildren: async () => { throw new Error('SUBAGENT_CONTROL_QUERY_UNAVAILABLE'); } };
    }
    if (name === 'storageDomain') return { get: () => ({ table: () => ({ entries: () => [] }) }) };
    return undefined;
  },
  sessionPersistence: { list: async () => headers.map((header) => ({ header })) },
  logger: { warn: () => {}, debug: () => {} },
};
const scan = await childrenOfDetailed(brokenCatalogCtx, PARENT);
check('目录投影失效时，按会话头部 parentSession 兜底找出全部子会话',
  scan.children.sort(), [CHILD_A, CHILD_B].sort());
check('兜底生效时明确告知「目录投影不可用」而不是静默', {
  noted: scan.notes.some((n) => n.includes('目录投影不可用') && n.includes('兜底')),
}, { noted: true });

// 两条路都废：必须警告「可能残留」，不能装作扫全了
const blindCtx = {
  get: () => undefined,
  sessionPersistence: { list: async () => { throw new Error('list failed'); } },
  logger: { warn: () => {}, debug: () => {} },
};
const blind = await childrenOfDetailed(blindCtx, PARENT);
check('枚举完全失效时警告可能有子会话残留', {
  children: blind.children.length,
  warned: blind.notes.some((n) => n.includes('可能有子会话残留')),
}, { children: 0, warned: true });

// 删后复核：还能按 header 找到残留
check('删后复核能列出仍指向该父会话的子会话', await leftoverChildren(brokenCatalogCtx, PARENT), [CHILD_A, CHILD_B]);
check('删后复核：父会话已无子会话时返回空', await leftoverChildren(brokenCatalogCtx, 'session-unrelated-0002'), []);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;