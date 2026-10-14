/* 静态审计：语法 / #id 选择器对账 / class 对账（选择器 = 以 # 或 . 开头的字符串字面量） */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = "D:\\Users\\DawnFish\\Desktop\\新建文件夹";
const jsFiles = fs.readdirSync(path.join(root, "www/js")).filter((f) => f.endsWith(".js")).map((f) => "www/js/" + f);
const html = fs.readFileSync(path.join(root, "www/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "www/css/app.css"), "utf8");

/* --- 1. 语法 --- */
let bad = 0;
console.log("=== 1. 语法检查 ===");
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(root, f), "utf8");
  try { new vm.Script(code, { filename: f }); console.log(`  ok   ${f} (${code.split("\n").length} 行)`); }
  catch (e) { bad++; console.log(`  ❌ ${f} → ${e.message}`); }
}

/* --- 2. 收集所有 DOM 选择器字符串字面量 --- */
const SEL_RX = /(?:querySelector(?:All)?|\$)\s*\(\s*([`"'])([^`"'\n]+)\1/g;
const LIT_RX = /(["'`])(#[A-Za-z0-9_\-]+(?:[ .][^`"'<>]*)?)\1/g;
const idRefs = [], clsRefs = new Set(), perFile = {};
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(root, f), "utf8");
  perFile[f] = { ids: [], classes: [] };
  for (const m of code.matchAll(SEL_RX)) {
    const sel = m[2];
    if (sel.includes("${")) continue;
    for (const i of sel.matchAll(/#([A-Za-z0-9_\-]+)/g)) { idRefs.push([f, sel, i[1]]); perFile[f].ids.push(i[1]); }
    for (const c of sel.matchAll(/^\.([a-z][a-z0-9\-_]*)/g)) { clsRefs.add(c[1]); perFile[f].classes.push(c[1]); }
  }
}

/* --- 3. 已知 id：HTML 静态 + JS 模板动态生成 --- */
const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
const allJs = jsFiles.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
for (const m of allJs.matchAll(/\bid="([A-Za-z0-9_\-]+)"/g)) ids.add(m[1]);      // 模板里生成的
for (const m of allJs.matchAll(/\bid=\\?"([A-Za-z0-9_\-]+)\\?"/g)) ids.add(m[1]);
for (const m of allJs.matchAll(/id="?\$\{/g)) { /* 动态 id 忽略 */ }
for (const m of allJs.matchAll(/getElementById\(["']([A-Za-z0-9_\-]+)["']\)/g)) ids.add(m[1]);

/* --- 4. 对账 --- */
console.log(`\n=== 2. JS 引用到的 #id：${idRefs.length} 处 ===`);
const missing = idRefs.filter(([, , id]) => !ids.has(id));
if (!idRefs.length) { console.log("  ❌ 提取到 0 处引用——审计脚本本身失效，结论不可用"); bad++; }
else if (!missing.length) console.log("  ✅ 全部能在 HTML/JS 模板里找到对应元素");
else { const seen = new Set(); missing.forEach(([f, sel, id]) => { const k = f + id; if (seen.has(k)) return; seen.add(k); console.log(`  ❌ ${f}  ${sel} → #${id} 不存在`); }); bad++; }

console.log(`\n=== 3. HTML 里存在但 JS 没接线的 id ===`);
const used = new Set(idRefs.map((r) => r[2]));
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const unused = htmlIds.filter((i) => !used.has(i) && !new RegExp(`id="${i}"`).test(allJs));
console.log(unused.length ? "  ⚠ " + unused.join(", ") + "（多为纯容器/样式钩子）" : "  （无）");

console.log(`\n=== 4. JS 选择器用到的 class 是否有样式 ===`);
const clsMissing = [...clsRefs].filter((c) => !new RegExp("\\." + c + "[\\s,{:.]").test(css) && !html.includes('class="' + c) && !html.includes(c + " "));
console.log(clsRefs.size ? (clsMissing.length ? "  ⚠ " + clsMissing.join(", ") : `  ✅ ${clsRefs.size} 个 class 均有样式定义`) : "  （未提取到 class 选择器）");

console.log(`\n引用明细：${Object.entries(perFile).map(([f, v]) => f.replace("js/", "") + " " + v.ids.length + "id/" + v.classes.length + "class").join("，")}`);
console.log(bad ? `\n结论：${bad} 项需要处理` : "\n结论：接线审计通过");
