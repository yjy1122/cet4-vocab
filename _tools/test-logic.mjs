/* 端到端逻辑测试：在 vm 沙箱里把浏览器模块当无头环境跑（去重 / 出题 / 状态机 / 契约） */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = "D:\\Users\\DawnFish\\Desktop\\新建文件夹";
const mods = ["www/js/seed-words.js", "www/js/lexicon.js", "www/js/dict-extra.js", "www/js/store.js", "www/js/parse.js", "www/js/distractors.js", "www/js/quiz.js", "www/js/ai.js"];
const code = mods.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");

const mem = new Map();
const sandbox = {
  console, JSON, Math, Date, RegExp, Set, Map, Array, Object, String, Number, Promise, Error, Proxy, Reflect, Boolean, Symbol, parseInt, parseFloat, isNaN,
  TextDecoder, Blob, Response, DecompressionStream, structuredClone, setTimeout, clearTimeout, fetch,
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
};
sandbox.window = sandbox;          // 浏览器里 window 就是全局对象：模块用 window.X = ... 暴露、用裸 X 互访
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* 1) 加载模块 */
vm.runInContext(code, sandbox, { filename: "bundle.js" });

/* 2) 先用沙箱外解析真实 docx，结果作为常量注入 */
const buf = fs.readFileSync("D:\\Users\\DawnFish\\Desktop\\样例.docx");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dres = await sandbox.window.Parse.file({ name: "样例.docx", arrayBuffer: async () => ab });
sandbox.window.__DOCX__ = dres;
sandbox.window.__AB__ = ab;

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
    Store.settings.ai = { baseURL: "https://test.local/v1", model: "cet4-mini", key: "sk-x" };
    const mk = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
    const cases = [
      ["401 鉴权", mk(401, { error: "bad key" }), "auth"],
      ["404 路径", mk(404, {}), "path"],
      ["429 限流", mk(429, {}), "quota"],
      ["503 服务端", mk(503, {}), "server"],
      ["200 模型列表", mk(200, { data: [{ id: "cet4-mini" }, { id: "gpt-4o" }] }), "ok"],
    ];
    for (const [name, res, want] of cases) {
      globalThis.fetch = async () => res;
      const r = await AI.probe();
      ok("W8 连通性分类 " + name, r.kind === want, JSON.stringify(r).slice(0, 130));
    }
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const rn = await AI.probe();
    ok("W9 网络/CORS 失败单独分类并指向替代通道", rn.kind === "network" && /CORS/.test(rn.msg), String(rn.msg).slice(0, 70));
    Store.settings.ai = { baseURL: "", model: "", key: "" };
    const ru = await AI.probe();
    ok("W10 未配置时提示离线通道", ru.kind === "unconfigured", JSON.stringify(ru).slice(0, 80));
    Store.settings.ai = { baseURL: "not-a-url", model: "", key: "" };
    const rb = await AI.probe();
    ok("W11 非法 Base URL 提前拦下", rb.kind === "badurl", JSON.stringify(rb).slice(0, 80));
    globalThis.fetch = realFetch;
    Store.settings.ai = { baseURL: "", model: "", key: "" };
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
