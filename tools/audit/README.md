# 审计取证脚本（`tools/audit`）

这里是 [审计报告](../AUDIT-0.2.2.md) 的**可复现证据链**：报告里的每一条结论，都对应下面某支脚本的一次真实运行。
fork 之后我们改了插件本身（见 [README](../README.md)），所以把「当初为什么判它 3 严重 / 5 中 / 4 低」的证据一起留在仓库里 —— 结论可以被任何人重新跑出来复核，而不是只能相信一段文字。

## 先看边界

- **全部只读。** 探针只打 `GET plan` / `GET delete` / `POST delete` 三类请求，且 id 写死为不存在的 `session-audit-nonexistent-0000`；喂进别的 id 会**直接拒绝运行**（实测 `exit=1`）。
- **不写 `~/.dsh`。** asar 脚本只解析头部、`--dump` 只往 `--out` 指定的目录写；tar 脚本在内存里解析，不解压。
- 审计期为取证解包的 `app.asar`（6931 文件 / 92 MB）与自制解析器**已按要求删除**，不进仓库（仓库不放大文件、也不放宿主源码）。这些脚本在任何一台装了 DSH 的机器上都能重跑。

## 脚本索引

| 脚本 | 证明什么 | 命令 |
| --- | --- | --- |
| [`verify-report-verbatim.mjs`](verify-report-verbatim.mjs) | 仓库里的报告正文 == 当时交付的原文（加前言 ≠ 改结论） | `node tools/audit/verify-report-verbatim.mjs` |
| [`compare-lf-hash.ps1`](compare-lf-hash.ps1) | npm 发布物 == git 提交（读到的源码就是发布出去的源码） | `pwsh -File tools/audit/compare-lf-hash.ps1 -NpmDir <包目录> -GitDir <仓库>` |
| [`probe-endpoints.mjs`](probe-endpoints.mjs) | 删除端点的鉴权闸门实测（0.2.2 的 S1 与 0.3.0 的修复对照） | `node tools/audit/probe-endpoints.mjs --base=http://127.0.0.1:<port>` |
| [`tar-inspect.mjs`](tar-inspect.mjs) | 发布包的真实内容清单（`assets/` 缺失、目录包体积异常） | `node tools/audit/tar-inspect.mjs <路径.tgz>` |
| [`asar-list.mjs`](asar-list.mjs) | 宿主核心契约逐条比对（报告里所有 `<core>\...:行号` 出处） | `node tools/audit/asar-list.mjs <app.asar> <路径子串>` |

## 2026-11-09 重跑实测

### 1. 报告原文未被改

```
交付原件      : 18465 字符
仓库版剥前言后: 18465 字符
仓库版前言长度: 638 字符
结论: IDENTICAL —— 正文逐字符一致，仓库版只多了前言。
```

`docs/审计报告-dsh-delete-sessions-0.2.2.md` 是交付原件（文件名、内容一字未改），`docs/AUDIT-0.2.2.md` 是同一份正文 + 638 字符前言（说明审的是哪个 npm 版本、对应哪个 commit、用了什么取证方式）。

### 2. 发布物 == 仓库

审计期（0.2.2）：`package.json` / `README.md` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` / `LICENSE` / `screenshots.json` —— **LF 归一后 7/7 IDENTICAL**，对应 npm registry 记的 `gitHead = d0c85e3178960baa91beb6ef9150fdb974be880b`。

本轮对 0.3.0 的已安装副本复跑：

```
package.json / cordis.patch.yml / lib/index.js / lib/client.js / LICENSE / screenshots.json   IDENTICAL
README.md   DIFFER   npm=ffa880982a61 git=feb1a071ee1e
负控制 DIFFER —— 正常
```

`README.md` 那一条 DIFFER 是**预期的**：已安装副本停在 `v0.3.0` 那个提交（`6377532`），仓库 HEAD 多了后续文档提交。重装（`git+ssh://…#hardened`）后复跑，见本节末尾。

### 3. 鉴权闸门实测

本轮（fork `@boois/dsh-delete-sessions` 0.3.0，live 端口 27116，id = `session-audit-nonexistent-0000`）：

| 请求 | 状态码 | 响应 |
| --- | --- | --- |
| POST delete 无 Origin 无 cookie（本机脚本形态） | `401` | `{"ok":false,"error":"unauthenticated"}` |
| POST delete `Origin: https://evil.example` | `403` | `{"ok":false,"error":"origin not trusted"}` |
| POST delete `Origin: null` | `403` | `{"ok":false,"error":"origin not trusted"}` |
| POST delete `Origin: http://127.0.0.1:9999` | `403` | `{"ok":false,"error":"origin not trusted"}` |
| GET `plan?sessionId=<不存在的 id>` | `401` | `{"ok":false,"error":"unauthenticated"}` |
| GET `delete`（方法白名单） | `405` | `{"ok":false,"error":"method not allowed"}` |

同一支脚本打上游包名 `dsh-delete-sessions`（已卸载）：POST → `405`、GET → `404`，宿主 fallback 接手，插件路由已下线。

对照 0.2.2 审计期的实测（报告第 2 节原文）：

| 请求 | 0.2.2 | 0.3.0 |
| --- | --- | --- |
| POST 无 Origin | `404 session not found`（**进到了删除逻辑，鉴权未拦截** = S1） | `401 unauthenticated` |
| `Origin: http://127.0.0.1:9999` | `404`（**端口不参与校验**） | `403 origin not trusted` |
| `Origin: http://localhost:7087` | `404`（主机名匹配即放行） | 端口参与比较 → 不匹配即 `403` |
| `Origin: https://evil.example` | `403` | `403` |
| GET | `405` | `405` |

