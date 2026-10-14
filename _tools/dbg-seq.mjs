/* 调试：R3 顺序模式越界的两个词到底是谁 */
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = "D:\\Users\\DawnFish\\Desktop\\新建文件夹";
const mods = ["www/js/seed-words.js", "www/js/lexicon.js", "www/js/dict-extra.js", "www/js/store.js", "www/js/parse.js", "www/js/distractors.js", "www/js/quiz.js", "www/js/ai.js"];
const code = mods.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");
const mem = new Map();
const sb = { console, JSON, Math, Date, RegExp, Set, Map, Array, Object, String, Number, Promise, Error, Proxy, Reflect, Boolean, Symbol, parseInt, parseFloat, isNaN, TextDecoder, Blob, Response, DecompressionStream, structuredClone, setTimeout, clearTimeout, fetch,
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(code, sb, { filename: "bundle.js" });
vm.runInContext(`
  Store.load();
  Store.settings.mode = "sequence"; Store.settings.passRatio = 0.8; Store.settings.autoAdvance = true;
  Store.settings.unitCleared = {}; Store.settings.usePool = false; Store.settings.reviewShare = 0.0001; Store.settings.daily = 300;
  Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); w.lesson = ""; });
  Quiz.invalidateEligible(); Quiz.reset({ override: null, scope: "all" });
  console.log("currentBlock:", Store.currentBlock(), " blocks:", JSON.stringify(Store.blocks()));
  const u2 = new Set(Store.wordsOf("Unit 2").map(w => w.id));
  const bad = [];
  for (let i = 0; i < 20; i++) {
    const r = Quiz.next(); if (!r.question) { console.log("stop:", JSON.stringify(r).slice(0,80)); break; }
    const w = r.question.word;
    if (!u2.has(w.id)) bad.push({ word: w.word, unit: w.unit, units: w.units, status: w.status, block: Store.blockKey(w) });
    Quiz.submit(r.question.options ? r.question.options.find(o => o.isKey).key : r.question.answer);
  }
  console.log("越界:", JSON.stringify(bad));
`, sb, { filename: "dbg2.js" });
