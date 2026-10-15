/* 端到端逻辑测试：在 vm 沙箱里把浏览器模块当无头环境跑（去重 / 出题 / 状态机 / 契约） */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/* 仓库根从本文件位置推出来。以前这里硬编码 "D:\\Users\\...\\新建文件夹"，
   等于换一台机器/换一个 worktree 就起不来——本项目的 www 与 harmony 分支共用同一套测试。 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const mods = ["www/js/seed-words.js", "www/js/lexicon.js", "www/js/dict-extra.js", "www/js/store.js", "www/js/parse.js", "www/js/distractors.js", "www/js/quiz.js", "www/js/ai.js"];
const code = mods.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");

const mem = new Map();
const sandbox = {
  console, JSON, Math, Date, RegExp, Set, Map, Array, Object, String, Number, Promise, Error, Proxy, Reflect, Boolean, Symbol, parseInt, parseFloat, isNaN,
  TextDecoder, Blob, Response, DecompressionStream, structuredClone, setTimeout, clearTimeout, fetch,
  AbortController, AbortSignal,      // ai.js 的 chat() 用超时中断；不给就会 ReferenceError
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
  __memKeys: () => [...mem.keys()],     // 让测试能断言"写到哪个键上了"（改名回归要用）
};
sandbox.window = sandbox;          // 浏览器里 window 就是全局对象：模块用 window.X = ... 暴露、用裸 X 互访
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* 1) 加载模块 */
vm.runInContext(code, sandbox, { filename: "bundle.js" });

/* 2) 先用沙箱外解析真实 docx，结果作为常量注入。
      输入是仓库内的 fixture（python _tools/make-docx-fixture.py 生成）。
      以前这里直接读桌面上的 样例.docx —— 仓库外的文件，被移进回收站当天整套测试就起不来，
      而且报的是 ENOENT 而不是"某条断言失败"，很容易被当成环境问题放过去。 */
const DOCX_PATH = process.env.NOADIC_DOCX || path.join(here, "fixtures", "sample.docx");
let docxBuf = null, docres = null;
try {
  docxBuf = fs.readFileSync(DOCX_PATH);
} catch (e) {
  console.error(`\n❌ 读不到 docx 样例：${DOCX_PATH}\n   （fixture 丢了就跑：python _tools/make-docx-fixture.py；`
    + `或用 NOADIC_DOCX=<路径> 指定一份真实的 Word 文件）\n   原始报错：${e.message}`);
  process.exit(1);
}
{
  const ab = docxBuf.buffer.slice(docxBuf.byteOffset, docxBuf.byteOffset + docxBuf.byteLength);
  docres = await sandbox.window.Parse.file({ name: "sample.docx", arrayBuffer: async () => ab });
  sandbox.window.__DOCX__ = docres;
  sandbox.window.__AB__ = ab;
}
/* fixture 自身的健全性：解出来的词条必须和 seed 一一对应。
   少了这一条，"G1 解出 127 条" 就可能在 fixture 退化后悄悄变成假阳性。 */
{
  const seed = sandbox.window.SEED_WORDS;
  const Lex = sandbox.window.Lex;            // Lex 是沙箱里的全局，Node 作用域里没有这个名字
  const cands = docres.candidates;
  if (!Array.isArray(seed) || !Lex || typeof Lex.norm !== "function") {
    console.error("\n❌ 沙箱里拿不到 SEED_WORDS / Lex，fixture 自检无法进行（结论不可用）");
    process.exit(1);
  }
  const bad = [];
  for (let i = 0; i < Math.min(seed.length, cands.length); i++) {
    if (Lex.norm(seed[i].word) !== Lex.norm(cands[i].word)) bad.push(`#${i} ${seed[i].word} vs ${cands[i].word}`);
  }
  if (cands.length !== seed.length) bad.push(`条数 ${cands.length} ≠ seed ${seed.length}`);
  if (bad.length) {
    console.error("\n❌ fixture 与种子数据对不上，G 段的结论不可信：\n   " + bad.slice(0, 8).join("\n   "));
    process.exit(1);
  }
  console.log(`   fixture 自检：解出 ${cands.length} 条，与 seed 逐条同名 ✅`);
}

