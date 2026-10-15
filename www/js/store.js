/* =========================================================================
 * store.js — localStorage 持久化 + 双索引（别名/屈折面）+ 撤销快照
 * 纯本地离线：无服务器、无账号、无网络请求（AI 增强为用户主动触发）
 * ========================================================================= */
const Store = (() => {
  const KEY = "noadic.v1";
  const UNDO_KEY = "noadic.undo";
  /* 备份文件的应用标识：改名（CET-4 词汇引擎 → noadic）前导出的 json 照样认得进来。
   * 存储键本身没有做旧键迁移 —— 改名时还没有正式使用过任何数据，留一段永远不会跑的
   * 搬运代码只是负担。 */
  const APP_IDS = ["noadic", "cet4-engine"];

  const DEFAULT_SETTINGS = {
    daily: 20,
    sound: true,
    swipeNext: true,         // 测验卡片左滑/右滑切题（未作答时算跳过）
    autoNext: true,
    autoNextMs: 5000,
    usePool: false,
    scope: "all",
    dedup: "merge",          // 重复词条策略：merge | skip | overwrite
    plan: "mixed",           // 出题方案：mixed 混合轮换（现有方案）| e2c | c2e | cloze | poly | dictation 单一专项
    pinnedUnit: "",          // 导入时钉住的父级单元（文本里没有 Unit 标题时用）
    pinnedLesson: "",        // 导入时钉住的课次
    mode: "sequence",        // 顺序闯关（默认）| free 自由练习
    passRatio: 0.8,          // 单元达标线：已掌握比例
    autoAdvance: true,       // 达标后自动进下一单元
    carryWrong: true,        // 已通关单元的回潮错题继续插队复习
    unitCleared: {},         // 已通关并锁定的单元
    reviewShare: 0.7,        // 每题为「复习(错题/未掌握)」的概率，其余引入书序新词
    strictOrder: true,       // 新词严格按书的排列顺序引入
    libGroup: true,          // 词库按单元分组显示
    collapsed: {},           // 已折叠的单元
    reciteMask: "zh",        // 背诵遮罩：zh 遮中文 | en 遮英文 | off 不遮
    reciteFilter: "all",     // 背诵筛选：all 全部 | weak 只看不熟 | fresh 没标记的
    reciteShuffle: false,    // 背诵乱序（避免记住的是位置而不是词）
    types: { e2c: true, c2e: true, cloze: true, poly: true, dictation: true },
    ai: { baseURL: "", model: "", key: "", timeout: 90 },   // timeout 秒：本地大模型首次加载权重可能很慢
  };

  let state = { words: [], settings: structuredClone(DEFAULT_SETTINGS), meta: { seeded: false, imports: [] } };
  let index = null;

  /* ---------- 读写 ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw);
        state.words = Array.isArray(p.words) ? p.words : [];
        state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(p.settings || {}) };
        state.settings.types = { ...DEFAULT_SETTINGS.types, ...(p.settings.types || {}) };
        state.settings.ai = { ...DEFAULT_SETTINGS.ai, ...(p.settings.ai || {}) };
        for (const k of ["unitCleared", "collapsed"]) {
          if (!state.settings[k] || typeof state.settings[k] !== "object") state.settings[k] = {};
        }
        state.meta = { ...state.meta, ...(p.meta || {}) };
        if (!state.meta.seeded && !state.words.length) { seed(); save(); }
      } else {
        seed();
        save();                       // 播种必须落盘，否则刷新后词条 id 重建、进度丢失
      }
    } catch (e) {
      console.warn("store load failed", e);
      seed();
    }
    rebuild();
    backfill();
    return state;
  }

  /** 一次性回填：老数据（修复前播种的）缺音标/例句时，用内置词典补齐空字段，不动进度 */
  function backfill() {
    if (typeof Parse === "undefined" || !Parse.autofill || !window.DICT) return 0;
    let n = 0;
    for (const w of state.words) {
      if (w.enriched) continue;
      const tmp = Parse.autofill({
        word: w.word, definition: w.definition, senses: w.senses,
        phonetic: w.phonetic, collocation: w.collocation, example_en: w.example_en, example_zh: w.example_zh,
      });
      let changed = false;
      if (!w.phonetic && tmp.phonetic) { w.phonetic = tmp.phonetic; changed = true; }
      if (!w.collocation && tmp.collocation) { w.collocation = tmp.collocation; changed = true; }
      if (!w.example_en && tmp.example_en) { w.example_en = tmp.example_en; w.example_zh = tmp.example_zh || ""; changed = true; }
      if (changed) { w.enriched = !!(w.phonetic && w.example_en); n++; }
    }
    if (n) save();
    return n;
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      if (typeof UI !== "undefined" && UI.toast) UI.toast("本地存储写入失败（可能超出 localStorage 配额），请先导出备份再清理", true);
      console.warn("store save failed", e);
      return false;
    }
  }

  /* ---------- 索引 ---------- */
  function rebuild() {
    const byAlias = new Map(), bySurface = new Map(), bySoft = new Map(), byId = new Map();
    for (const w of state.words) {
      byId.set(w.id, w);
      for (const a of new Set([...(w.aliases || []), w.word, w.key])) {
        const k = Lex.norm(a);
        if (k && !byAlias.has(k)) byAlias.set(k, w);
      }
      for (const k of Lex.softVariants(w.word)) if (k && !byAlias.has(k) && !bySoft.has(k)) bySoft.set(k, w);
      for (const a of new Set([...(w.aliases || []), w.word])) {
        for (const f of Lex.inflect(a)) {
          const k = Lex.norm(f);
          if (k && !byAlias.has(k) && !bySoft.has(k) && !bySurface.has(k)) bySurface.set(k, w);
        }
      }
    }
    index = { byAlias, bySurface, bySoft, byId, words: byId };
    return index;
  }
  const indexContext = () => index || rebuild();
  const byId = (id) => indexContext().byId.get(id);

  /* ---------- 统计 ---------- */
  function stats() {
    const s = { total: state.words.length, new: 0, learning: 0, wrong: 0, mastered: 0, unenriched: 0, weak: 0 };
    for (const w of state.words) {
      s[w.status] = (s[w.status] || 0) + 1;
      if (!w.enriched) s.unenriched++;
      if (w.weak) s.weak++;
    }
    return s;
  }

  /* ---------- 两级层级：Unit（父）→ Lesson / List（子） ---------- */
  /** 层级视图只认真实词条：干扰项扩展池的词不属于书的任何一课，
   *  混进来的话顺序闯关会把"只有池词的幽灵课次"当成当前块（出题池被 !pool 一filter 就空，卡死）。 */
  const bookWords = () => state.words.filter((w) => !w.pool);
  const numsOf = (s) => (String(s).match(/\d+/g) || []).map(Number);
  /** 自然序：逐段比较编号，"Unit 2 · Lesson 10" 排在 "Unit 2 · Lesson 9" 之后、"Unit 10" 之前 */
  function labelOrder(a, b) {
    const pa = String(a || "").split(" · "), pb = String(b || "").split(" · ");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const sa = pa[i] || "", sb = pb[i] || "";
      const na = numsOf(sa)[0], nb = numsOf(sb)[0];
      // 没有编号的分组（如「未分组」）排最后：不能让没归类的词劫持"从 Unit 1 开始"的学习线
      const xa = na == null ? Infinity : na, xb = nb == null ? Infinity : nb;
      if (xa !== xb) return xa - xb;
      const c = sa.localeCompare(sb);
      if (c) return c;
    }
    return 0;
  }
  const unitOrder = labelOrder;                                   // 兼容旧调用名
  const unitKey = (w) => w.unit || (w.units && w.units[0]) || "未分组";
  const blockKey = (w) => (w.lesson ? unitKey(w) + " · " + w.lesson : unitKey(w));

  const units = () => [...new Set(bookWords().map(unitKey))].sort(labelOrder);
  const blocks = () => [...new Set(bookWords().map(blockKey))].sort(labelOrder);

  function groupStats(keyFn) {
    const map = new Map();
    for (const w of bookWords()) {
      const k = keyFn(w);
      if (!map.has(k)) map.set(k, { label: k, unit: k, lesson: "", total: 0, new: 0, learning: 0, wrong: 0, mastered: 0, unenriched: 0, weak: 0, seen: 0, correct: 0 });
      const s = map.get(k);
      s.total++; s[w.status] = (s[w.status] || 0) + 1;
      if (!w.enriched) s.unenriched++;
      if (w.weak) s.weak++;
      s.seen += (w.srs && w.srs.seen) || 0; s.correct += (w.srs && w.srs.correct) || 0;
    }
    const list = [...map.values()];
    list.forEach((s) => { s.done = s.mastered; s.pct = s.total ? Math.round((s.mastered / s.total) * 100) : 0; });
    return list.sort((a, b) => labelOrder(a.label, b.label));
  }
  /** 按单元（父级）汇总 */
  const unitStats = () => groupStats(unitKey);
  /** 按课次（子级，最小学习块）统计 */
  const blockStats = () => groupStats(blockKey).map((s) => ({ ...s, unit: s.label.split(" · ")[0], lesson: s.label.split(" · ")[1] || "" }));

  const wordsOf = (unit) => bookWords().filter((w) => unitKey(w) === unit).sort((a, b) => state.words.indexOf(a) - state.words.indexOf(b));
  const wordsOfBlock = (label) => bookWords().filter((w) => blockKey(w) === label).sort((a, b) => state.words.indexOf(a) - state.words.indexOf(b));

  /* ---------- 顺序闯关：达标线落在课次上，单元做汇总 ---------- */
  const inUnit = (w, unit) => !unit ? true : ((w.units && w.units.length ? w.units : [w.unit]).includes(unit) || unitKey(w) === unit);
  const inBlock = (w, label) => !label ? true : blockKey(w) === label;
  function gateMet(g) {
    const r = state.settings.passRatio == null ? 0.8 : state.settings.passRatio;
    return g.total > 0 && g.wrong === 0 && (g.mastered / g.total) >= r;
  }
  const flagsOf = (stats) => {
    const clearedMap = state.settings.unitCleared || {};
    const ratio = state.settings.passRatio == null ? 0.8 : state.settings.passRatio;
    let activeTaken = false;
    return stats.map((g) => {
      const cleared = !!clearedMap[g.label] || gateMet(g);
      let st = "later";
      if (cleared) st = "cleared";
      else if (!activeTaken) { st = "active"; activeTaken = true; }
      return {
        ...g, unit: g.unit || g.label, cleared, state: st,
        gatePct: g.pct,
        regressed: !!clearedMap[g.label] && g.wrong > 0,          // 通关后又答错 → 标记回潮但不收回通关
        needMore: g.total ? Math.max(0, Math.ceil(g.total * ratio) - g.mastered) : 0,
      };
    });
  };
  const blockFlags = () => flagsOf(blockStats());
  /** 父级单元：其下所有课次都通关，该单元才算通关 */
  function unitFlags() {
    const bf = blockFlags();
    const map = new Map();
    for (const b of bf) {
      if (!map.has(b.unit)) map.set(b.unit, { label: b.unit, unit: b.unit, total: 0, new: 0, learning: 0, wrong: 0, mastered: 0, unenriched: 0, weak: 0, seen: 0, correct: 0, blocks: [], cleared: true, regressed: false });
      const s = map.get(b.unit);
      s.blocks.push(b);
      s.total += b.total; s.new += b.new; s.learning += b.learning; s.wrong += b.wrong;
      s.mastered += b.mastered; s.unenriched += b.unenriched; s.seen += b.seen; s.correct += b.correct;
      s.weak += b.weak;
      if (!b.cleared) s.cleared = false;
      if (b.regressed) s.regressed = true;
    }
    const list = [...map.values()];
    list.forEach((s) => { s.pct = s.total ? Math.round((s.mastered / s.total) * 100) : 0; s.gatePct = s.pct; s.done = s.mastered; s.needMore = Math.max(0, Math.ceil(s.total * (state.settings.passRatio == null ? .8 : state.settings.passRatio)) - s.mastered); });
    list.sort((a, b) => labelOrder(a.label, b.label));
    let activeTaken = false;
    list.forEach((s) => { s.state = s.cleared ? "cleared" : (activeTaken ? "later" : (activeTaken = true, "active")); });
    return list;
  }
  /** 当前学习块（课次级）；无课次时等价于单元 */
  function currentBlock() {
    if (state.settings.mode !== "sequence") return null;
    const a = blockFlags().find((u) => !u.cleared);
    return a ? a.label : null;
  }
  const currentUnit = () => currentBlock();
  const allCleared = () => bookWords().length > 0 && blockFlags().every((u) => u.cleared);

  /** 检查并锁定新达标的课次块，返回本次刚通关的块名 */
  function syncCleared() {
    const c = { ...(state.settings.unitCleared || {}) };
    const newly = [];
    for (const g of blockStats()) if (!c[g.label] && gateMet(g)) { c[g.label] = Date.now(); newly.push(g.label); }
    if (newly.length) { state.settings.unitCleared = c; save(); }
    return newly;
  }
  function unclear(label) {
    const c = { ...(state.settings.unitCleared || {}) };
    delete c[label];
    // 传单元名时，连带清掉它下面所有课次块的通关标记
    for (const k of Object.keys(c)) if (label && k.startsWith(label + " · ")) delete c[k];
    state.settings.unitCleared = c; save();
  }
  function resetBlock(label) {
    unclear(label);
    let n = 0;
    for (const w of state.words) if (blockKey(w) === label && !w.pool) { w.status = "new"; w.srs = Lex.freshSrs(); n++; }
    save();
    return n;
  }
  function resetUnit(unit) {
    unclear(unit);
    let n = 0;
    for (const w of state.words) if (unitKey(w) === unit && !w.pool) { w.status = "new"; w.srs = Lex.freshSrs(); n++; }
    save();
    return n;
  }

  /* ---------- 首次播种 ---------- */
  function seed() {
    if (!window.SEED_WORDS || state.words.length) return;
    const cands = window.SEED_WORDS.map((s) => ({
      word: s.word, unit: s.unit, senses: s.senses, definition: s.definition_raw, source: "seed",
    }));
    // 播种同样要走内置词典补全，否则音标/例句全空 → 听写与语境填空失效
    if (typeof Parse !== "undefined" && Parse.autofill) cands.forEach((c) => Parse.autofill(c));
    const res = addAll(cands, "merge", { silent: true });
    state.meta.seeded = true;
    state.meta.imports.unshift({ at: Date.now(), kind: "seed", added: res.summary.new, merged: res.summary.merge, dup: res.summary.dup });
  }

  /* ---------- 入库（含去重） ---------- */
  function plan(cands, strategy) { return Lex.planBatch(cands, { indexContext }, strategy || state.settings.dedup || "merge"); }

  function addAll(cands, strategy, opts) {
    opts = opts || {};
    const p = Lex.planBatch(cands, { indexContext }, strategy || "merge");
    if (!opts.silent) snapshot();
    let added = 0, merged = 0, dup = 0;
    const applied = new Set();
    for (const r of p.rows) {
      if (r.action === "new") { state.words.push(r.merged); added++; }
      else if (r.action === "merge" && !applied.has(r.target)) {
        const i = state.words.findIndex((w) => w.id === r.target);
        if (i >= 0) { state.words[i] = r.merged; merged++; }
        applied.add(r.target);
      } else dup++;
    }
    rebuild();
    if (!opts.silent) {
      save();
      state.meta.imports.unshift({ at: Date.now(), added, merged, dup, strategy: strategy || "merge", total: cands.length });
      state.meta.imports = state.meta.imports.slice(0, 20);
      save();
    }
    return { ...p, added, merged, dup };
  }

  /* 预览确认后提交：直接吃 plan 的行，避免二次解析造成偏移 */
  function commitPlan(p) {
    snapshot();
    let added = 0, merged = 0, dup = 0;
    const applied = new Set();
    for (const r of p.rows) {
      if (r.action === "new") { state.words.push(r.merged); added++; }
      else if (r.action === "merge" && !applied.has(r.target)) {
        const i = state.words.findIndex((w) => w.id === r.target);
        if (i >= 0) state.words[i] = r.merged;
        applied.add(r.target); merged++;
      } else if (r.action === "dupBatch" && r.target) { /* 同批折叠：已并入前一条 */ }
      else dup++;
    }
    rebuild(); save();
    state.meta.imports.unshift({ at: Date.now(), added, merged, dup, strategy: p.strategy, total: p.rows.length });
    state.meta.imports = state.meta.imports.slice(0, 20);
    save();
    return { added, merged, dup };
  }

  /* ---------- 撤销一次入库 ---------- */
  function snapshot() {
    // 连通关锁定一起存：批量删课/删单元会清掉这些标记，只回滚词条的话，
    // 撤销回来的单元会因为丢了"已达标"锁而重新变成未通关（有残留错题时尤其明显）。
    try {
      localStorage.setItem(UNDO_KEY, JSON.stringify({
        at: Date.now(), words: state.words, flags: { ...(state.settings.unitCleared || {}) },
      }));
    } catch (e) { }
  }
  function canUndo() {
    try { const r = localStorage.getItem(UNDO_KEY); return r ? !!JSON.parse(r).words : false; } catch (e) { return false; }
  }
  function undo() {
    try {
      const r = localStorage.getItem(UNDO_KEY);
      if (!r) return null;
      const p = JSON.parse(r);
      if (!p || !Array.isArray(p.words)) return null;
      state.words = p.words;
      if (p.flags && typeof p.flags === "object") state.settings.unitCleared = p.flags;
      rebuild(); save();
      localStorage.removeItem(UNDO_KEY);
      return { at: p.at, count: p.words.length };
    } catch (e) { return null; }
  }

  /* ---------- 词条增删改 ---------- */
  function update(id, patch) {
    const w = byId(id);
    if (!w) return null;
    Object.assign(w, patch);
    if (patch.senses) { w.defSig = Lex.defSig(w.senses); w.definition = w.senses.map((s) => `${s.pos} ${s.meaning}`.trim()).join(" "); w.pos = Lex.posSummary(w.senses); }
    if (patch.word) { w.aliases = Lex.variantsOf(patch.word); w.key = Lex.norm(w.aliases[0]); }
    w.enriched = !!(w.phonetic && w.example_en);
    w.updatedAt = Date.now();
    if (w.source !== "manual") w.source = "manual";
    rebuild(); save();
    return w;
  }
  function remove(id) {
    const i = state.words.findIndex((w) => w.id === id);
    if (i < 0) return false;
    state.words.splice(i, 1); rebuild(); save(); return true;
  }

  /* ---------- 按层级批量删除：整课 / 整单元 ---------- */
  /** pool 词（干扰项扩展池）不属于任何真实课次，任何层级删除都不能碰它 */
  function inScope(w, kind, label) {
    if (w.pool) return false;
    return (kind === "lesson" ? blockKey(w) : unitKey(w)) === label;
  }
  const scopeWords = (kind, label) => state.words.filter((w) => inScope(w, kind, label));

  /** 删除前给确认框看的数字——与 removeScope 真正删的走同一个 scopeWords，不会看一套删一套 */
  function scopeStats(kind, label) {
    const list = scopeWords(kind, label);
    const c = state.settings.unitCleared || {};
    const s = {
      kind, label, total: list.length, new: 0, learning: 0, wrong: 0, mastered: 0,
      unenriched: 0, weak: 0, lessons: [], words: list.map((w) => w.word), cleared: false, clearedAt: null,
    };
    const ls = new Set();
    for (const w of list) {
      s[w.status] = (s[w.status] || 0) + 1;
      if (!w.enriched) s.unenriched++;
      if (w.weak) s.weak++;
      if (w.lesson) ls.add(w.lesson);
    }
    s.lessons = [...ls].sort(labelOrder);
    if (kind === "lesson") {
      const g = blockFlags().find((b) => b.label === label);
      s.cleared = !!(g && g.cleared);
      s.clearedAt = c[label] || null;
    } else {
      const g = unitFlags().find((u) => u.unit === label);
      s.cleared = !!(g && g.cleared);
      const keys = Object.keys(c).filter((k) => k === label || k.startsWith(label + " · "));
      s.clearedAt = keys.length ? Math.max(...keys.map((k) => c[k])) : null;
    }
    return s;
  }

  /**
   * 删除整个课次（kind="lesson"，label 为 "Unit 1 · Lesson 2"）或整个单元
   * （kind="unit"，label 为 "Unit 1"，连带其下所有课次）。
   * 自带快照：撤销通道与单词删除同一条，删错可恢复（只留最近一次）。
   */
  function removeScope(kind, label) {
    const doomed = new Set(scopeWords(kind, label).map((w) => w.id));
    if (!doomed.size) return { removed: 0, ids: [], clearedFlags: [] };
    snapshot();
    const before = state.words.length;
    state.words = state.words.filter((w) => !doomed.has(w.id));
    /* 通关锁定是按名字存的，词删光不会自己消失。留着的话，日后重新导入同名课次
     * 会一进来就显示「已达标」，顺序闯关的门被直接跳过 —— 必须连带清掉。 */
    const c = { ...(state.settings.unitCleared || {}) };
    const clearedFlags = [];
    for (const k of Object.keys(c)) {
      const mine = kind === "lesson" ? k === label : (k === label || k.startsWith(label + " · "));
      if (mine) { delete c[k]; clearedFlags.push(k); }
    }
    state.settings.unitCleared = c;
    const col = { ...(state.settings.collapsed || {}) };
    for (const k of Object.keys(col)) if (k === label || k.startsWith(label + " · ")) delete col[k];
    state.settings.collapsed = col;
    rebuild(); save();
    return { removed: before - state.words.length, ids: [...doomed], clearedFlags };
  }

  /* ---------- 背诵标记：「背不熟」 ---------- */
  /** 与错题本是两条独立的轴：错题本由测验自动判定，背不熟由你手动标记。
   *  手动标记不该被测验改写，所以它不碰 status，也不进撤销快照（非破坏性操作）。 */
  const weakWords = () => bookWords().filter((w) => !!w.weak);
  const weakCount = () => weakWords().length;

  /** on 省略＝取反；返回新状态，词不存在返回 null */
  function toggleWeak(id, on) {
    const w = byId(id);
    if (!w) return null;
    const next = on === undefined ? !w.weak : !!on;
    if (next) { w.weak = true; w.weakAt = Date.now(); } else { delete w.weak; delete w.weakAt; }
    save();
    return !!w.weak;
  }

  /** 清空标记：给 kind+label 时只清该层级（一课/一单元），否则清全部 */
  function clearWeak(kind, label) {
    const list = kind && label ? scopeWords(kind, label) : bookWords();
    let n = 0;
    for (const w of list) if (w.weak) { delete w.weak; delete w.weakAt; n++; }
    if (n) save();
    return n;
  }

  /* ---------- 设置 ---------- */
  function setSetting(k, v) {
    if (k.includes(".")) {
      const [a, b] = k.split(".");
      state.settings[a] = { ...(state.settings[a] || {}), [b]: v };
    } else state.settings[k] = v;
    save();
  }

  /* ---------- 导入导出 ---------- */
  /** 是不是本应用的备份文件（而不是随手抓的 JSON）。老名字的备份照样认。 */
  function isBackup(obj) {
    return !!obj && APP_IDS.indexOf(obj.app) >= 0 && Array.isArray(obj.words);
  }
  function exportJSON() {
    return JSON.stringify({ app: "noadic", version: 1, exportedAt: new Date().toISOString(), settings: state.settings, words: state.words }, null, 2);
  }
  function importJSON(text) {
    const p = JSON.parse(text);
    if (!p || !Array.isArray(p.words)) throw new Error("JSON 里找不到 words 数组");
    const cands = p.words.map((w) => ({
      word: w.word, unit: w.unit, senses: w.senses, definition: w.definition,
      phonetic: w.phonetic, collocation: w.collocation, example_en: w.example_en, example_zh: w.example_zh, note: w.note,
      srs: w.srs, status: w.status, weak: !!w.weak, __progress: true, source: "import",
    }));
    // 备份含学习进度：进度更长的以备份为准，本机已练得更多的不被覆盖
    const res = addAll(cands, "merge");
    /* 「背不熟」是用户手打的标记，不能因为去重把它判成"重复忽略"就丢掉：
     * 那条路径根本不走合并，词对象原样留着，标记自然回不来。
     * 所以在导入层按词头补一次 —— 只加不减，重导一份没标记的词表不会把已有标记抹掉。 */
    for (const w of p.words) {
      if (!w || !w.weak || !w.word) continue;
      const hit = indexContext().byAlias.get(Lex.norm(w.word));
      if (hit && !hit.weak) { hit.weak = true; hit.weakAt = w.weakAt || Date.now(); }
    }
    if (p.settings) state.settings = { ...state.settings, ...p.settings, ai: { ...state.settings.ai, ...(p.settings.ai || {}) } }, save();
    save();
    return res;
  }
  function wipe() {
    state.words = []; state.meta = { seeded: true, imports: [] };
    rebuild(); save();
  }

  function usage() {
    const bytes = (localStorage.getItem(KEY) || "").length;
    return { bytes, kb: (bytes / 1024).toFixed(1), words: state.words.length };
  }

  return {
    get words() { return state.words; }, get settings() { return state.settings; }, get meta() { return state.meta; },
    load, save, rebuild, indexContext, byId, stats, units, unitStats, unitKey, wordsOf, unitOrder, seed, backfill, plan, addAll, commitPlan,
    bookWords,                                        // 背诵页要"只背书里的词"，扩展池不该出现在背诵列表
    unitFlags, blockFlags, blockStats, blocks, blockKey, inBlock, wordsOfBlock, resetBlock,
    currentUnit, currentBlock, syncCleared, allCleared, inUnit, gateMet, unclear, resetUnit, labelOrder,
    snapshot, undo, canUndo, update, remove, scopeWords, scopeStats, removeScope, inScope, setSetting, exportJSON, importJSON, isBackup, wipe, usage,
    weakWords, weakCount, toggleWeak, clearWeak,
    DEFAULT_SETTINGS,
  };
})();
if (typeof window !== "undefined") window.Store = Store;
