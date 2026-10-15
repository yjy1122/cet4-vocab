/* sync-www.mjs — 把 www/ 同步进鸿蒙工程的 rawfile/。
 *
 * 为什么是 Node 而不是 PowerShell：鸿蒙工程进了 main 之后，CI（Ubuntu）也要能
 * 跑同步 + 审计；而 rawfile 被 .gitignore 排除，不同步就会打出一个没有任何页面的空壳。
 * 实现只放这一份，sync-www.ps1 退化成一句转发调用（本机习惯的命令照旧可用）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, 'www');
const DEST = path.join(root, 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile');

if (!fs.existsSync(SRC)) { console.error('❌ 找不到 www/，仓库不完整？'); process.exit(1); }

/* 先删后拷：只覆盖会留下"上一次构建的残留文件"，
   那些文件会一路打进 HAP，而审计按集合比对时也会报"多了文件"。 */
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let n = 0;
(function copy(rel) {
  const from = path.join(SRC, rel);
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(from)) copy(path.join(rel, e));
    return;
  }
  const to = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  n++;
})('');

if (!fs.existsSync(path.join(DEST, 'index.html'))) {
  console.error('❌ 同步后 rawfile/index.html 不存在——Index.ets 就是加载它，打出来的会是空壳');
  process.exit(1);
}
console.log(`✅ 同步 www/ → harmony/entry/src/main/resources/rawfile/（${n} 个文件）`);
