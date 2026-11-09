#!/usr/bin/env node
/**
 * 最小 asar 读取器（审计取证，只读）。
 *
 * 用途：不装 asar 依赖，直接解析 Electron asar 头部，列出/导出宿主核心包源码，
 * 用于把插件调用的宿主 API（如 connection.admit、workspaceRegistry、schedule 写回路径）
 * 与真实实现对齐。审计中的 7 文件字节一致核对、以及所有形如 dsh-xxx/lib/index.js:行号 的引用都出自这里。
 *
 * 格式（本机实测）：[@0 uint32=4][@4 uint32=头部余长][@8 uint32=余长-4][@12 uint32=JSON长度][@16 JSON…][文件区]
 *      文件区基址 = 8 + @4；每个节点的 offset 是相对该基址的字符串。
 *
 * 只读：不修改 asar；--dump 把单个文件写到 stdout 指定路径（默认写到当前目录）。
 *
 * 用法：
 *   node tools/audit/asar-list.mjs <app.asar 路径> [路径子串过滤] [--limit=50]
 *   node tools/audit/asar-list.mjs <app.asar 路径> --dump=dsh/node_modules/@deepseek-ai/dsh-xxx/lib/index.js [--out=目录]
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('用法: node tools/audit/asar-list.mjs <app.asar> [子串过滤] [--limit=50] [--dump=<包内路径>] [--out=目录]');
  process.exit(1);
}
const args = process.argv.slice(3);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const filter = args.find((a) => !a.startsWith('--')) ?? '';
const limit = Number(opt('limit', 50));
const dump = args.some((a) => a.startsWith('--dump=')) ? opt('dump') : null;
const outDir = opt('out', process.cwd());

const fd = openSync(file, 'r');
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
// 实测布局（本机 app.asar，213,202,918 B）：
//   @0 = 4（Pickle blockSize）  @4 = 头部余长  @12 = JSON 长度（4 对齐）  @16 = '{'
//   文件区基址 = 8 + @4
// 直接从 @0 或 @8 当 JSON 长度读会截断，这是所有 asar 手解脚本的头号坑。
let jsonStart = 16;
let jsonLen = head.readUInt32LE(12);
let baseOffset = 8 + head.readUInt32LE(4);
const jsonBuf = Buffer.alloc(jsonLen);
readSync(fd, jsonBuf, 0, jsonLen, jsonStart);
let header;
try {
  header = JSON.parse(jsonBuf.toString('utf8'));
} catch {
  // 回退：在头部窗口里找 '{'，用紧邻的前置 uint32 反推长度，再按 4 对齐算文件区基址。
  const window = Buffer.alloc(64);
  readSync(fd, window, 0, 64, 0);
  jsonStart = window.indexOf(0x7b);
  if (jsonStart < 0) throw new Error('头部 64 字节内找不到 JSON 起点，不是 asar 归档');
  jsonLen = window.readUInt32LE(jsonStart - 4);
  const body = Buffer.alloc(jsonLen);
  readSync(fd, body, 0, jsonLen, jsonStart);
  header = JSON.parse(body.toString('utf8').replace(/\0+$/, ''));
  baseOffset = jsonStart + Math.ceil(jsonLen / 4) * 4;
}

const rows = [];
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p);
    else rows.push({ path: p, offset: Number(child.offset), size: Number(child.size), unpacked: !!child.unpacked });
  }
}
walk(header, '');

if (dump) {
  const hit = rows.find((r) => r.path === dump);
  if (!hit) {
    closeSync(fd);
    console.error(`包内没有该条目：${dump}（先用过滤模式搜路径）`);
    process.exit(1);
  }
  const buf = Buffer.alloc(hit.size);
  readSync(fd, buf, 0, hit.size, baseOffset + hit.offset);
  closeSync(fd);
  const out = join(outDir, dump.replace(/^.*?node_modules\//, ''));
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log(`已导出 ${hit.size} B → ${out}`);
  process.exit(0);
}

const matched = rows.filter((r) => !filter || r.path.includes(filter));
console.log(`archive: ${file}  总大小 ${statSync(file).size} B  条目总数 ${rows.length}  命中 ${matched.length}`);
for (const r of matched.slice(0, limit)) {
  console.log(`${String(r.size).padStart(10)}  @${String(r.offset).padStart(11)}  ${r.path}${r.unpacked ? '  (unpacked)' : ''}`);
}
if (matched.length > limit) console.log(`… 还有 ${matched.length - limit} 条（--limit= 调大）`);
closeSync(fd);