停用后复测得到 `405`（路由随插件停用而下线），这条也在报告里。

### 4. 发布包内容清单

本轮现场造包（`tar -czf … lib docs README.md package.json`，34,241 B）后解析：

```
解包后条目: 7（文件 5）   文件净体积: 90871 B
     31233  lib/index.js
     28674  docs/AUDIT-0.2.2.md
     14815  README.md
     14416  lib/client.js
      1733  package.json
注意：清单中**没有** assets/
```

审计期用它查过两件事：0.2.2 的 npm 包声明了 `assets/01-…png`、`assets/02-…png` 却**不含 `assets/`**（市场页截图恒 404）；以及一个 26.5 MB 的目录包 tarball 实际只含 7 个文本文件，体积与内容不符，当时列为待查项。

### 5. 宿主契约比对

本轮对真实 `app.asar`（213,202,918 B）解析：**22102 个条目**，命中

```
     44434  @   19559630  dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js
    114408  @  112521949  dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js
    138196  @  104812134  dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js
```

导出 `dsh-client-connection/lib/index.js`（44,434 B）后 `node --check` 通过 —— 说明偏移量算对了，读到的就是宿主真身。同一支脚本查 `dsh-delete-sessions`：命中 0，插件不在宿主包内（是 profile 级安装）。报告里 `<core>\dsh-client-connection\lib\index.js:1049` 这类行号引用，全部出自这条路径。

### 重装后复跑（第 2 节收尾）

按 [README 的安装/更新流程](../README.md) 用同一条 spec 重装（`git+ssh://git@github.com/boois/dsh-session-delete.git#hardened`，pnpm `Done in 3.8s`）后复跑：

```
package.json             IDENTICAL
README.md                IDENTICAL
cordis.patch.yml         IDENTICAL
lib/index.js             IDENTICAL
lib/client.js            IDENTICAL
LICENSE                  IDENTICAL
screenshots.json         IDENTICAL
--- 负控制（必须判 DIFFER，否则说明哈希函数没在跑）---
负控制 DIFFER —— 正常
全部一致，且负控制有效
```

即：**已安装的运行副本与仓库 HEAD 逐字节一致（仅行尾归一）**，装到你机器上的东西和这里的源码是同一份。

维护时注意一个插件管理器的记账怪癖：这次重装 pnpm 返回 `exitCode 0` / `Packages: +1`，而管理器的 `application` 报 `failed` + `error.code = "ambiguous-install"`（pnpm 的变更行没点出包名时就会这样，`changed:false`）。实测内容**确实已更新**（已安装 README 里能搜到本次新增的文案，且上表 7/7 一致）。所以别只看那个字段，用这支脚本量一遍更可靠。

## 复现顺序

```bash
npm test              # node --check ×2 + tests/selfcheck.mjs（14 条断言）
npm run test:audit    # 语法检查本目录三支 .mjs
node tools/audit/verify-report-verbatim.mjs
pwsh -File tools/audit/compare-lf-hash.ps1 -NpmDir <安装目录> -GitDir <仓库目录>
node tools/audit/probe-endpoints.mjs --base=http://127.0.0.1:<live端口>
node tools/audit/asar-list.mjs "<app.asar 路径>" dsh-schedule/lib/index.js
node tools/audit/tar-inspect.mjs <包.tgz>
```

## 写这些脚本时踩到的坑（复现时大概率再踩）

1. **假阳性的哈希比对**：PowerShell 里函数名取 `H` 会撞内置别名 `h`(=`Get-History`)，哈希全返回空串 → 空串 == 空串 → 输出「7/7 一致」。`compare-lf-hash.ps1` 因此内置两条硬约束：空哈希判 `HASH-ERROR`，以及每轮必跑的**负控制**（两个已知不同的文件必须判 `DIFFER`，否则整轮结果作废）。
2. **注释里的 `*/`**：块注释写 `dsh-*/lib/index.js` 会提前闭合注释，整支 `.mjs` 语法崩（本轮真实发生）。
3. **asar 头部布局**：不能从 `@0` 或 `@8` 当 JSON 长度读。本机实测 `@0=4`、`@4=头部余长(5748132)`、`@12=JSON 长度(5748124)`、`@16` 才是 `{`，文件区基址 = `8 + @4`。
4. **`node:zlib` 的 ESM 导出**：`createDecompressSync` 不是具名导出，`import { createDecompressSync } from 'node:zlib'` 会直接报错，用 `gunzipSync`。
5. **行尾**：Windows 上 git 的 autocrlf 把工作副本写成 CRLF，npm tarball 里是 LF；不做归一化会把行尾差异报成内容差异（本轮 0.3.0 首轮比对 9/9「全 DIFFER」就是这么来的）。
6. **参数索引**：node 脚本的入参是 `process.argv[2]`，写成 `[1]` 会让脚本读自己，输出一串 `const fs …` 的「asar 头部」。

## 与发布物的关系

`package.json` 的 `files` 只含 `lib` / `docs` / `cordis.patch.yml` / `README.md` / `LICENSE` / `screenshots.json` / `assets`：
**`tools/` 与 `tests/` 不进 npm 包**，取证与自测只存在于 git。审计结论与修复说明（`docs/`）会随包发布，装包的人在你机器上看到的东西和仓库里是同一份。
