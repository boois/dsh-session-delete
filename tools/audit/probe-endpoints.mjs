#!/usr/bin/env node
/**
 * 只读鉴权探针（审计取证 / 回归自证）。
 *
 * 目的：在不删除任何东西的前提下，证明删除端点的鉴权闸门在哪一层生效。
 * 全程只使用一个**不存在**的 session id，因此对真实数据零影响：
 *   - GET  plan   → 只读预检
 *   - GET  delete → 只走方法白名单
 *   - POST delete → 期望在鉴权层被拦下，永远走不到删除逻辑
 *
 * 用法：
 *   node tools/audit/probe-endpoints.mjs --base=http://127.0.0.1:7087
 *   node tools/audit/probe-endpoints.mjs --base=http://127.0.0.1:7087 --package=dsh-delete-sessions
 *
 * 保护：--id 必须等于内置的审计专用 id，否则拒绝运行（防止误把真实会话喂进探针）。
 */
import { request } from 'node:http';

const AUDIT_ID = 'session-audit-nonexistent-0000';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const base = new URL(arg('base', 'http://127.0.0.1:7087'));
const pkg = arg('package', '@boois/dsh-delete-sessions');
const id = arg('id', AUDIT_ID);
const allowAny = process.argv.includes('--allow-any-id');

if (id !== AUDIT_ID && !allowAny) {
  console.error(`拒绝运行：--id 必须等于审计专用 id "${AUDIT_ID}"（确认请显式加 --allow-any-id）。`);
  process.exit(1);
}

const routes = { plan: `/plugins/${pkg}/plan`, delete: `/plugins/${pkg}/delete` };

function probe(label, method, path, headers = {}, body = null) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
          resolve({ label, status: res.statusCode, body: text.slice(0, 160) });
        });
      },
    );
    req.on('error', (e) => resolve({ label, status: `ERR ${e.code ?? e.message}`, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ label, status: 'TIMEOUT', body: '' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const targets = [
  probe('POST delete  无 Origin 无 cookie（本机脚本形态）', 'POST', routes.delete, {}, { sessionId: id }),
  probe('POST delete  Origin=https://evil.example', 'POST', routes.delete, { Origin: 'https://evil.example' }, { sessionId: id }),
  probe('POST delete  Origin=null', 'POST', routes.delete, { Origin: 'null' }, { sessionId: id }),
  probe('POST delete  Origin=http://127.0.0.1:9999', 'POST', routes.delete, { Origin: 'http://127.0.0.1:9999' }, { sessionId: id }),
  probe('GET  plan?sessionId=<不存在的 id>', 'GET', `${routes.plan}?sessionId=${encodeURIComponent(id)}`),
  probe('GET  delete（方法白名单）', 'GET', routes.delete),
  probe('GET  plan（无 sessionId）', 'GET', routes.plan),
];

console.log(`target: ${base.origin}  package: ${pkg}  id: ${id}`);
for (const t of await Promise.all(targets)) {
  console.log(`${String(t.label).padEnd(52)} ${String(t.status).padEnd(5)} ${t.body}`);
}
