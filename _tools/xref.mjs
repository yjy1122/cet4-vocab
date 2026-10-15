/* 跨模块引用对账：在 vm 里真实加载模块，读取导出键，再扫描源码里的 NS.method 引用 */
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // 不硬编码机器路径，CI 在 Linux 上跑
const dir = path.join(root, "www", "js");
const mods = ["seed-words.js", "lexicon.js", "dict-extra.js", "store.js", "parse.js", "distractors.js", "quiz.js", "ai.js", "update.js", "ui.js", "app.js"];
const code = mods.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n;\n");
const mem = new Map();
const sb = { console, JSON, Math, Date, RegExp, Set, Map, Array, Object, String, Number, Promise, Error, Proxy, Reflect, Boolean, Symbol, parseInt, parseFloat, isNaN, TextDecoder, Blob, Response, DecompressionStream, structuredClone, setTimeout, clearTimeout, fetch,
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
// 最小 DOM 桩：readyState=loading 让 app.js 只注册 boot 而不执行，UI/app 的导出面照样可查
sb.document = { readyState: "loading", addEventListener: () => { }, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) };
sb.navigator = { clipboard: { writeText: async () => { } } };
sb.location = { protocol: "file:" };
sb.matchMedia = () => ({ matches: false });
sb.window = sb; sb.self = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: "bundle.js" });

const NS = ["UI", "app", "Store", "Quiz", "Lex", "Parse", "Distract", "AI", "Writing", "Update"];
const exportsOf = {};
for (const n of NS) exportsOf[n] = sb[n] ? Object.keys(sb[n]) : null;

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/([^:\\])\/\/[^"\n]*$/gm, "$1");
const refs = [];
for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const m of src.matchAll(/\b(UI|app|Store|Quiz|Lex|Parse|Distract|AI|Writing)\.([A-Za-z_$][\w$]*)/g)) {
    refs.push([f, m[1], m[2]]);
  }
}
// 属性式访问（非调用）也要合法：NS.settings / NS.words 这类 getter 已在 Object.keys 里
const bad = new Map();
for (const [f, ns, key] of refs) {
  const ex = exportsOf[ns];
  if (!ex) { bad.set(ns + "." + key, `${ns} 未定义`); continue; }
  if (ex.indexOf(key) < 0) bad.set(`${ns}.${key}`, (bad.get(`${ns}.${key}`) || "") + f + " ");
}

console.log("真实导出面：");
for (const n of NS) console.log(`  ${n.padEnd(9)} ${(exportsOf[n] || []).length} 个成员`);
console.log(`\n引用点 ${refs.length} 处`);
if (!bad.size) { console.log("✅ 无悬空跨模块调用"); process.exit(0); }
console.log("❌ 以下引用在运行时会是 undefined：");
for (const [k, where] of bad) console.log(`   ${k}   ← ${where.trim()}`);
process.exit(1);
