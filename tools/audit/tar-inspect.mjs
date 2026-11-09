#!/usr/bin/env node
/**
 * 纯 JS tar/tgz 读取器（审计取证）。
 *
 * 用途：核对 Official 目录包 / npm tarball 的**真实内容清单**，不依赖 tar 二进制。
 * 审计中用它证明过两件事：
 *   1. 0.2.2 的 npm tarball 里没有 assets/（市场截图在发版时未提交）；
 *   2. 一个 26.5 MB 的目录包 tarball 实际只含 7 个文本文件——体积与内容不符，当时列为待查项。
 *
 * 只读：不解压到磁盘，只解析头部与统计。
 *
 * 用法：
 *   node tools/audit/tar-inspect.mjs <路径.tgz|路径.tar> [--top=20]
 */
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/audit/tar-inspect.mjs <tar/tgz 路径> [--top=20]');
  process.exit(1);
}
const top = Number((process.argv.find((a) => a.startsWith('--top=')) ?? '--top=20').slice(6));

const raw = readFileSync(file);
const buf = file.endsWith('.gz') || file.endsWith('.tgz') ? gunzipSync(raw) : raw;

const entries = [];
let offset = 0;
while (offset + 512 <= buf.length) {
  const header = buf.subarray(offset, offset + 512);
  if (header.every((b) => b === 0)) break; // 结尾填充块
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
  const type = String.fromCharCode(header[156] || 0x30);
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const size = parseInt(sizeField, 8) || 0;
  const full = prefix ? `${prefix}/${name}` : name;
  if (type === '5' || name.endsWith('/')) entries.push({ name: full, type: 'dir', size: 0 });
  else if (type === '0' || type === '\0' || type === '7') entries.push({ name: full, type: 'file', size });
  else entries.push({ name: full, type: `special:${type}`, size });
  offset += 512 + Math.ceil(size / 512) * 512;
}

const files = entries.filter((e) => e.type === 'file');
const total = files.reduce((s, e) => s + e.size, 0);

console.log(`archive: ${file}`);
console.log(`磁盘压缩体积: ${statSync(file).size} B   解包后条目: ${entries.length}（文件 ${files.length}）   文件净体积: ${total} B`);
console.log('--- 文件清单（按体积降序，前 ' + top + '）---');
for (const e of files.sort((a, b) => b.size - a.size).slice(0, top)) {
  console.log(`${String(e.size).padStart(10)}  ${e.name}`);
}
const dirs = new Set(files.map((e) => e.name.split('/')[0]));
console.log('--- 顶层目录 ---');
console.log([...dirs].sort().join(', ') || '(无)');
if (!dirs.has('assets')) console.log('注意：清单中**没有** assets/（市场截图不进包）。');
