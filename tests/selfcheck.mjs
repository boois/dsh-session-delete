/**
 * 非破坏性自检：用假 ctx 验证 0.3.0 的鉴权门槛、任务扫描、spill 命名与
 * 「不存在会话」路径。只用不存在的 id，绝不触碰真实数据。
 */
import { createHash } from 'node:crypto';
import {
  tasksReferencing,
  childrenOf,
  cleanSpill,
  planDelete,
  handleDeleteRequest,
  handlePlanRequest,
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
