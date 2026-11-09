#!/usr/bin/env node
/**
 * 证据自校验：git 里的审计报告正文 == 当时交付的原文（只读）。
 *
 * 仓库里存着两份：
 *   - docs/审计报告-dsh-delete-sessions-0.2.2.md —— 交付原件，文件名与内容一字未改；
 *   - docs/AUDIT-0.2.2.md —— 同一份正文，前面加了「这份报告在审什么」前言（供应链基线 + 取证方式）。
 * 本脚本证明：把前言剥掉之后，两者**逐字符一致**，即「加前言」不等于「改结论」。
 *
 * 归一化只做行尾（git 的 autocrlf 会写 CRLF，交付原件是 LF），不改空白、不改标点。
 *
 * 用法：node tools/audit/verify-report-verbatim.mjs
 * 退出码：0 = 一致；1 = 不一致（打印首个差异位置）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const deliveredPath = join(root, 'docs', '审计报告-dsh-delete-sessions-0.2.2.md');
const auditedPath = join(root, 'docs', 'AUDIT-0.2.2.md');

if (!existsSync(deliveredPath) || !existsSync(auditedPath)) {
  console.error('缺少文件：docs/审计报告-dsh-delete-sessions-0.2.2.md 或 docs/AUDIT-0.2.2.md');
  process.exit(1);
}

const norm = (s) => s.replace(/\r\n/g, '\n');
const delivered = norm(readFileSync(deliveredPath, 'utf8')).trim();

const audited = norm(readFileSync(auditedPath, 'utf8'));
const sep = audited.indexOf('\n---\n');
if (sep < 0) {
  console.error('docs/AUDIT-0.2.2.md 里找不到前言分隔符（\\n---\\n），无法剥离前言。');
  process.exit(1);
}
const body = audited.slice(sep + 5).trim();

console.log(`交付原件      : ${delivered.length} 字符  ${deliveredPath}`);
console.log(`仓库版剥前言后: ${body.length} 字符  ${auditedPath}`);
console.log(`仓库版前言长度: ${audited.slice(0, sep).trim().length} 字符`);

if (body === delivered) {
  console.log('结论: IDENTICAL —— 正文逐字符一致，仓库版只多了前言。');
  process.exit(0);
}

let i = 0;
while (i < Math.min(body.length, delivered.length) && body[i] === delivered[i]) i++;
const line = delivered.slice(0, i).split('\n').length;
console.log(`结论: DIFFER —— 首个差异在第 ${line} 行附近，偏移 ${i}`);
console.log(`  交付原件: ${JSON.stringify(delivered.slice(i, i + 80))}`);
console.log(`  仓库版本: ${JSON.stringify(body.slice(i, i + 80))}`);
process.exit(1);