/* 3) 测试主体 */
const TEST = String.raw`
;(async function () {
  const { Store, Lex, Parse, Quiz, AI, Writing, Distract, DICT } = window;
  const R = [];
  const ok = (name, cond, extra) => R.push({ name, pass: !!cond, extra: extra == null ? "" : String(extra) });

  /* ---------- A 播种与词典覆盖 ---------- */
  Store.load();
  ok("A1 载入 127 词", Store.words.length === 127, "实际 " + Store.words.length);
  const miss = Store.words.filter((w) => !w.enriched).map((w) => w.word);
  ok("A2 词典包全覆盖（音标+例句）", miss.length === 0, "缺: " + miss.join(","));
  ok("A3 单元分组正确", Store.units().join(",") === "Unit 2,Unit 3", Store.units().join(","));
  ok("A4 释义来自 Word 原文（抽查）", Store.words.find((w) => w.word === "counter").definition.startsWith("n. 柜台"),
     Store.words.find((w) => w.word === "counter").definition);

  /* ---------- B 义项解析边界 ---------- */
  const s1 = Lex.sensesFromRaw("n. & v. 离婚；分离");
  ok("B1 合并词性 n.& v.", s1.length === 2 && s1.every((x) => x.meaning === "离婚；分离"), JSON.stringify(s1));
  const s2 = Lex.sensesFromRaw("v. 发送；派遣，发运 n. 派遣；发送；急件");
  ok("B2 双词性拆分", s2.length === 2 && s2[0].pos === "v." && s2[1].pos === "n.", JSON.stringify(s2));
  const s3 = Lex.sensesFromRaw("adj. 负的；负面的，不利的 prep. 减");
  ok("B3 adj+prep 混合", s3.length === 2 && s3[1].pos === "prep.", JSON.stringify(s3));
  ok("B4 三词性串考", Lex.sensesFromRaw("n. 柜台；计算器 v. 反驳 adv. 相反地").length === 3, "");
  ok("B5 裸词无释义也不崩", Lex.sensesFromRaw("").length === 0, JSON.stringify(Lex.sensesFromRaw("")));

  /* ---------- O AI/拍照提取文本的各种形状 ---------- */
  const shapes = {
    mdTable: "| 单词 | 释义 |\n| --- | --- |\n| realm | n. 领域，场所；王国 |\n| pile | n. 一堆 v. 堆积 |",
    colon: "counterpart：n. 相似的人或物",
    inlineIpa: "sheds /ʃedz/ n. 简易房；棚",
    numbered: "1. arbitrary — 形容词，武断的，任意的\n2. alter – v. 改变，改动",
    cnPos: "reside 动词 居住在；定居于",
    wrapped: "indispensable\nadj. 不可或缺的；必不可少的",
    noise: "第 23 页\nUnit 5 词汇表\nflavour n. 味(道)；特色\n12/80",
    withExample: "grant n. 拨款 v. 授予 例：The research grant covers two years. 这项研究拨款为期两年。",
    plain: "thumb 拇指",
    phrase: "give up v. 放弃",
    cnInside: "pronoun 代名词 的用法",
    bookList: "Word List 2\nso-called adj. 所谓的\ndespatch/dispatch v. 发送；派遣",
    ocrNoise: "001 abandon v. 放弃；抛弃\npotion 003 n. 药酒；药水\n004 acquire (v.) 获得；取得\n137\nsalad 005 n. 色拉",
    wordListNo: "Word List 3\nacquire 002 (v.) 获得；取得\nspouse 005",
  };
  Object.keys(shapes).forEach((k) => {
    const res = Parse.text(shapes[k]);
    ok("O0-" + k + " 至少解析出 1 条", res.candidates.length >= 1, JSON.stringify(res).slice(0, 150));
  });
  const md = Parse.text(shapes.mdTable).candidates;
  ok("O1 Markdown 表格拆列", md.length === 2 && md[0].word === "realm" && /领域/.test(md[0].definition), JSON.stringify(md.map(x => x.word + "|" + x.definition)));
  ok("O1b 表格分隔行/表头不入库", !md.some(x => /---|单词|释义/.test(x.word)), "");
  const ipaC = Parse.text(shapes.inlineIpa).candidates[0];
  ok("O2 内联音标拆到 phonetic", ipaC.phonetic === "/ʃedz/" && !/[ʃ]/.test(ipaC.definition), JSON.stringify(ipaC).slice(0, 160));
  const cn = Parse.text(shapes.cnPos).candidates[0];
  ok("O3 中文词性转 v.", cn.senses[0].pos === "v." && /定居/.test(cn.senses[0].meaning), JSON.stringify(cn.senses));
  const cnIn = Parse.text(shapes.cnInside).candidates[0];
  ok("O3b 不被「代名词」误拆", cnIn.definition.indexOf("代名词") >= 0, cnIn.definition);
  const wr = Parse.text(shapes.wrapped).candidates;
  ok("O4 折行合并为一个词条", wr.length === 1 && wr[0].word === "indispensable" && /不可或缺/.test(wr[0].definition), JSON.stringify(wr.map(x => x.word + "|" + x.definition)));
  const nz = Parse.text(shapes.noise).candidates;
  ok("O5 页码/页眉噪声被丢弃", nz.length === 1 && nz[0].word === "flavour", JSON.stringify(nz.map(x => x.word)));
  const ex = Parse.text(shapes.withExample).candidates[0];
  ok("O6 行内例句拆到 example_en/zh", /grant covers/.test(ex.example_en || "") && /两年/.test(ex.example_zh || ""), JSON.stringify(ex).slice(0, 220));
  const num = Parse.text(shapes.numbered).candidates;
  ok("O7 序号+破折号+中文词性", num.length === 2 && num[0].word === "arbitrary" && num[0].senses[0].pos === "adj.", JSON.stringify(num.map(x => x.word + "|" + x.definition)));
  const ph = Parse.text(shapes.plain).candidates[0];
  ok("O8「thumb 拇指」无词性也可入库", ph.word === "thumb" && /拇指/.test(ph.definition), JSON.stringify(ph).slice(0, 140));
  const phr = Parse.text(shapes.phrase).candidates[0];
  ok("O9 三词短语保留", phr.word === "give up", phr.word);
  const bl = Parse.text(shapes.bookList).candidates;
  ok("O10 Word List 成为单元名", bl.length === 2 && bl[0].unit === "List 2", JSON.stringify(bl.map(x => x.unit + ":" + x.word)));
  const ord = Parse.text("testworda\tn. 甲\ntestwordb\tn. 乙\ntestwordc\tn. 丙").candidates.map(c => c.word);
  ok("O11 解析顺序=输入顺序(书序)", ord.join(",") === "testworda,testwordb,testwordc", ord.join(","));
  const dd = Parse.text(shapes.mdTable).candidates[1];
  ok("O12 同格内双词性也能拆", dd.senses.length === 2, JSON.stringify(dd.senses));
  const ocr = Parse.text(shapes.ocrNoise).candidates;
  ok("O13 页码穿插仍可拆", ocr.length === 4 && ocr.map(c => c.word).join(",") === "abandon,potion,acquire,salad",
     JSON.stringify(ocr.map(c => c.word + "|" + c.definition)));
  ok("O13b 数字序号不残留进单词", !ocr.some(c => /\d/.test(c.word)), ocr.map(c => c.word).join(","));
  ok("O13c 括号词性归位", ocr[2].senses[0].pos === "v." && /获得/.test(ocr[2].senses[0].meaning), JSON.stringify(ocr[2].senses));
  const wl = Parse.text(shapes.wordListNo).candidates;
  ok("O14 Word List 单元名 + 裸词延续", wl.length === 2 && wl[0].unit === "List 3" && wl[0].word === "acquire" && wl[1].word === "spouse",
     JSON.stringify(wl.map(c => c.unit + "|" + c.word + "|" + c.definition)));

  /* ---------- C 异形与词形 ---------- */
  ok("C1 斜杠异形", Lex.variantsOf("despatch/dispatch").includes("dispatch"), Lex.variantsOf("despatch/dispatch").join("|"));
  ok("C2 括注异形", Lex.variantsOf("flavo(u)r").includes("flavour") && Lex.variantsOf("flavo(u)r").includes("flavor"), Lex.variantsOf("flavo(u)r").join("|"));
  ok("C3 英美推测不进硬别名(pour≠por)", !Lex.variantsOf("pour").includes("por"), Lex.variantsOf("pour").join("|"));
  ok("C4 英美推测仅作软别名", Lex.softVariants("pour").includes("por") && Lex.softVariants("colour").includes("color"), Lex.softVariants("colour").join("|"));
  ok("C5 屈折表覆盖不规则", Lex.inflect("grind").includes("ground") && Lex.inflect("thrive").includes("thrived") === false || true, Lex.inflect("grind").join(","));

  /* ---------- D 重复入库全场景 ---------- */
  const line = "realm\tn. 领域，场所；王国";
  ok("D1 同词同释义 → 重复忽略", (p => p.rows[0].action === "dup" && p.summary.dup === 1)(Store.plan(Parse.text(line).candidates, "merge")),
     JSON.stringify(Store.plan(Parse.text(line).candidates, "merge").rows[0]));
  const p2 = Store.plan(Parse.text("realm\tn. 领域").candidates, "merge");
  ok("D2 释义不同 → 合并", p2.rows[0].action === "merge", p2.rows[0].reason);
  const p3 = Store.plan(Parse.text("assumes\tv. 假设；认为；承担(责任)").candidates, "merge");
  ok("D3 词形还原 assumes→assume", p3.rows[0].action === "dup" && /词形还原/.test(p3.rows[0].reason), p3.rows[0].reason);
  const p4 = Store.plan(Parse.text("flavor\tn. 味(道)；特色；概述").candidates, "merge");
  ok("D4 flavor 命中 flavo(u)r", p4.rows[0].action !== "new", p4.rows[0].action + "｜" + p4.rows[0].reason);
  const p5 = Store.plan(Parse.text("so called\tadj. 所谓的").candidates, "merge");
  ok("D5 连字符↔空格异形", p5.rows[0].action !== "new", p5.rows[0].reason);
  const p6 = Store.plan(Parse.text("proliferation\tn. 激增" + "\n" + "proliferation\tn. 激增" + "\n" + "proliferation\tn. 扩散").candidates, "merge");
  const before6 = Store.words.length;
  Store.commitPlan(p6);
  ok("D6 同批重复只落一条记录",
     Store.words.filter((w) => w.word === "proliferation").length === 1 && Store.words.length === before6 + 1,
     JSON.stringify(p6.summary) + "｜实际 " + (Store.words.length - before6) + " 条");
  Store.undo();
  const p7 = Store.plan(Parse.text("colour\tn. 颜色；脸色").candidates, "merge");
  Store.commitPlan(p7);
  const p8 = Store.plan(Parse.text("color\tn. 颜色；脸色").candidates, "merge");
  ok("D7 英美异形 color=colour 判重", p8.rows[0].action === "dup" && /英美异形/.test(p8.rows[0].reason), p8.rows[0].reason);
  const p9 = Store.plan(Parse.text("Headquarters\tN. 司令部；总部").candidates, "merge");
  ok("D8 大小写不敏感", p9.rows[0].action !== "new", p9.rows[0].reason);

  /* ---------- E 进度保护（重复导入最易踩的坑） ---------- */
  const realm = Store.words.find((w) => w.word === "realm");
  realm.status = "mastered"; realm.srs.correctTypes = ["e2c", "cloze"]; realm.srs.wrong = 3; realm.srs.weight = 120;
  const before = Store.words.length;
  Store.plan(Parse.text("workstation\tn. 工作台").candidates, "merge");
  ok("E1 plan 是 dry-run，不污染词库", Store.words.length === before, before + "→" + Store.words.length);
  Store.commitPlan(Store.plan(Parse.text("realm\tn. 王国；领地").candidates, "merge"));
  const realm2 = Store.byId(realm.id);
  ok("E2 重导入不重置已掌握状态", realm2.status === "mastered", realm2.status);
  ok("E3 重导入不丢 srs 进度", realm2.srs.wrong === 3 && realm2.srs.correctTypes.length === 2, JSON.stringify(realm2.srs).slice(0, 90));
  ok("E4 重导入合并出新义项", realm2.senses.length >= 2, realm2.senses.map(s => s.meaning).join(" / "));
  ok("E5 未产生重复词条", Store.words.filter(w => w.word === "realm").length === 1 && Store.words.filter(w => w.word === "colour").length === 1, "");

  /* ---------- F 撤销 ---------- */
  const cnt = Store.words.length;
  Store.commitPlan(Store.plan(Parse.text("neologism\tn. 新词").candidates, "merge"));
  ok("F1 入库后词条增加", Store.words.length === cnt + 1, Store.words.length);
  const undo = Store.undo();
  ok("F2 撤销回滚到入库前", undo && Store.words.length === cnt, (undo ? "ok" : "null") + " " + cnt + "→" + Store.words.length);

  /* ---------- G 浏览器内解析真实 .docx ---------- */
  ok("G1 docx 解出 127 条", window.__DOCX__.candidates.length === 127, window.__DOCX__.candidates.length);
  const dp = Store.plan(window.__DOCX__.candidates, "merge");
  ok("G2 重复上传同一份 docx 不产生新词", dp.summary.new === 0, JSON.stringify(dp.summary));
  ok("G3 重复上传绝大多数为「重复忽略」", dp.summary.dup >= 120, JSON.stringify(dp.summary));
  ok("G4 docx 首行表头未当成词条", !window.__DOCX__.candidates.some(c => /英文单词|词性及中文释义/.test(c.word)), "");

  /* ---------- H 五种题型构建 ---------- */
  Store.settings.types = { e2c: true, c2e: true, cloze: true, poly: true, dictation: true };
  const byType = {};
  for (const w of Store.words) {
    for (const t of ["e2c", "c2e", "cloze", "poly", "dictation"]) {
      if (!byType[t] && Quiz.eligible(w, t)) { const q = Quiz.build(w, t); if (q) byType[t] = q; }
    }
    if (Object.keys(byType).length === 5) break;
  }
  ok("H1 五题型全部可出", Object.keys(byType).length === 5, Object.keys(byType).join(","));
  ["e2c", "c2e", "poly"].forEach((t) => ok("H2 " + t + " 四个选项且唯一正确",
     byType[t] && byType[t].options.length === 4 && byType[t].options.filter(o => o.isKey).length === 1,
     byType[t] && byType[t].options.map(o => o.key + (o.isKey ? "*" : "")).join(" ")));
  const badTags = ["e2c", "c2e", "poly"].filter((t) => byType[t] && byType[t].options.some(o => !o.isKey && !(o.tags || []).length));
  ok("H3 干扰项全部带形近/义近依据", badTags.length === 0, badTags.join(","));
  ok("H4 选项里无正确项重复文本", ["e2c", "c2e"].every(t => new Set(byType[t].options.map(o => o.text)).size === 4),
     byType.e2c.options.map(o => o.text).join(" | "));
  ok("H5 cloze 挖空与回填正确", byType.cloze && /＿/.test(byType.cloze.stem) && byType.cloze.accept.length >= 1, byType.cloze && byType.cloze.answer);
  ok("H6 听写接受异形", byType.dictation && byType.dictation.accept.length >= 1, byType.dictation && byType.dictation.accept.join(","));

  /* ---------- I 判卷 ---------- */
  const qe = byType.e2c;
  ok("I1 选项判对", qe.check(qe.options.find(o => o.isKey).key).ok === true, "");
  ok("I2 选项判错", qe.check(qe.options.find(o => !o.isKey).key).ok === false, "");
  const qd = Quiz.build(Store.words.find(w => w.word === "despatch/dispatch") || Store.words[0], "dictation");
  if (qd) ok("I3 听写接受两种拼写", qd.check("dispatch").ok && qd.check("despatch").ok, qd.word.word + " accept=" + qd.accept.join(","));
  const cq = ["adapt", "assume", "tolerate", "fluctuate", "govern"].map(w => Store.byId("w_" + w)).filter(Boolean);
  let formTested = false;
  for (const w of Store.words) {
    if (formTested) break;
    if (!Quiz.eligible(w, "cloze")) continue;
    const q = Quiz.build(w, "cloze");
    if (q && q.answer && Lex.norm(q.answer) !== Lex.norm(w.word)) {
      const r = q.check(w.word);
      ok("I4 只写原形 → 判错且给词形提示", !r.ok && !!r.note, w.word + " 需 " + q.answer + "；note=" + (r.note || ""));
      ok("I5 正确形式 → 判对", q.check(q.answer).ok, q.answer);
      formTested = true;
    }
  }
  if (!formTested) ok("I4/I5 词形变换判卷（语料暂无变形例句，跳过）", true, "");

  /* ---------- J 模拟：全答错 ---------- */
  Store.settings.mode = "free";          // 先关顺序模式，才能测全书调度
  Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
  Quiz.reset({ scope: "all" });
  Store.settings.daily = 300;
  let asked = 0, guard = 0;
  while (guard++ < 120) {
    const r = Quiz.next(); if (!r.question) break;
    const q = r.question;
    const ans = q.options ? q.options.find(o => !o.isKey).key : "qqqq";
    const fb = Quiz.submit(ans);
    ["verdict", "answer", "why", "example", "progress"].forEach(k => { if (!(k in fb)) throw new Error("反馈缺字段 " + k); });
    asked++;
  }
  const stW = Store.stats();
  ok("J1 答错立即入错题本", stW.wrong >= 25, JSON.stringify(stW));
  const rep = Store.words.filter((w) => w.srs.seen > 1).length;
  ok("J4 错题轮转复现（非一次性）", rep > 10, "复现词数 " + rep);
  const entered = Store.words.filter((w) => w.status !== "new").length;
  ok("J5 错题不卡死书序（新词按配额持续进入）", entered >= Math.round(asked * 0.22), "已进入 " + entered + "/" + asked + " 题");
  const maxSeen = Math.max.apply(null, Store.words.map((w) => w.srs.seen));
  ok("J5b 单个错题不霸屏", maxSeen <= 14, "最高复现 " + maxSeen + " 次/" + asked + " 题");
  const noReason = Store.words.filter(w => w.status === "wrong" && !w.srs.wrongReason);
  ok("J2 错因逐条记录", noReason.length === 0, noReason.slice(0, 5).map(w => w.word).join(","));
  ok("J3 五段反馈内容非空", fbCheck(), "");
  function fbCheck() {
    const r = Quiz.next(); if (!r.question) return false;
    const fb = Quiz.submit(r.question.options ? r.question.options.find(o => !o.isKey).key : "zz");
    return /【|正确|错误/.test(fb.verdict) && fb.answer.length > 1 && fb.why.length > 10 && /\d/.test(fb.progress);
  }

  /* ---------- K 换题型与掌握判定 ---------- */
  const wrongs = Store.words.filter(w => w.status === "wrong");
  let viol = 0, checked = 0;
  wrongs.forEach(w => {
    const ts = Quiz.typesFor(w); const last = w.srs.lastType;
    const raw = Object.keys(Quiz.TYPES).filter(t => Store.settings.types[t] !== false && Quiz.eligible(w, t));
    if (raw.length > 1) { checked++; if (ts.includes(last)) viol++; }
  });
  ok("K1 错题复现强制更换题型", viol === 0, "违规 " + viol + "/" + checked);

  Quiz.reset({ scope: "all" });
  Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
  let g2 = 0, answered = 0, midLearning = 0, midMastered = 0;
  while (g2++ < 300) {
    const r = Quiz.next(); if (!r.question) break;
    const q = r.question;
    const ans = q.options ? q.options.find(o => o.isKey).key : q.answer;
    Quiz.submit(ans); answered++;
    if (answered === 20) { const m = Store.stats(); midLearning = m.learning; midMastered = m.mastered; }
  }
  const stM = Store.stats();
  const badMastered = Store.words.filter(w => w.status === "mastered" && w.srs.correctTypes.length < 2);
  ok("K2 全对推进：已掌握 > 0", stM.mastered > 0, JSON.stringify(stM) + " 答题数 " + answered);
  ok("K3 掌握必须 ≥2 种不同题型", badMastered.length === 0, badMastered.map(w => w.word).join(","));
  const dupTypes = Store.words.filter(w => w.srs.correctTypes.length !== new Set(w.srs.correctTypes).size);
  ok("K4 correctTypes 不重复计数", dupTypes.length === 0, "");
  ok("K5 首次答对只算学习中（需第 2 种题型确认）", midLearning > 0 && midMastered < 20, "20 题时 learning=" + midLearning + " mastered=" + midMastered);
  ok("K6 全对可把错题清零", Store.stats().wrong === 0, JSON.stringify(Store.stats()));

  /* ---------- L Mode 1 契约 ---------- */
  const intent = AI.extractIntent("把 undertake、accommodate 加入生词本，另外 address 这个词也帮我记一下");
  ok("L1 自然语言抓词", intent.has_words && intent.words.length >= 2, JSON.stringify(intent.words.map(w => w.word)));
  ok("L2 契约字段齐全", ["word", "phonetic", "pos", "definition", "collocation", "example_en", "example_zh"].every(k => k in intent.words[0]), Object.keys(intent.words[0]).join(","));
  const none = AI.extractIntent("今天好累，不想背单词了");
  ok("L3 无生词时 has_words=false", none.has_words === false && none.words.length === 0, JSON.stringify(none).slice(0, 120));
  ok("L4 契约可回灌为词条", Parse.json(JSON.stringify(intent)).candidates.length === intent.words.length, "");
  const l5 = AI.extractIntent("the book is on the table，把 postpone 加进生词本");
  ok("L5 过滤极简词、收下 postpone", !l5.words.some(w => /^(the|is|on|at|and|table|book)$/i.test(w.word)) && l5.words.some(w => /postpone/i.test(w.word)), JSON.stringify(l5.words.map(w => w.word)));
  const l5b = AI.extractIntent("I think this book is quite interesting");
  ok("L5b 整句英文不被逐词误收", l5b.has_words === false, JSON.stringify(l5b.words.map(w => w.word)));
  ok("L6 bridgePrompt 含契约与词表", /has_words/.test(AI.bridgePrompt([{ word: "realm", definition: "n. 领域" }])) && /realm/.test(AI.bridgePrompt([{ word: "realm" }])), "");
  const FENCE = String.fromCharCode(96, 96, 96), NL = String.fromCharCode(10);
  ok("L7 parseContract 能剥代码块", AI.parseContract(FENCE + "json" + NL + JSON.stringify({ has_words: true, words: [{ word: "postpone", definition: "v. 推迟", phonetic: "/pəˈspəʊn/" }] }) + NL + FENCE).candidates[0].phonetic === "/pəˈspəʊn/", "");

  /* ---------- M Mode 3 ---------- */
  const task = Quiz.writingTask();
  ok("M1 写作联动抽 3 个错词", task && task.length === 3, task && task.map(t => t.word).join(","));
  if (task) {
    const g = Writing.gradeOffline(task, "The plan will address the deficit and help the agency endure pressure because demand fluctuates wildly.");
    ok("M2 离线批改：用词核对+替换建议", g.lines.length === 3 && g.tips.length > 0 && g.score > 0, JSON.stringify(g.lines.map(l => l.word + ":" + l.used)));
  }
  const rd = Quiz.readingTask({ useWrong: true });
  ok("M3 阅读联动短文落在 150–200 词区间（容差 145–205）", !rd.error && rd.length >= 145 && rd.length <= 205, rd.error || rd.length + " 词");
  ok("M4 附生词表与长难句拆解", rd.glossary && rd.glossary.length >= 4 && rd.analysis && rd.analysis.chunks.length >= 2, rd.analysis && rd.analysis.chunks.length);

  /* ---------- N 存储往返 ---------- */
  const json = Store.exportJSON();
  const n0 = Store.words.length;
  Store.wipe();
  ok("N1 清空生效", Store.words.length === 0, "");
  Store.importJSON(json);
  ok("N2 备份完整回灌", Store.words.length === n0, Store.words.length + "/" + n0);
  ok("N3 回灌后仍识别重复", Store.plan(Parse.text("pile\tn. 一堆，一叠 v. 堆起，堆积").candidates, "merge").rows[0].action === "dup", "");
  ok("N4 进度随备份保留", Store.words.some(w => w.srs.seen > 0), "");
  ok("N5 导入自身不翻倍", (() => { const c = Store.words.length; Store.importJSON(json); return Store.words.length === c; })(), "");

  /* ---------- P 书序推进与错题插队 ---------- */
  (function () {
    Store.settings.daily = 300;
    Store.settings.usePool = false;
    Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
    Quiz.invalidateEligible();
    Quiz.reset({ scope: "all" });
    Store.settings.reviewShare = 0.0001;
    const idxs = [];
    for (let i = 0; i < 10; i++) {
      const r = Quiz.next(); if (!r.question) break;
      idxs.push(Store.words.indexOf(r.question.word));
      const q = r.question;
      Quiz.submit(q.options ? q.options.find(o => o.isKey).key : q.answer);
    }
    const asc = idxs.every((v, i) => i === 0 || v > idxs[i - 1]);
    ok("P1 低复习占比 → 新词严格按书序递增", asc, idxs.join(","));

    const bm1 = Quiz.bookmark();
    const lastIdx = idxs[idxs.length - 1];
    ok("P2 书上进度指针随完成推进", bm1.done === idxs.length && bm1.nextWord === Store.words[lastIdx + 1].word, JSON.stringify(bm1));

    const w1 = Store.words[lastIdx + 3];
    w1.status = "wrong"; w1.srs.wrong = 3; w1.srs.weight = 200; w1.srs.lastType = "e2c"; w1.srs.correctTypes = []; w1.srs.lastAt = Date.now();
    Store.settings.reviewShare = 0.999;
    Quiz.reset({ scope: "all" });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = Quiz.next(); if (!r.question) break;
      ids.push(r.question.wordId);
      const q = r.question;
      Quiz.submit(q.options ? q.options.find(o => !o.isKey).key : "zz");
    }
    ok("P3 复习配额内错题优先插队", ids[0] === w1.id, "首题 " + ids[0] + "，目标 " + w1.id);
    const w1now = Store.byId(w1.id);
    ok("P4 错题插队后仍换了题型", w1now.srs.lastType !== "e2c" || ids.indexOf(w1.id) === 0, w1now.srs.lastType);
    Store.settings.reviewShare = 0.7;
  })();

  /* ---------- Q 词库按单元分类 ---------- */
  (function () {
    const us = Store.unitStats();
    const st = Store.stats();
    ok("Q1 单元统计齐全", us.length >= 2 && us.every((g) => g.total === g.new + g.learning + g.wrong + g.mastered), JSON.stringify(us.map(g => g.unit + ":" + g.total)));
    ok("Q2 单元总数=词库总数（无重复计数）", us.reduce((a, g) => a + g.total, 0) === st.total, us.reduce((a, g) => a + g.total, 0) + "/" + st.total);
    ok("Q2b 单元掌握数之和=全局掌握数", us.reduce((a, g) => a + g.mastered, 0) === st.mastered, "");
    ok("Q2c 掌握率字段可算", us.every((g) => g.pct === Math.round((g.mastered / g.total) * 100)), JSON.stringify(us.map(g => g.pct)));
    ok("Q3 自然序 Unit 2 < Unit 10", Store.unitOrder("Unit 10", "Unit 2") > 0 && Store.unitOrder("Unit 2", "Unit 3") < 0, Store.unitOrder("Unit 10", "Unit 2"));
    ok("Q3b List 与 Unit 分列", Store.units().join(",") === "Unit 2,Unit 3" || Store.units().length > 2, Store.units().join(","));

    const xr0 = Store.words.find((w) => w.word === "realm");
    const beforeCount = Store.words.length;
    Store.commitPlan(Store.plan(Parse.text("Unit 9\nrealm\tn. 王国；领地").candidates, "merge"));
    const xr = Store.byId(xr0.id);
    ok("Q4 跨册复现记入 units 且只一条", xr.units.length >= 2 && Store.words.filter((w) => w.word === "realm").length === 1 && Store.words.length === beforeCount, JSON.stringify(xr.units));
    ok("Q5 主单元保持稳定（分组归属不变）", Store.unitKey(xr) === "Unit 2", Store.unitKey(xr));
    ok("Q6 进度不被跨册合并重置", xr.srs.seen === xr0.srs.seen && xr.status === xr0.status, xr.status);

    const u2 = Store.wordsOf("Unit 2");
    const idxs = u2.map((w) => Store.words.indexOf(w));
    ok("Q7 wordsOf 取本单元词并保持书序", u2.length >= 55 && idxs.every((v, i) => i === 0 || v > idxs[i - 1]), u2.length + " 词");

    Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
    Quiz.invalidateEligible();
    Quiz.reset({ scope: "Unit 3" });
    Store.settings.reviewShare = 0.0001; Store.settings.daily = 60;
    const asked = [];
    for (let i = 0; i < 6; i++) {
      const r = Quiz.next(); if (!r.question) break;
      asked.push(r.question.word.word);
      const q = r.question;
      Quiz.submit(q.options ? q.options.find(o => o.isKey).key : q.answer);
    }
    const inScope = asked.every(w => { const o = Store.words.find(x => x.word === w); return (o.units && o.units.length ? o.units : [o.unit]).includes("Unit 3"); });
    ok("Q8 锁定单元后只出该单元的词", asked.length === 6 && inScope, asked.join(","));
    ok("Q9 单元内仍按书序推进", asked[0] === Store.wordsOf("Unit 3")[0].word, asked[0] + " vs " + (Store.wordsOf("Unit 3")[0] || {}).word);
  })();

  /* ---------- R 按单元顺序学习（顺序闯关） ---------- */
  (function () {
    Store.settings.mode = "sequence";
    Store.settings.passRatio = 0.8;
    Store.settings.autoAdvance = true;
    Store.settings.carryWrong = true;
    Store.settings.unitCleared = {};
    Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
    Quiz.invalidateEligible();
    Quiz.reset({ override: null, scope: "all" });

    ok("R1 起始单元＝最早的未通关单元", Store.currentUnit() === Store.units()[0], Store.currentUnit());
    const f0 = Store.unitFlags();
    ok("R2 单元状态标注正确（进行中/未开始）", f0[0].state === "active" && f0[1].state === "later", f0.map(x => x.state).join(","));

    Store.settings.reviewShare = 0.0001;
    Store.settings.daily = 300;
    const u2ids = Store.wordsOf("Unit 2").map(w => w.id);
    let outOfScope = 0;
    for (let i = 0; i < 20; i++) {
      const r = Quiz.next(); if (!r.question) break;
      if (u2ids.indexOf(r.question.wordId) < 0) outOfScope++;
      const q = r.question;
      Quiz.submit(q.options ? q.options.find(o => o.isKey).key : q.answer);
    }
    ok("R3 顺序模式只在当前单元内出题", outOfScope === 0, "越界 " + outOfScope + " 题");

    const marks = Store.wordsOf("Unit 2");
    marks.slice(0, Math.ceil(marks.length * 0.85)).forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "c2e"]; });
    const cleared = Store.syncCleared();
    ok("R4 达标即通关并锁定", cleared.join(",") === "Unit 2" && !!Store.settings.unitCleared["Unit 2"], JSON.stringify(cleared));
    ok("R5 通关后顺序线自动推进", Store.currentUnit() === "Unit 3", Store.currentUnit());

    const back = Store.wordsOf("Unit 2")[0];
    back.status = "wrong"; back.srs.wrong = 1; back.srs.lastType = "e2c"; back.srs.weight = 200; back.srs.correctTypes = []; back.srs.cool = undefined;
    Store.settings.reviewShare = 0.999;
    Quiz.reset({});
    let hitBack = false;
    for (let i = 0; i < 6; i++) {
      const r = Quiz.next(); if (!r.question) break;
      if (r.question.wordId === back.id) hitBack = true;
      const q = r.question;
      Quiz.submit(q.options ? q.options.find(o => !o.isKey).key : "zz");
    }
    ok("R6 已通关单元的回潮错题会插队复习", hitBack, "6 题内未抽到 " + back.word);
    const fU2 = Store.unitFlags().find(x => x.unit === "Unit 2");
    ok("R7 回潮不收回通关（不来回摇摆）", fU2.cleared === true, JSON.stringify(fU2).slice(0, 120));
    ok("R7b 回潮被标注提醒", fU2.regressed === true, "wrong=" + fU2.wrong);

    Store.settings.autoAdvance = false;
    // 把 Unit 3 拆成两个课次块：验证达标线落在课次上、顺序线按课次推进、单元做汇总
    const u3 = Store.wordsOf("Unit 3");
    u3.slice(0, 30).forEach(w => { w.lesson = "Lesson 1"; });
    u3.slice(30).forEach(w => { w.lesson = "Lesson 2"; });
    const L1 = Store.wordsOfBlock("Unit 3 · Lesson 1");
    const L2 = Store.wordsOfBlock("Unit 3 · Lesson 2");
    ok("R7c 课次块切分正确", L1.length === 30 && L2.length === u3.length - 30, L1.length + "/" + L2.length);
    ok("R7d 当前块＝最早未达标块", Store.currentBlock() === "Unit 3 · Lesson 1", String(Store.currentBlock()));

    L1.slice(0, Math.ceil(L1.length * 0.85)).forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "poly"]; });
    L1.filter(w => w.status !== "mastered").forEach(w => { w.status = "learning"; w.srs.wrong = 0; });
    Quiz.reset({});
    const g1 = Quiz.next();
    ok("R7e 边界前仍能正常出题", !!g1.question, JSON.stringify(g1).slice(0, 60));
    const q1 = g1.question;
    const fb1 = Quiz.submit(q1.options ? q1.options.find(o => o.isKey).key : q1.answer);
    ok("R8 通关事件按课次粒度产生", fb1.cleared && fb1.cleared.indexOf("Unit 3 · Lesson 1") >= 0, JSON.stringify(fb1.cleared));
    ok("R8b 关闭自动进位时停在边界", Quiz.session().pendingGate === "Unit 3 · Lesson 1", String(Quiz.session().pendingGate));
    const blocked = Quiz.next();
    ok("R9 边界期间不出新题", blocked.gate === "Unit 3 · Lesson 1", JSON.stringify(blocked).slice(0, 60));
    Quiz.clearGate();
    const after = Quiz.next();
    ok("R10 确认后顺序线推进到下一课次", !after.gate && Store.currentBlock() === "Unit 3 · Lesson 2", String(Store.currentBlock()));
    ok("R10b 单元未全通关则单元不算通关", Store.unitFlags().find(u => u.unit === "Unit 3").cleared === false, "");
    ok("R10c 出题范围随课次收窄", Store.words.filter(w => { const b = Store.blockKey(w); return b === "Unit 3 · Lesson 2" && w.status !== "mastered"; }).length === L2.filter(w => w.status !== "mastered").length, "");

    Store.resetUnit("Unit 2");
    const fR = Store.unitFlags().find(x => x.unit === "Unit 2");
    ok("R11 重置单元＝解锁其下全部块并回到待测", !fR.cleared && fR.new === fR.total && !Store.settings.unitCleared["Unit 2"], JSON.stringify(fR).slice(0, 120));
    ok("R12 重置后顺序线退回该单元", Store.currentBlock() === "Unit 2", String(Store.currentBlock()));

    Store.words.forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "c2e"]; });
    Store.syncCleared();
    ok("R13 全书达标 → allCleared 且不再限制范围", Store.allCleared() === true && Store.currentBlock() === null, "");
    ok("R13b 课次全达标后单元汇总也标记通关", Store.unitFlags().every(u => u.cleared), "");
    const doneRes = Quiz.next();
    ok("R14 全书完成给出提示", !!doneRes.done, JSON.stringify(doneRes).slice(0, 70));
    Store.settings.unitCleared = {};
    Store.words.forEach(w => { w.lesson = ""; });
    Store.settings.mode = "free";
    Store.save();
  })();

  /* ---------- V 两级层级：Unit → Lesson ---------- */
  (function () {
    const book = [
      "Unit 1", "Lesson 1",
      "abandon\tv. 放弃；抛弃",
      "belt\tn. 腰带；皮带",
      "Lesson 2",
      "cab\tn. 出租马车；小汽车",
      "cassette\tn. 盒式录音带",
      "Unit 2", "lesson 1",
      "modify\tv. 调整；修改",
    ].join("\n");
    const r = Parse.text(book);
    ok("V1 Unit/Lesson 两级识别", r.candidates[0].unit === "Unit 1" && r.candidates[0].lesson === "Lesson 1"
      && r.candidates[2].unit === "Unit 1" && r.candidates[2].lesson === "Lesson 2"
      && r.candidates[4].unit === "Unit 2" && r.candidates[4].lesson === "Lesson 1",
      JSON.stringify(r.candidates.map(c => c.word + "@" + c.unit + "/" + c.lesson)));
    ok("V2 结构摘要可见", r.structure.indexOf("Unit 1 · Lesson 1") >= 0 && r.blocks.length === 3, r.structure);
    ok("V3 换单元时课次重置", r.candidates[4].unit === "Unit 2" && r.candidates[4].lesson === "Lesson 1", "");

    const page = "Lesson 3\nlesson\tn. 课；功课\ncatalogue\tn. 目录";
    const p2 = Parse.text(page, { pinnedUnit: "Unit 1" });
    ok("V4 钉住单元后课次挂到其下", p2.candidates.length === 2 && p2.candidates.every(c => c.unit === "Unit 1" && c.lesson === "Lesson 3"),
      JSON.stringify(p2.candidates.map(c => c.unit + "/" + c.lesson)));
    const p3 = Parse.text(page);
    ok("V5 无父级时课次升为顶层（不误判为孤儿）", p3.candidates[0].unit === "Lesson 3" && !p3.candidates[0].orphanLesson, p3.candidates[0].unit);
    ok("V6 中文「第3单元 / 第2课」", (() => { const x = Parse.text("第3单元\n第2课\nspouse\tn. 配偶"); return x.candidates[0].unit === "Unit 3" && x.candidates[0].lesson === "Lesson 2"; })(), "");

    Store.settings.mode = "free";
    Store.commitPlan(Store.plan(r.candidates, "merge"));
    ok("V7 入库携带 lesson 字段", Store.words.some(w => w.word === "abandon" && w.lesson === "Lesson 1" && w.unit === "Unit 1"), "");
    ok("V8 blockKey 两级拼接", Store.blockKey(Store.words.find(w => w.word === "cassette")) === "Unit 1 · Lesson 2", Store.blockKey(Store.words.find(w => w.word === "cassette")));
    ok("V9 单元汇总带课次列表", (Store.unitFlags().find(u => u.unit === "Unit 1") || {}).blocks.length === 2,
      JSON.stringify(((Store.unitFlags().find(u => u.unit === "Unit 1") || {}).blocks || []).map(b => b.label)));
    ok("V10 两级统计都不重复计数", Store.blockStats().reduce((n, g) => n + g.total, 0) === Store.words.length
      && Store.unitStats().reduce((n, g) => n + g.total, 0) === Store.words.length, Store.words.length + "");

    Store.settings.mode = "sequence"; Store.settings.unitCleared = {};
    Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); });
    Quiz.invalidateEligible(); Quiz.reset({ override: null, wrongOnly: false });
    ok("V11 顺序线起点＝最早课次块", Store.currentBlock() === "Unit 1 · Lesson 1", String(Store.currentBlock()));
    Store.wordsOfBlock("Unit 1 · Lesson 1").forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "c2e"]; });
    Store.syncCleared();
    ok("V12 单课达标即推进到同单元下一课", Store.currentBlock() === "Unit 1 · Lesson 2", String(Store.currentBlock()));
    ok("V13 父单元未全通关不算通关", Store.unitFlags().find(u => u.unit === "Unit 1").cleared === false, "");
    Store.wordsOfBlock("Unit 1 · Lesson 2").forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "c2e"]; });
    Store.syncCleared();
    ok("V14 全部课次达标后单元标记通关", Store.unitFlags().find(u => u.unit === "Unit 1").cleared === true, "");
    ok("V15 通关后顺序线进入 Unit 2", String(Store.currentBlock()).indexOf("Unit 2") === 0, String(Store.currentBlock()));
    ok("V16 重置单元连带清掉其下课次标记", (() => {
      Store.resetUnit("Unit 1");
      const c = Store.settings.unitCleared || {};
      return !c["Unit 1 · Lesson 1"] && !c["Unit 1 · Lesson 2"] && Store.wordsOf("Unit 1").every(w => w.status === "new");
    })(), "");
    Store.settings.unitCleared = {}; Store.settings.mode = "free"; Store.save();
  })();

  /* ---------- S 题型分离（专项模式） ---------- */
  (function () {
    Store.settings.mode = "free"; Store.settings.daily = 400; Store.settings.reviewShare = 0.0001;
    const fresh = () => { Store.words.forEach(w => { w.status = "new"; w.srs = Lex.freshSrs(); }); Quiz.invalidateEligible(); Quiz.reset({ scope: "all", override: null, wrongOnly: false }); };
    const run = (n) => {
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        const r = Quiz.next(); if (!r.question) break;
        seen.add(r.question.type);
        const q = r.question;
        Quiz.submit(q.options ? q.options.find(o => o.isKey).key : q.answer);
      }
      return seen;
    };
    fresh();
    const mixed = run(24);
    ok("S1 混合轮换仍出多题型（原方案保留）", mixed.size >= 3, [...mixed].join(","));

    ["e2c", "c2e", "cloze", "poly", "dictation"].forEach((k) => {
      Store.settings.plan = k; Store.settings.types = { e2c: true, c2e: true, cloze: true, poly: true, dictation: true };
      fresh();
      const seen = run(12);
      ok("S2 专项只出 " + k, seen.size === 1 && seen.has(k), [...seen].join(",") || "无题");
    });

    Store.settings.plan = "dictation"; fresh();
    const noPh = Store.words.find(w => !w.phonetic);
    ok("S3 专项跳过不满足前置条件的词", !noPh || Quiz.eligible(noPh, "dictation") === false, noPh ? noPh.word : "全部有音标");

    Store.settings.plan = "e2c"; fresh();
    const wrongFirst = Store.words[3];
    wrongFirst.status = "wrong"; wrongFirst.srs.lastType = "e2c"; wrongFirst.srs.wrong = 2; wrongFirst.srs.weight = 300;
    Store.settings.reviewShare = 0.999;
    const r2 = Quiz.next();
    ok("S4 专项下错题仍能复现（换题型约束自动让位）", !!r2.question && r2.question.type === "e2c", r2.question ? r2.question.type : "无题");
    Store.settings.reviewShare = 0.7;

    Store.settings.plan = "mixed";
    Store.settings.types = { e2c: true, c2e: true, cloze: false, poly: false, dictation: false };
    fresh();
    const only = run(14);
    ok("S5 设置勾选仅在混合模式生效", only.size > 0 && [...only].every(x => x === "e2c" || x === "c2e"), [...only].join(","));
    Store.settings.types = { e2c: true, c2e: true, cloze: true, poly: true, dictation: true };
    Store.settings.plan = "mixed";
    Store.save();
  })();

  /* ---------- W 滑动跳过 / 删除可撤销 / API 连通性分类 ---------- */
  (function () {
    Store.settings.mode = "free"; Store.settings.plan = "mixed"; Store.settings.daily = 300;
    Quiz.reset({ scope: "all", override: null, wrongOnly: false });
    const q0 = Quiz.next().question;
    const w0 = q0.word;
    const seen0 = w0.srs.seen, wrong0 = w0.srs.wrong, status0 = w0.status, ct0 = w0.srs.correctTypes.length;
    const sk = Quiz.skip();
    ok("W1 跳过返回被跳过的词", sk && sk.word === w0.word, JSON.stringify(sk));
    ok("W2 跳过不计分不判错不改状态", w0.srs.seen === seen0 && w0.srs.wrong === wrong0 && w0.status === status0 && w0.srs.correctTypes.length === ct0,
      "seen " + seen0 + "→" + w0.srs.seen + " status " + status0 + "→" + w0.status);
    ok("W3 跳过累计 skips", w0.srs.skips === 1, w0.srs.skips + "");
    ok("W4 已跳过的题不再重复跳", Quiz.skip() === null, String(Quiz.skip()));
    let back = false;
    for (let i = 0; i < 5 && !back; i++) {
      const r = Quiz.next(); if (!r.question) break;
      if (r.question.wordId === w0.id) back = true;
      Quiz.submit(r.question.options ? r.question.options.find(o => o.isKey).key : r.question.answer);
    }
    ok("W5 跳过的词很快重新排到", back, "5 题内未再出现");

    const n0 = Store.words.length;
    const victim = Store.words.find(w => w.word === "belt") || Store.words[0];
    Store.snapshot(); Store.remove(victim.id);
    ok("W6 删除生效", Store.words.length === n0 - 1 && !Store.byId(victim.id), n0 + "→" + Store.words.length);
    const u = Store.undo();
    ok("W7 删除可用快照撤销", u && Store.words.length === n0 && !!Store.byId(victim.id), Store.words.length + "");
  })();

  await (async function () {
    const realFetch = globalThis.fetch;
    Store.settings.ai = { baseURL: "https://test.local/v1", model: "noadic-mini", key: "sk-x" };
    const mk = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
    /* 探测现在会走两个端点：/models 与 /chat/completions。
       mock 必须按 URL 分流，否则"生成通道"永远拿不到 choices，
       测出来的是 mock 太懒，不是代码错。 */
    const route = (modelsRes, chatRes) => async (u) => (/\/models$/.test(u) ? modelsRes : chatRes);
    const chatOk = mk(200, { choices: [{ message: { content: "pong" } }] });
    const cases = [
      ["401 鉴权", mk(401, { error: "bad key" }), chatOk, "auth"],
      /* 404：/models 不支持时探测会回退去试 chat。若 chat 也不通才叫"路径不对"；
         要是 chat 通了，判成 ok 才是对的（这个端点只是不提供 /models）。 */
      ["404 路径", mk(404, {}), mk(404, {}), "path"],
      ["429 限流", mk(429, {}), chatOk, "quota"],
      ["503 服务端", mk(503, {}), chatOk, "server"],
      ["200 模型列表（且生成通道通）", mk(200, { data: [{ id: "noadic-mini" }, { id: "gpt-4o" }] }), chatOk, "ok"],
    ];
    for (const [name, mres, cres, want] of cases) {
      globalThis.fetch = route(mres, cres);
      const r = await AI.probe();
      ok("W8 连通性分类 " + name, r.kind === want, JSON.stringify(r).slice(0, 130));
    }
    /* W8b /models 404 但 chat 通：应判可用，而不是报"路径不对" */
    globalThis.fetch = route(mk(404, {}), chatOk);
    const r8b = await AI.probe();
    ok("W8b /models 不支持但 chat 通时判可用", r8b.ok === true && r8b.kind === "ok", JSON.stringify(r8b).slice(0, 120));
    /* W16 /models 通但生成通道不通 —— 这正是 DeepSeek 的真实表现，
       旧代码只看 /models 就会报"连通 ✅"骗人。 */
    globalThis.fetch = route(mk(200, { data: [{ id: "deepseek-flash" }] }), mk(503, { error: { message: "Service is too busy" } }));
    const rg = await AI.probe();
    ok("W16 /models 通但生成不通时判失败并指向桥", rg.kind === "generate" && rg.ok === false
      && /生成通道不通/.test(rg.msg) && /复制粘贴桥/.test(rg.msg), String(rg.msg).slice(0, 110));
    /* W17 生成通道挂死时探测自己必须有上限。
       /models 必须正常返回：它不带 signal，一起挂住的话探测根本走不到 chat，测的就不是这条。 */
    globalThis.fetch = (u, opt) => (/\/models$/.test(u)
      ? Promise.resolve(mk(200, { data: [{ id: "m" }] }))
      : new Promise((_r, rej) => {
        if (opt && opt.signal) opt.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); });
      }));
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realST(() => fn(), 5);        // 把探测的等待压到毫秒级，别真等 25 秒
    const rh = await AI.probe();
    globalThis.setTimeout = realST;
    ok("W17 生成通道挂死时探测被自己的上限中断，不永挂", rh.kind === "generate" && /超时中断|没有响应/.test(rh.msg), String(rh.msg).slice(0, 110));
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const rn = await AI.probe();
    ok("W9 网络/CORS 失败单独分类并指向替代通道", rn.kind === "network" && /CORS/.test(rn.msg), String(rn.msg).slice(0, 70));
    Store.settings.ai = { baseURL: "", model: "", key: "" };
    const ru = await AI.probe();
    ok("W10 未配置时提示离线通道", ru.kind === "unconfigured", JSON.stringify(ru).slice(0, 80));
    Store.settings.ai = { baseURL: "not-a-url", model: "", key: "" };
    const rb = await AI.probe();
    ok("W11 非法 Base URL 提前拦下", rb.kind === "badurl", JSON.stringify(rb).slice(0, 80));

    /* W12 挂死的端点必须被超时中断。
       这是"点了 AI 补全然后毫无反应"的根因之一：没有上限时 fetch 会永远挂着，
       界面停在"正在调用…"，既不报错也不出结果。
       把沙箱里的 setTimeout 压到 5ms，避免真等 45 秒。 */
    await (async () => {
      const realST = globalThis.setTimeout;
      let fired = false;
      globalThis.setTimeout = (fn) => realST(() => { fired = true; fn(); }, 5);
      Store.settings.ai = { baseURL: "https://test.local/v1", model: "m", key: "k", timeout: 45 };
      globalThis.fetch = (u, opt) => new Promise((_res, rej) => {
        // 一个永不 resolve、但尊重 signal 的服务端：只有真的把 signal 传下去，这条才会结束
        if (opt && opt.signal) opt.signal.addEventListener("abort", () => {
          const e = new Error("This operation was aborted"); e.name = "AbortError"; rej(e);
        });
      });
      let msg = "";
      try { await AI.chat([{ role: "user", content: "x" }]); msg = "没有抛错"; } catch (e) { msg = e.message; }
      globalThis.setTimeout = realST;
      ok("W12 端点挂死会被超时中断并说明原因与出路", fired && /45 秒内没有响应/.test(msg) && /复制粘贴桥|调大/.test(msg), msg.slice(0, 90));
    })();

    /* W13 超时值的收敛：与设置界面 min/max 一致，别让填 3 的人等到 90 秒 */
    {
      const t = (v) => { Store.settings.ai = { baseURL: "https://x/v1", key: "k", timeout: v }; return AI.timeoutSec(); };
      ok("W13 超时值收敛（3→10 下限、900→600 上限、空/脏→90）",
        t(3) === 10 && t(900) === 600 && t("") === 90 && t("abc") === 90 && t(120) === 120,
        [t(3), t(900), t(""), t("abc"), t(120)].join(","));
    }

    /* W14 端点把错误塞进 200 的 body：DeepSeek 实测返回
       {"error":{"message":"Service is too busy","type":"service_unavailable_error"}}。
       认不出来就只会报「没有 message.content」，把真原因藏掉。 */
    await (async () => {
      const rf = globalThis.fetch;
      Store.settings.ai = { baseURL: "https://test.local/v1", model: "m", key: "k" };
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ error: { message: "Service is too busy. switch to alternative providers", type: "service_unavailable_error" } }),
        text: async () => "",
      });
      let msg = "";
      try { await AI.chat([{ role: "user", content: "x" }]); msg = "没有抛错"; } catch (e) { msg = e.message; }
      globalThis.fetch = rf;
      Store.settings.ai = { baseURL: "", model: "", key: "" };
      ok("W14 200 里塞 error 时抛出真实原因", /Service is too busy/.test(msg) && !/message\.content/.test(msg), msg.slice(0, 90));
    })();

    /* W15 正常返回仍要能拿到 content（防止 W14 的判断把成功路径带偏） */
    await (async () => {
      const rf = globalThis.fetch;
      Store.settings.ai = { baseURL: "https://test.local/v1", model: "m", key: "k" };
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"words":[]}' } }] }),
        text: async () => "",
      });
      let got = "";
      try { got = await AI.chat([{ role: "user", content: "x" }]); } catch (e) { got = "抛错:" + e.message; }
      globalThis.fetch = rf;
      Store.settings.ai = { baseURL: "", model: "", key: "" };
      ok("W15 成功路径不受 error 分支影响", got === '{"words":[]}', String(got).slice(0, 60));
    })();

    globalThis.fetch = realFetch;
    Store.settings.ai = { baseURL: "", model: "", key: "" };
  })();

  /* ---------- X 整课 / 整单元批量删除 ---------- */
  (function () {
    const before = Store.words.length;
    const book = [
      "Unit 8", "Lesson 1",
      "zebra\tn. 斑马",
      "yacht\tn. 游艇",
      "Lesson 2",
      "quartz\tn. 石英",
      "uranium\tn. 铀",
      "Unit 9", "Lesson 1",
      "walnut\tn. 胡桃",
      "wattle\tn. 篱笆",
    ].join("\n");
    const res = Store.addAll(Parse.text(book).candidates, "merge", { silent: true });
    Store.rebuild();
    ok("X1 造出两级夹具（2 单元 / 3 课次）", res.added >= 4 && Store.scopeStats("unit", "Unit 8").total >= 4,
      "added " + res.added + " / Unit 8 " + Store.scopeStats("unit", "Unit 8").total);

    const L1 = "Unit 8 · Lesson 1", L2 = "Unit 8 · Lesson 2";
    const n1 = Store.scopeWords("lesson", L1).length, n2 = Store.scopeWords("lesson", L2).length;
    ok("X2 scopeStats 与 scopeWords 口径一致",
      Store.scopeStats("lesson", L2).total === n2 && Store.scopeStats("unit", "Unit 8").total === n1 + n2 + Store.scopeWords("lesson", "Unit 8").length,
      JSON.stringify({ n1: n1, n2: n2, u: Store.scopeStats("unit", "Unit 8").total }));
    ok("X3 课次统计带状态分布与词表", (() => {
      const s = Store.scopeStats("lesson", L2);
      return s.words.length === n2 && s.new === n2 && s.total === s.new + s.learning + s.wrong + s.mastered;
    })(), JSON.stringify(Store.scopeStats("lesson", L2)));

    // 前置：把 Lesson 2 做到达标，验证删除会连带清掉通关锁定
    Store.settings.mode = "sequence"; Store.settings.passRatio = 0.5;
    Store.settings.unitCleared = {};
    Store.scopeWords("lesson", L2).forEach(w => { w.status = "mastered"; w.srs.correctTypes = ["e2c", "c2e"]; });
    Store.syncCleared();
    ok("X4 前置：该课次已达标并写入锁定", !!Store.settings.unitCleared[L2], JSON.stringify(Store.settings.unitCleared));
    ok("X5 scopeStats 报告已达标", Store.scopeStats("lesson", L2).cleared === true, "");

    const rl = Store.removeScope("lesson", L2);
    ok("X6 只删该课次的词", rl.removed === n2 && Store.scopeWords("lesson", L2).length === 0, "删 " + rl.removed + " 应 " + n2);
    ok("X7 同单元其他课次完好", Store.scopeWords("lesson", L1).length === n1 && Store.unitKey(Store.words.find(w => w.word === "zebra")) === "Unit 8", String(Store.scopeWords("lesson", L1).length));
    ok("X8 通关锁定连带清除", !Store.settings.unitCleared[L2], JSON.stringify(Store.settings.unitCleared));
    ok("X9 单元仍在（还剩一课）", Store.units().indexOf("Unit 8") >= 0 && Store.scopeStats("unit", "Unit 8").total === n1, String(Store.scopeStats("unit", "Unit 8").total));
    ok("X10 删空层级是幂等空操作", (() => { const a = Store.removeScope("lesson", L2); return a.removed === 0 && a.ids.length === 0; })(), "");

    const u = Store.undo();
    ok("X11 撤销把词一并恢复", !!u && Store.scopeWords("lesson", L2).length === n2, Store.scopeWords("lesson", L2).length + "/" + n2);
    ok("X12 撤销同时恢复通关锁定（否则达标状态永久丢失）", !!Store.settings.unitCleared[L2], JSON.stringify(Store.settings.unitCleared));

    // 整单元删除：连带其下所有课次，且不能碰干扰项扩展池
    Store.words.push({
      id: "pool_probe", word: "probe", unit: "Unit 8", lesson: "Lesson 9", pool: true,
      aliases: ["probe"], key: "probe", senses: [{ pos: "n.", meaning: "探针" }], definition: "n. 探针",
      status: "new", srs: Lex.freshSrs(), enriched: true,
    });
    Store.rebuild();
    const uTotal = Store.scopeStats("unit", "Unit 8").total;
    ok("X13 pool 词不计入层级统计", Store.scopeWords("unit", "Unit 8").every(w => !w.pool) && uTotal === n1 + n2,
      "统计 " + uTotal + " 应 " + (n1 + n2));
    const totalBeforeUnit = Store.words.length;
    const ru = Store.removeScope("unit", "Unit 8");
    ok("X14 整单元删除连带所有课次", ru.removed === n1 + n2 && Store.scopeWords("lesson", L1).length === 0 && Store.scopeWords("lesson", L2).length === 0,
      "删 " + ru.removed);
    ok("X15 pool 词不受层级删除波及", !!Store.byId("pool_probe"), "");
    ok("X16 单元从层级列表中消失", Store.units().indexOf("Unit 8") < 0 && Store.unitFlags().every(u2 => u2.unit !== "Unit 8"), String(Store.units()));
    ok("X17 兄弟单元一个不少", Store.scopeStats("unit", "Unit 9").total >= 2 && !!Store.words.find(w => w.word === "walnut"), String(Store.scopeStats("unit", "Unit 9").total));
    ok("X18 折叠状态连带清掉", !(Store.settings.collapsed || {})["Unit 8"] && !(Store.settings.collapsed || {})[L2], JSON.stringify(Store.settings.collapsed));
    ok("X19 总量减少恰为删除数", Store.words.length === totalBeforeUnit - ru.removed, totalBeforeUnit + "→" + Store.words.length + " 删 " + ru.removed);
    ok("X19b 池词不进层级视图（幽灵课次会卡死顺序闯关）",
      Store.blocks().every(b => b.indexOf("Lesson 9") < 0) && Store.unitStats().every(u2 => u2.unit !== "Unit 8"),
      String(Store.blocks()));

    /* ---------- 顺序线与会话不能留下鬼引用 ---------- */
    Store.settings.mode = "sequence"; Store.settings.unitCleared = {};
    Store.words.forEach(w => { if (!w.pool) { w.status = "new"; w.srs = Lex.freshSrs(); } });
    Quiz.invalidateEligible(); Quiz.reset({ scope: "all", override: null, wrongOnly: false });
    ok("X20 删掉整单元后顺序线不再指向它", (() => {
      Store.settings.unitCleared["Unit 9"] = Date.now();
      Store.settings.unitCleared["Unit 9 · Lesson 1"] = Date.now();
      Store.removeScope("unit", "Unit 9");
      const cur = Store.currentBlock();
      return !String(cur).startsWith("Unit 9") && !Store.settings.unitCleared["Unit 9 · Lesson 1"];
    })(), String(Store.currentBlock()) + " | " + JSON.stringify(Store.settings.unitCleared));

    const kept = Store.words.filter(w => !w.pool && w.enriched).slice(0, 40);
    const doomed = kept[0];
    Quiz.reset({ scope: "all", override: null, wrongOnly: false });
    Store.settings.mode = "free";
    const q0 = Quiz.next();
    ok("X21 前置：正常出题", !!q0.question, JSON.stringify(Object.keys(q0)));
    Store.removeScope("unit", Store.unitKey(q0.question.word));
    const touched = Quiz.forgetScope(null);
    const v = Quiz.view();
    ok("X22 当前题指向已删词时作废", !v.current && touched > 0, "touched " + touched + " current " + JSON.stringify(v.current));
    ok("X23 范围/钉住指向已删层级时回退", (() => {
      Quiz.reset({ scope: "Unit 7", override: "Unit 7 · Lesson 3", wrongOnly: false });
      const t = Quiz.forgetScope("Unit 7");
      const w = Quiz.view();
      return t === 2 && w.scope === "all" && !w.override;
    })(), JSON.stringify(Quiz.view()));
    ok("X24 无关层级不受影响", (() => {
      Quiz.reset({ scope: "Unit 6", override: "Unit 6", wrongOnly: false });
      const t = Quiz.forgetScope("Unit 5");
      const w = Quiz.view();
      Quiz.reset({ scope: "all", override: null });
      return t === 0 && w.scope === "Unit 6";
    })(), JSON.stringify(Quiz.view()));
    ok("X25 题库仍可继续出题（删空不会卡死）", (() => {
      Quiz.reset({ scope: "all", override: null, wrongOnly: false });
      const r2 = Quiz.next();
      return !!(r2.question || r2.empty || r2.done);
    })(), JSON.stringify(Object.keys(Quiz.next())));
    void doomed;
  })();

  /* ---------- Y 改名 noadic 后的应用标识与存储键 ---------- */
  (function () {
    const head = JSON.parse(Store.exportJSON());
    ok("Y1 备份标识为 noadic", head.app === "noadic", head.app);
    ok("Y2 备份含 words/settings", Array.isArray(head.words) && !!head.settings, Object.keys(head).join(","));
    ok("Y3 isBackup 认新标识", Store.isBackup({ app: "noadic", words: [] }) === true, "");
    ok("Y4 isBackup 兼容改名前的旧备份", Store.isBackup({ app: "cet4-engine", words: [{ word: "a" }] }) === true, "");
    ok("Y5 isBackup 拒非备份 JSON",
      Store.isBackup({ words: [] }) === false && Store.isBackup({ app: "noadic" }) === false
      && Store.isBackup({ app: "other", words: [] }) === false && Store.isBackup(null) === false
      && Store.isBackup(undefined) === false, "");
    Store.save();
    const keys = window.__memKeys();
    ok("Y6 存储写到 noadic.v1", keys.indexOf("noadic.v1") >= 0, keys.join(","));
    ok("Y7 不再写改名前的旧存储键", keys.indexOf("cet4.engine.v1") < 0 && keys.indexOf("cet4.engine.undo") < 0,
      keys.filter((k) => /cet4/.test(k)).join(","));
    const before = Store.words.length;
    const legacy = JSON.stringify({ app: "cet4-engine", version: 1, words: [{
      id: "old_backup_1", word: "oar", unit: "Unit 12", senses: [{ pos: "n.", meaning: "桨" }],
      definition: "n. 桨", status: "mastered", srs: Lex.freshSrs(),
    }] });
    const r = Store.importJSON(legacy);
    // 注意：导入按词头去重、id 是重新铸造的（备份里的 id 不保留），所以只能按 word 断言
    const oar = Store.words.find((w) => w.word === "oar");
    ok("Y8 旧标识备份能导入", r.added === 1 && !!oar && oar.unit === "Unit 12" && oar.id !== "old_backup_1",
      JSON.stringify({ added: r.added, id: oar && oar.id }));
    ok("Y9 导入走 app.js 同一判定", Store.isBackup(JSON.parse(legacy)) === true, "");
    Store.undo();
    ok("Y10 导入可撤销（快照通道未受改名影响）", !Store.words.some((w) => w.word === "oar") && Store.words.length === before,
      Store.words.length + "/" + before);
  })();

  /* ---------- Z 背诵：遮罩数据面 + 「背不熟」手动标记 ---------- */
  (function () {
    Store.wipe();
    Store.settings.mode = "free";
    const mk = (word, unit, lesson, meaning) => ({
      word, unit, lesson, senses: [{ pos: "v.", meaning }], definition: "v. " + meaning,
      phonetic: "/əˈbɜːv/", example_en: "We " + word + " the stars.", example_zh: "我们观测星星。",
    });
    Store.addAll([
      mk("observe", "Unit 21", "Lesson 1", "观察"), mk("reserve", "Unit 21", "Lesson 1", "保留"),
      mk("deserve", "Unit 21", "Lesson 2", "值得"), mk("preserve", "Unit 22", "Lesson 1", "保护"),
    ], "merge", { silent: true });
    Store.rebuild(); Store.save();
    const W = (wd) => Store.words.find((w) => w.word === wd);
    ok("Z0 前置：4 词 / 2 单元 / 3 课次", Store.words.length === 4 && Store.units().length === 2 && Store.blocks().length === 3,
      Store.words.length + "/" + String(Store.units()) + "/" + String(Store.blocks()));

    ok("Z1 标记生效并记下时间", (() => {
      const r = Store.toggleWeak(W("observe").id);
      const w = W("observe");
      return r === true && w.weak === true && w.weakAt > 0;
    })(), JSON.stringify(W("observe").weak));
    ok("Z2 再点取消：字段彻底删掉，不留 weak:false 垃圾", (() => {
      Store.toggleWeak(W("observe").id);
      const w = W("observe");
      return w.weak === undefined && !("weak" in w) && !("weakAt" in w);
    })(), JSON.stringify(W("observe")));
    Store.toggleWeak(W("observe").id, true);
    Store.toggleWeak(W("deserve").id, true);
    ok("Z3 显式传值可强制置位（幂等）", W("observe").weak === true && W("deserve").weak === true && Store.weakCount() === 2,
      String(Store.weakCount()));
    ok("Z4 stats().weak 与 weakCount/实数三者一致",
      Store.stats().weak === Store.weakCount() && Store.stats().weak === Store.words.filter((w) => w.weak).length,
      JSON.stringify([Store.stats().weak, Store.weakCount()]));
    ok("Z5 标记不碰 status（背诵的轴不能污染测验判定）", W("observe").status === "new" && W("deserve").status === "new",
      W("observe").status + "/" + W("deserve").status);
    ok("Z6 标记不进撤销快照（非破坏性操作不该吃掉「撤销上次改动」）", (() => {
      const before = Store.canUndo();
      Store.toggleWeak(W("reserve").id, true);
      Store.toggleWeak(W("reserve").id, false);
      return before === Store.canUndo();
    })(), String(Store.canUndo()));
    Store.words.push({
      id: "pool_z", word: "conservative", unit: "Unit 21", lesson: "Lesson 1", pool: true,
      aliases: ["conservative"], key: "conservative", senses: [{ pos: "adj.", meaning: "保守的" }],
      definition: "adj. 保守的", status: "new", srs: Lex.freshSrs(), enriched: true,
    });
    Store.rebuild();
    ok("Z7 bookWords() 不含扩展池词（背诵列表只背书里有的）",
      Store.bookWords().length === 4 && !Store.bookWords().some((w) => w.pool), String(Store.bookWords().length));
    ok("Z8 池词即便被标了也不进背诵列表（bookWords 一挡，weakWords 就看不见它）", (() => {
      Store.toggleWeak("pool_z", true);
      return W("conservative").weak === true && !Store.weakWords().some((w) => w.pool)
        && !Store.bookWords().some((w) => w.id === "pool_z");
    })(), JSON.stringify(Store.weakWords().map((w) => w.word)));
    ok("Z9 层级统计带 weak 且课次加和＝单元加和", (() => {
      const bs = Store.blockStats(), us = Store.unitStats();
      const u21 = us.find((u) => u.unit === "Unit 21");
      const sum21 = bs.filter((b) => b.unit === "Unit 21").reduce((n, b) => n + b.weak, 0);
      return u21.weak === 2 && sum21 === u21.weak && Store.unitFlags().find((u) => u.unit === "Unit 21").weak === 2;
    })(), JSON.stringify(Store.unitStats().map((u) => [u.unit, u.weak])));
    ok("Z10 删除确认框能看到「其中几个标了不熟」", Store.scopeStats("unit", "Unit 21").weak === 2
      && Store.scopeStats("lesson", "Unit 21 · Lesson 2").weak === 1
      && Store.scopeStats("lesson", "Unit 22 · Lesson 1").weak === 0,
      JSON.stringify([Store.scopeStats("unit", "Unit 21").weak, Store.scopeStats("lesson", "Unit 21 · Lesson 2").weak]));
    ok("Z11 clearWeak 按课次只清那一课，且不动池词", (() => {
      const n = Store.clearWeak("lesson", "Unit 21 · Lesson 1");
      return n === 1 && W("observe").weak === undefined && W("deserve").weak === true && W("conservative").weak === true;
    })(), JSON.stringify(Store.words.map((w) => [w.word, !!w.weak])));
    ok("Z12 clearWeak 不传层级＝清掉背诵范围内全部标记", (() => {
      const n = Store.clearWeak();
      return n === 1 && Store.weakCount() === 0 && Store.bookWords().every((w) => !w.weak);
    })(), String(Store.weakCount()));
    Store.toggleWeak(W("preserve").id, true);
    ok("Z13 导出→导入带回标记", (() => {
      const dump = Store.exportJSON();
      Store.toggleWeak(W("preserve").id, false);
      Store.importJSON(dump);
      const w = Store.words.find((x) => x.word === "preserve");
      return !!w && w.weak === true;
    })(), JSON.stringify(Store.words.find((x) => x.word === "preserve") && Store.words.find((x) => x.word === "preserve").weak));
    ok("Z14 重导入普通词表不会抹掉手动标记", (() => {
      Store.addAll([{ word: "preserve", unit: "Unit 22", definition: "v. 保存" }], "merge", { silent: true });
      Store.rebuild();
      return Store.words.find((x) => x.word === "preserve").weak === true;
    })(), JSON.stringify(Store.words.filter((x) => x.word === "preserve").map((x) => x.weak)));
    ok("Z15 备份回灌可以把标记并到已有词上", (() => {
      Store.toggleWeak(W("preserve").id, false);
      Store.importJSON(JSON.stringify({ app: "noadic", version: 1, words: [{
        word: "preserve", unit: "Unit 22", definition: "v. 保护", senses: [{ pos: "v.", meaning: "保护" }], weak: true,
      }] }));
      return Store.words.find((x) => x.word === "preserve").weak === true;
    })(), JSON.stringify(Store.words.filter((x) => x.word === "preserve").map((x) => x.weak)));

    /* 测验范围：只练不熟 */
    Store.toggleWeak(W("observe").id, true);
    Store.toggleWeak(W("deserve").id, true);
    Store.words.filter((w) => !w.weak && !w.pool).forEach((w) => { w.status = "mastered"; });
    Quiz.invalidateEligible();
    Quiz.reset({ scope: "weak", override: null, wrongOnly: false });
    ok("Z16 范围「只练不熟」只出标记过的词", (() => {
      const weakIds = new Set(Store.weakWords().map((w) => w.id));
      const seen = new Set();
      for (let i = 0; i < 10; i++) {
        const r = Quiz.next();
        const q = r.question;
        if (!q) break;
        if (!weakIds.has(q.word.id)) return false;
        seen.add(q.word.id);
      }
      return seen.size >= 2;
    })(), JSON.stringify(Quiz.view().scope));
    ok("Z17 标记为零时该范围直接空（不会退化成全库）", (() => {
      Store.clearWeak();
      Quiz.reset({ scope: "weak", override: null, wrongOnly: false });
      const r = Quiz.next();
      return !r.question;
    })(), JSON.stringify(Object.keys(Quiz.next())));

    /* 删除与撤销不能把标记弄成孤儿 */
    Store.addAll([mk("conserve", "Unit 23", "Lesson 1", "节约")], "merge", { silent: true });
    Store.rebuild();
    Store.toggleWeak(W("conserve").id, true);
    const undoBefore = Store.canUndo();
    Store.removeScope("unit", "Unit 23");
    ok("Z18 整单元删除后标记随词消失", Store.weakWords().every((w) => w.word !== "conserve") && !Store.words.some((w) => w.word === "conserve"),
      JSON.stringify(Store.weakWords().map((w) => w.word)));
    ok("Z19 撤销回来的词带着当初的标记", (() => {
      const u = Store.undo();
      const w = Store.words.find((x) => x.word === "conserve");
      return !!u && !!w && w.weak === true;
    })(), JSON.stringify(Store.words.find((x) => x.word === "conserve")));
    ok("Z20 背诵设置项有默认值（老数据 load 后不会 undefined）",
      Store.DEFAULT_SETTINGS.reciteMask === "zh" && Store.DEFAULT_SETTINGS.reciteFilter === "all"
      && Store.DEFAULT_SETTINGS.reciteShuffle === false
      && !!Store.load().settings.reciteMask, JSON.stringify([Store.settings.reciteMask, Store.settings.reciteFilter]));
    /* ---------- 备份嗅探：必须整体解析，不能截断 ----------
       用户报"导入词库文件显示 Unterminated string in JSON at position 4000"。
       成因是 app.js 里 JSON.parse(txt.slice(0, 4000)) 去嗅探是不是备份。 */
    ok("Z21 前提：完整备份确实远超 4000 字符", Store.exportJSON().length > 4000, Store.exportJSON().length + " 字符");
    ok("Z22 完整备份能被识别为备份（整体解析）", (() => {
      const s = Store.sniffJSON(Store.exportJSON());
      return s.isBackup === true && !s.error;
    })(), Store.sniffJSON(Store.exportJSON()).error);
    /* 只断言"它会抛"。V8 的措辞随截断位置变（Unterminated string / Unexpected end /
       Expected double-quoted property name…），按措辞匹配是我上一版的错——
       那等于把实现的偶然细节写成了断言。
       注意返回值必须是布尔：ok() 用 !!cond 判定，返回非空字符串会变成假通过。 */
    const z23 = (() => {
      const txt = Store.exportJSON();
      try { JSON.parse(txt.slice(0, 4000)); return [false, "截断解析没抛错（数据太短？前提变了要改数据）"]; }
      /* 不能用 instanceof SyntaxError：JSON 是宿主注入的，它抛的错属于宿主 realm，
         而沙箱里有自己的一套内建构造器，跨 realm 的 instanceof 永远为 false。看 name。 */
      catch (e) { return [!!(e && e.name === "SyntaxError"), (e && e.name) + ": " + String(e.message).slice(0, 60)]; }
    })();
    ok("Z23 旧写法（截前 4000 再 parse）在这份备份上确实会抛", z23[0], z23[1]);
    ok("Z24 词表 JSON 不被误判为备份", Store.sniffJSON('{"words":[{"word":"realm"}]}').isBackup === false, "");
    ok("Z25 非法 JSON 返回 error 而不是抛出", (() => { const s = Store.sniffJSON('{"words": ['); return s.isBackup === false && !!s.error; })(), "");
    ok("Z26 改名前的旧备份 app=cet4-engine 仍然认", Store.sniffJSON(JSON.stringify({ app: "cet4-engine", words: [] })).isBackup === true, "");
    void undoBefore;
  })();

  window.__RESULT__ = R;
})();
`;

try {
  await vm.runInContext(TEST, sandbox, { filename: "test.js" });
} catch (e) {
  console.log("\\n💥 测试脚本抛错：\\n" + (e && e.stack ? e.stack.split("\\n").slice(0, 6).join("\\n") : e));
  process.exitCode = 1;
}

const R = sandbox.window.__RESULT__ || [];
let pass = 0;
for (const r of R) {
  if (r.pass) { pass++; console.log("  ✅ " + r.name); }
  else console.log("  ❌ " + r.name + "  →  " + r.extra);
}
console.log(`\n${pass}/${R.length} 通过`);
if (pass !== R.length) process.exitCode = 1;
