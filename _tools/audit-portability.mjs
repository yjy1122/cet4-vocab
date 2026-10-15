/* audit-portability.mjs — 扫工具脚本里写死的机器路径。
 *
 * 为什么需要：CI 在 Ubuntu 上跑，而 _tools 里好几个脚本把仓库根写成
 * "D:\Users\...\新建文件夹"。本机永远跑得通，一上 CI 就 ENOENT——
 * 这类缺陷不可能靠"在我这台机器上试一下"发现，只能静态扫。
 * 本轮 audit-wiring.mjs / xref.mjs 就是这么把 CI 弄失败的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exts = new Set(['.mjs', '.js', '.py', '.sh', '.ps1']);

/* 本机引导脚本写死路径是它们的职责，不算违规 */
const ALLOW = new Map([
  ['_tools/install-git.ps1', '本机 git 引导：它就是把工具链装进这台机器的这个目录'],
  ['_tools/toolchain-and-build.ps1', '本机 APK 构建引导：同上，且会自建 .tooling'],
]);

const PATTERNS = [
  ['盘符下的用户目录', /[A-Za-z]:[\\/]+[Uu]sers[\\/]/],
  ['中文工作区目录名', /新建文件夹/],
];

/* 注释行不算依赖：test-logic 里"以前这里硬编码 …"是说明文字。
   注意要同时覆盖 // 、# 、/* 块注释起始行、以及块注释的续行（以 * 开头）。 */
const isComment = (line) => /^\s*(\/\/|#|\/\*|\*|<!--)/.test(line);

/* 本文件自己不算：它的"模式列表"里必然含有这些字面量，那是数据不是路径依赖。 */
const SELF = '_tools/audit-portability.mjs';

/* 扫 _tools/ 全部 + 仓库根散落的脚本。一层就够，不递归。 */
const targets = [];
for (const f of fs.readdirSync(path.join(root, '_tools'))) {
  const p = path.join(root, '_tools', f);
  if (fs.statSync(p).isFile() && exts.has(path.extname(f))) targets.push('_tools/' + f);
}
for (const f of fs.readdirSync(root)) {
  const p = path.join(root, f);
  if (fs.statSync(p).isFile() && exts.has(path.extname(f))) targets.push(f);
}

const allowed = [], bad = [];
for (const rel of targets) {
  if (rel === SELF) continue;
  if (ALLOW.has(rel)) { allowed.push({ rel, why: ALLOW.get(rel) }); continue; }
  const txt = fs.readFileSync(path.join(root, rel), 'utf8');
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;              // 注释里提到旧路径是说明，不是依赖
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) bad.push({ rel, line: i + 1, name, text: line.trim().slice(0, 90) });
    }
  }
}

console.log(`扫描 ${targets.length} 个工具脚本`);
for (const a of allowed) console.log(`  允许  ${a.rel} —— ${a.why}`);
if (bad.length) {
  for (const f of bad) console.log(`  ❌ ${f.rel}:${f.line}  ${f.name}\n        ${f.text}`);
  console.log(`\n❌ ${bad.length} 处写死机器路径：换台机器或换操作系统就跑不了`);
  console.log('   改成从自身位置推导：');
  console.log('     Node: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")');
  console.log('     Py  : os.path.dirname(os.path.dirname(os.path.abspath(__file__)))');
  process.exit(1);
}
if (targets.length < 10) { console.log('❌ 只扫到 ' + targets.length + ' 个文件，检查本身可能失效'); process.exit(1); }
console.log('✅ 没有工具依赖某台机器的绝对路径');
