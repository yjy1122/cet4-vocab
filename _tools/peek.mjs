/* 抽样查看 Mode 3 生成的短文与实际出题反馈 */
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = "D:\\Users\\DawnFish\\Desktop\\新建文件夹";
const mods = ["www/js/seed-words.js", "www/js/lexicon.js", "www/js/dict-extra.js", "www/js/store.js", "www/js/parse.js", "www/js/distractors.js", "www/js/quiz.js", "www/js/ai.js"];
const code = mods.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");
const mem = new Map();
const sb = {
  console, JSON, Math, Date, RegExp, Set, Map, Array, Object, String, Number, Promise, Error, parseInt, parseFloat, isNaN, Boolean, Symbol,
  TextDecoder, Blob, Response, DecompressionStream, structuredClone, setTimeout, clearTimeout, fetch,
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
};
sb.window = sb; sb.self = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: "bundle.js" });
vm.runInContext(`
  Store.load();
  Store.settings.mode = "sequence";
  const rd = Quiz.readingTask({ useWrong: false });
  console.log("【阅读联动短文 · " + rd.length + " 词】\\n" + rd.passage + "\\n");
  console.log("生词表：" + rd.glossary.map(g => g.word + " " + g.def).join(" ｜ "));
  console.log("\\n【长难句】" + rd.analysis.sentence);
  rd.analysis.chunks.forEach(c => console.log("  - " + c.label + "：" + c.text));

  console.log("\\n【顺序闯关 · 单元步骤】");
  Store.unitFlags().forEach(f => console.log("  " + f.state.padEnd(8) + f.unit + "  掌握 " + f.mastered + "/" + f.total + "  错题 " + f.wrong + "  待测 " + f.new + "  达标还差 " + f.needMore));
  console.log("  当前单元：" + Store.currentUnit());

  console.log("\\n【第一题（当前单元）】");
  const q = Quiz.next().question;
  console.log("  题型：" + q.label + " ｜ " + (q.stem || "").replace(/<[^>]+>/g, ""));
  if (q.options) q.options.forEach(o => console.log("    " + o.key + ". " + o.text + (o.isKey ? "  ← 正确" : "   [" + (o.tags||[]).join("+") + "]")));
  const fb = Quiz.submit(q.options ? q.options.find(o => !o.isKey).key : "zzz");
  const strip = (s) => String(s).replace(/<[^>]+>/g, "");
  console.log("\\n【反馈五段】");
  console.log("  【判定】" + strip(fb.verdict));
  console.log("  【正确答案与考点】" + strip(fb.answer));
  console.log("  【解析与避坑】" + strip(fb.why));
  console.log("  【真题/语境例句】" + strip(fb.example));
  console.log("  【当前进度】" + strip(fb.progress));
`, sb, { filename: "peek.js" });
