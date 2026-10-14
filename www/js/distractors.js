/* =========================================================================
 * distractors.js — 干扰项引擎（四级考点：必须形近 / 义近 / 同根，禁止无关干扰项）
 * 候选池 = 用户词库 + 内置易混词池；按 拼写相似度 + 中文义项重叠 + 同词性 打分
 * ========================================================================= */
const Distract = (() => {
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  const zhChars = (s) => new Set(String(s || "").replace(/[^一-龥]/g, "").split(""));
  function zhSim(a, b) {
    const A = zhChars(a), B = zhChars(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((c) => { if (B.has(c)) inter++; });
    return inter / Math.min(A.size, B.size);
  }

  function spellSim(a, b) {
    a = Lex.norm(a); b = Lex.norm(b);
    if (!a || !b) return 0;
    const d = lev(a, b);
    const base = 1 - d / Math.max(a.length, b.length);
    let bonus = 0;
    const pl = [...a].findIndex((c, i) => c !== b[i]);            // 公共前缀长度
    const pre = pl < 0 ? a.length : pl;
    const su = [...a].reverse().findIndex((c, i) => c !== [...b].reverse()[i]);
    const suf = su < 0 ? a.length : su;
    if (pre >= 3) bonus += 0.06 * Math.min(pre - 2, 4);
    if (suf >= 3) bonus += 0.05 * Math.min(suf - 2, 4);
    if (Math.abs(a.length - b.length) <= 2 && d <= 2) bonus += 0.12;   // 一字之差
    if (a[0] === b[0]) bonus += 0.04;
    return Math.min(1, base * 0.75 + bonus);
  }

  let _pool = null;
  function poolWords() {
    if (_pool) return _pool;                       // 记忆化：扩展池的作答进度在本会话内保留
    if (!window.DICT) return [];
    _pool = (DICT.pool || []).map((p) => ({
      id: "pool_" + p.word, word: p.word, aliases: Lex.variantsOf(p.word),
      senses: Lex.sensesFromRaw(p.gloss || ""), definition: p.gloss || "",
      phonetic: p.ph || "", collocation: p.col || "", example_en: p.en || "", example_zh: p.zh || "",
      poly: p.poly || [], unit: "易混池", units: ["易混池"], status: "new", srs: Lex.freshSrs(), enriched: true, pool: true,
    }));
    return _pool;
  }

  /** 全量候选（词库 ∪ 易混池） */
  function bank(includePool) {
    const list = Store.words.slice();
    if (includePool !== false) list.push(...poolWords());
    return list;
  }

  const posOf = (w) => (w.senses && w.senses[0] ? w.senses[0].pos : (w.pos || "")).replace(/\.$/, "");

  /**
   * 为目标词挑选干扰项，返回按混淆度排序的 [{word, score, tags}]
   * tags: 形近 / 同根 / 义近 / 同词性 —— 直接用于【解析与避坑】话术
   */
  function similar(target, opts) {
    opts = opts || {};
    const limit = opts.limit || 12;
    const samePos = opts.samePos !== false;
    const tPos = posOf(target);
    const tDef = target.definition || (target.senses || []).map((s) => s.meaning).join("；");
    const out = [];
    for (const c of bank(true)) {
      if (!c || c.id === target.id) continue;
      if (opts.exclude && opts.exclude.has(c.id)) continue;
      const spell = spellSim(c.word, target.word);
      const mean = zhSim(c.definition || "", tDef);
      const tags = [];
      let score = 0;
      if (spell >= 0.72) { tags.push("形近"); score += spell * 1.5; }
      else if (spell >= 0.6) { tags.push("拼写相近"); score += spell * 0.9; }
      else score += spell * 0.25;
      if (mean >= 0.34) { tags.push("义近"); score += mean * 1.5; }
      else score += mean * 0.35;
      if (samePos && tPos && posOf(c) === tPos) { tags.push("同词性"); score += 0.22; }
      const tp = Lex.norm(target.word), cp = Lex.norm(c.word);
      if (tp.slice(0, 4) === cp.slice(0, 4) && tp !== cp) { tags.push("同词根"); score += 0.3; }
      if (tp.slice(-4) === cp.slice(-4) && tp.length > 5 && tp !== cp) { tags.push("同后缀"); score += 0.26; }
      if (!tags.length) continue;                       // 无关词一律不作干扰项
      out.push({ word: c, score, tags: [...new Set(tags)].slice(0, 3) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  /** 抽 3 个干扰项：偏向高混淆，但保留随机性，避免每次同一套。返回 [{word, tags, score}] */
  function pickThree(target, exclude) {
    const cand = similar(target, { exclude, limit: 12 });
    if (cand.length <= 3) return cand.slice();
    const head = cand.slice(0, 6);
    const chosen = [];
    let spin = 0;
    while (chosen.length < 3 && spin++ < 40) {
      const p = head[Math.floor(Math.random() * Math.min(head.length + 2, cand.length))] || cand[Math.floor(Math.random() * cand.length)];
      if (p && !chosen.some((x) => x.word.id === p.word.id)) chosen.push(p);
    }
    for (const c of cand) { if (chosen.length >= 3) break; if (!chosen.some((x) => x.word.id === c.word.id)) chosen.push(c); }
    return chosen.slice(0, 3);
  }

  /** 义项级干扰项（熟词生义题用）：从别的词里取中文义项 */
  function alienSenses(target, n) {
    const cand = similar(target, { samePos: true, limit: 14 });
    const mySigs = new Set((target.senses || []).map((s) => Lex.clean(s.meaning)));
    const out = [];
    for (const c of cand) {
      for (const s of (c.word.senses || [])) {
        const sig = Lex.clean(s.meaning);
        if (!sig || mySigs.has(sig)) continue;
        if (sig.length > 16) continue;
        if (out.some((o) => Lex.clean(o.text) === sig)) continue;
        out.push({ text: (s.pos ? s.pos + " " : "") + s.meaning, from: c.word, tags: c.tags });
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  return { lev, zhSim, spellSim, similar, pickThree, poolWords, bank, posOf, alienSenses };
})();
if (typeof window !== "undefined") window.Distract = Distract;
