/* =========================================================================
 * lexicon.js — 词形归一 / 别名 / 屈折还原 / 重复判定与合并（去重唯一真源）
 * 设计要点：不反向拆解新词的词元（abuse→abus 这类事故），而是对「库内已有词条」
 * 生成屈折变形表 bySurface，新词若命中某个变形即视为同词。精确拼写优先。
 * ========================================================================= */
const Lex = (() => {
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const clean = (s) => norm(s).replace(/[.,;，；、\s]/g, "");

  /* ---------- 异形词 / 别名 ---------- */
  // 硬别名：来自原文写法（a/b、flavo(u)r、连字符），可显示、可作词条拼写
  function variantsOf(word) {
    const set = new Set();
    const push = (w) => { w = String(w).trim(); if (w) set.add(w); };
    const base = String(word || "").trim();
    push(base);
    base.split("/").forEach((p) => {
      push(p);
      const m = p.match(/^(.*)\((.)\)(.*)$/); // flavo(u)r → flavour / flavor
      if (m) { push(m[1] + m[2] + m[3]); push(m[1] + m[3]); }
    });
    [...set].forEach((w) => { if (w.includes("-")) push(w.replace(/-/g, " ")); });
    return [...set];
  }
  // 软别名：英美后缀推测，仅用于查重匹配，绝不写进词条、绝不影响显示
  // （pour→por、more→morer 这类误判因此不会污染数据，最多让一个不存在的拼法指向本词）
  function softVariants(word) {
    const out = new Set();
    variantsOf(word).forEach((w) => {
      const lw = norm(w);
      if (/our$/.test(lw)) out.add(lw.replace(/our$/, "or"));
      if (/[^aeiou]re$/.test(lw)) out.add(lw.replace(/re$/, "er"));
      if (/ise$/.test(lw) && lw.length > 5) out.add(lw.replace(/ise$/, "ize"));
      if (/ised$/.test(lw)) out.add(lw.replace(/ised$/, "ized"));
      if (/isation$/.test(lw)) out.add(lw.replace(/isation$/, "ization"));
      if (/aesthesia$|oedema|manoeuvre|ence$.*/.test(lw)) { /* 保守：不扩展 */ }
    });
    return [...out].filter((w) => !variantsOf(word).some((v) => norm(v) === w));
  }
  const allLookupKeys = (word) => [...new Set([...variantsOf(word), ...softVariants(word)].map(norm))];

  /* ---------- 屈折变形（从原形生成，供匹配用） ---------- */
  const IRREG = {
    grind: ["grinds", "grinding", "ground"],
    thrust: ["thrusts", "thrusting"],
    sting: ["stings", "stinging", "stung"],
    cling: ["clings", "clinging", "clung"],
    spoil: ["spoils", "spoiling", "spoilt"],
    seek: ["seeks", "seeking", "sought"],
    rebuild: ["rebuilt"], sink: ["sank", "sunk"],
    swing: ["swung"], weave: ["wove", "woven"], flee: ["fled"],
    stick: ["stuck"], bite: ["bit", "bitten"], ride: ["rode", "ridden"],
    write: ["wrote", "written"], arise: ["arose", "arisen"],
    lie: ["lies", "lying", "lay", "lain"], lie_: ["lied"],
    die: ["dies", "dying", "died"],
  };
  const VOW = /[aeiou]/;
  const consY = (w) => w.length > 2 && /[^aeiou]y$/.test(w);
  const dbl = (w) => /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(w); // 重读闭音节近似

  function inflect(word) {
    const w = norm(word), out = new Set([w]);
    if (IRREG[w]) IRREG[w].forEach((f) => out.add(f));
    if (w.length < 3) return [...out];
    const add = (s) => { if (s && s.length > 1) out.add(s); };
    // 三单 / 复数
    if (/[sxz]$|ch$|sh$|o$/.test(w)) add(w + "es");
    else if (consY(w)) add(w.slice(0, -1) + "ies");
    else add(w + "s");
    // 过去式 / 过去分词
    if (/e$/.test(w)) { add(w + "d"); }
    else if (consY(w)) { add(w.slice(0, -1) + "ed"); }
    else { add(w + "ed"); if (dbl(w)) add(w + w.slice(-1) + "ed"); }
    // 现在分词
    if (/e$/.test(w)) { add(w.replace(/e$/, "") + "ing"); add(w + "ing"); }
    else { add(w + "ing"); if (dbl(w)) add(w + w.slice(-1) + "ing"); }
    // 比较级
    if (/e$/.test(w)) add(w + "r");
    else { add(w + "er"); add(w + "est"); if (dbl(w)) { add(w + w.slice(-1) + "er"); add(w + w.slice(-1) + "est"); } }
    if (consY(w)) { add(w.slice(0, -1) + "ier"); add(w.slice(0, -1) + "iest"); }
    return [...out];
  }

  /* ---------- 释义签名（判断是否「完全重复」） ---------- */
  const POS_RE = /\b(n|v|adj|adv|prep|conj|pron|num|int|art|aux|abbr|a|ad)\./gi;
  function defSig(senses) {
    return (senses || [])
      .map((s) => `${(s.pos || "").replace(/\.$/, "")}|${clean(s.meaning)}`)
      .sort().join("#");
  }
  function sensesFromRaw(raw) {
    raw = String(raw || "").trim();
    if (!raw) return [];
    const marks = [];
    let m; POS_RE.lastIndex = 0;
    while ((m = POS_RE.exec(raw))) marks.push({ at: m.index, label: m[0], end: POS_RE.lastIndex });
    let senses = [];
    if (!marks.length) senses = [{ pos: "", meaning: raw }];
    else {
      for (let i = 0; i < marks.length; i++) {
        const start = marks[i].end;
        const stop = i + 1 < marks.length ? marks[i + 1].at : raw.length;
        senses.push({ pos: marks[i].label.toLowerCase(), meaning: raw.slice(start, stop).trim().replace(/[，,;\s]+$/, "") });
      }
    }
    // "n. & v. 离婚；分离"：& 型合并词性，两个词性共享同一释义
    const merged = [];
    for (let i = 0; i < senses.length; i++) {
      const cur = senses[i];
      if (/^[&/、]$/.test(cur.meaning) && i + 1 < senses.length) {
        const nxt = senses[i + 1];
        merged.push({ pos: cur.pos, meaning: nxt.meaning });
        merged.push({ pos: nxt.pos, meaning: nxt.meaning });
        i++;
      } else merged.push(cur);
    }
    return merged.filter((s) => s.meaning);
  }
  function posSummary(senses) {
    const ps = [...new Set((senses || []).map((s) => s.pos).filter(Boolean))];
    return ps.join("、");
  }

  /* ---------- 义项择优 / 合并 ---------- */
  function betterMeaning(a, b) {
    const ca = clean(a), cb = clean(b);
    if (!ca) return b; if (!cb) return a;
    if (ca === cb) return a;
    if (cb.includes(ca)) return b;      // "领域" ⊂ "领域，场所；王国" → 取长者
    if (ca.includes(cb)) return a;
    return null;                         // 真正不同的义项，都保留
  }
  function mergeSenses(a, b) {
    const out = [];
    (a || []).forEach((s) => out.push({ ...s }));
    (b || []).forEach((inc) => {
      const same = out.filter((o) => (o.pos || "") === (inc.pos || ""));
      let consumed = false;
      for (const o of same) {
        const best = betterMeaning(o.meaning, inc.meaning);
        if (best) { o.meaning = best; consumed = true; break; }
      }
      if (!consumed && !same.some((o) => clean(o.meaning) === clean(inc.meaning))) {
        out.push({ ...inc });
      }
    });
    return out;
  }

  /* ---------- 词条工厂 ---------- */
  const uid = (word) => "w_" + clean(variantsOf(word)[0] || word).replace(/[^a-z0-9]/g, "") + "_" + Math.random().toString(36).slice(2, 6);
  function freshSrs() {
    return { seen: 0, correct: 0, wrong: 0, correctTypes: [], askedTypes: [], lastType: "", weight: 0, lastAt: 0, wrongReason: "", history: [], masteredAt: 0 };
  }
  function makeWord(cand, source) {
    const senses = cand.senses && cand.senses.length ? cand.senses : sensesFromRaw(cand.definition || cand.definition_raw);
    const vs = variantsOf(cand.word);
    const w = {
      id: cand.id || uid(cand.word),
      word: String(cand.word).trim(),
      aliases: vs,
      key: norm(vs[0]),
      unit: cand.unit || "",
      lesson: cand.lesson || "",
      units: cand.unit ? [cand.unit] : [],
      senses,
      pos: cand.pos || posSummary(senses),
      definition: cand.definition || (cand.definition_raw || senses.map((s) => `${s.pos} ${s.meaning}`).join(" ")).trim(),
      defSig: defSig(senses),
      phonetic: cand.phonetic || "",
      collocation: cand.collocation || "",
      example_en: cand.example_en || "",
      example_zh: cand.example_zh || "",
      note: cand.note || "",
      enriched: !!(cand.phonetic && cand.example_en),
      source: source || cand.source || "import",
      status: "new",
      srs: freshSrs(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // 备份回灌可携带进度（普通词表导入不含 srs 字段，因此绝不会因导入而改变进度）
    if (cand.__progress && cand.srs) { w.srs = { ...freshSrs(), ...cand.srs }; w.status = cand.status || "new"; }
    // 「背不熟」是用户手动标记，只在带回进度的通道（备份回灌）里认，普通词表里没这个字段
    if (cand.__progress && cand.weak) { w.weak = true; w.weakAt = cand.weakAt || Date.now(); }
    return w;
  }

  /* ---------- 入库计划（去重决策）---------- */
  // ctx: { bySurface:Map, byAlias:Map, bySoft:Map, words:Map(id→word) }
  function register(ctx, w) {
    if (!ctx.bySoft) ctx.bySoft = new Map();
    variantsOf(w.word).forEach((v) => { const k = norm(v); if (k && !ctx.byAlias.has(k)) ctx.byAlias.set(k, w); });
    softVariants(w.word).forEach((k) => { if (k && !ctx.byAlias.has(k) && !ctx.bySoft.has(k)) ctx.bySoft.set(k, w); });
    return ctx;
  }
  function locate(ctx, candWord) {
    for (const s of variantsOf(candWord)) {
      const hit = ctx.byAlias.get(norm(s));
      if (hit) return { word: hit, via: "exact" };
    }
    for (const s of variantsOf(candWord)) {
      const hit = ctx.bySoft && ctx.bySoft.get(norm(s));
      if (hit) return { word: hit, via: "variant" };
    }
    for (const s of variantsOf(candWord)) {
      const via = ctx.bySurface.get(norm(s));
      if (via) return { word: via, via: "inflect" };
    }
    return null;
  }

  /**
   * 生成入库计划：每条候选标注 new / merge / dup，并给出人类可读原因。
   * strategy: 'merge' | 'skip' | 'overwrite'
   * 同批内自我重复也会折叠（action='dupBatch'）。
   */
  function planBatch(cands, store, strategy) {
    const rows = [];
    const seenBatch = new Map();
    const base = store.indexContext();
    // 克隆索引：plan() 是 dry-run，不能污染已入库的正式索引
    const ctx = {
      byAlias: new Map(base.byAlias),
      bySurface: new Map(base.bySurface),
      bySoft: new Map(base.bySoft || []),
      byId: base.byId,
    };
    for (const c of cands) {
      const cand = { ...c };
      if (!cand.senses || !cand.senses.length) cand.senses = sensesFromRaw(cand.definition || cand.definition_raw);
      cand.definition = cand.definition || (cand.senses.map((s) => `${s.pos} ${s.meaning}`.trim()).join(" "));
      const hit = locate(ctx, cand.word);
      if (!hit) {
        const batchKey = norm(variantsOf(cand.word)[0]);
        if (seenBatch.has(batchKey)) {
          const prev = rows[seenBatch.get(batchKey)];
          prev.batchDup = (prev.batchDup || 0) + 1;
          prev.merged.senses = mergeSenses(prev.merged.senses, cand.senses);
          prev.merged.defSig = defSig(prev.merged.senses);
          rows.push({ cand, action: "dupBatch", reason: `与同批「${prev.merged.word}」重复，已折叠`, merged: prev.merged });
          continue;
        }
        const w = makeWord(cand, cand.source || "import");
        seenBatch.set(batchKey, rows.length);
        register(ctx, w);   // 让同批后续也能查到，实现批内自我折叠
        rows.push({ cand, action: "new", reason: cand.unit || "新增词条", merged: w });
        continue;
      }
      const ex = hit.word;
      const sig = defSig(cand.senses);
      const reasons = [];
      if (hit.via === "inflect") reasons.push(`词形还原：${cand.word} → ${ex.word}`);
      else if (hit.via === "variant") reasons.push(`英美异形：${cand.word} = ${ex.word}`);
      if ((cand.unit || "") !== (ex.unit || "") && cand.unit && ex.unit) reasons.push(`已见于 ${ex.units.join("/")}`);
      if (sig === ex.defSig) {
        rows.push({ cand, action: "dup", reason: reasons.join("；") || "拼写与释义完全一致，跳过", merged: ex, target: ex.id });
        continue;
      }
      rows.push({
        cand, action: "merge", target: ex.id,
        reason: (reasons.join("；") || "释义有差异") + (strategy === "overwrite" ? " → 覆盖" : " → 合并义项"),
        merged: mergeInto(ex, cand, strategy),
      });
    }
    const summary = { new: 0, merge: 0, dup: 0, dupBatch: 0 };
    rows.forEach((r) => summary[r.action]++);
    return { rows, summary, strategy };
  }

  /** 词的层级标签：Unit 1 · Lesson 2（无课次时就是 Unit 1，向后兼容旧数据） */
  const blockOf = (w) => [w && w.unit, w && w.lesson].filter(Boolean).join(" · ") || "未分组";
  const unitOf = (w) => (w && w.unit) || "未分组";

  /** 合并：只动内容字段，srs/status/createdAt 一律保留 */
  function mergeInto(ex, cand, strategy) {
    const keep = { ...ex, srs: ex.srs, status: ex.status, createdAt: ex.createdAt, units: [...new Set([...(ex.units || (ex.unit ? [ex.unit] : [])), ...(cand.unit ? [cand.unit] : [])])] };
    const incomingSenses = cand.senses && cand.senses.length ? cand.senses : sensesFromRaw(cand.definition);
    keep.senses = strategy === "overwrite" ? incomingSenses.slice() : mergeSenses(ex.senses, incomingSenses);
    keep.defSig = defSig(keep.senses);
    keep.definition = keep.senses.map((s) => `${s.pos} ${s.meaning}`.trim()).join(" ");
    keep.pos = posSummary(keep.senses);
    keep.unit = ex.unit || cand.unit || "";
    // 层级补录：已有归属不覆盖（避免重导入把词挪到别的课次），只补空缺
    keep.lesson = ex.lesson || cand.lesson || "";
    keep.blocks = [...new Set([...(ex.blocks || []), ...(cand.unit || cand.lesson ? [blockOf(cand)] : [])])];
    const fillIfEmpty = (f, v) => { if (v && (strategy === "overwrite" ? true : !keep[f])) keep[f] = v; };
    fillIfEmpty("phonetic", cand.phonetic);
    fillIfEmpty("collocation", cand.collocation);
    fillIfEmpty("example_en", cand.example_en);
    fillIfEmpty("example_zh", cand.example_zh);
    fillIfEmpty("note", cand.note);
    keep.aliases = [...new Set([...(ex.aliases || []), ...variantsOf(cand.word)])];
    keep.enriched = !!(keep.phonetic && keep.example_en);
    keep.source = ex.source === "manual" ? "manual" : (cand.source || ex.source);
    keep.updatedAt = Date.now();
    // 进度不因重复导入被重置；例外：备份回灌(__progress)且备份历史更长时，以备份为准
    keep.status = ex.status;
    if (cand.__progress && cand.srs && (cand.srs.seen || 0) > ((ex.srs && ex.srs.seen) || 0)) {
      keep.srs = { ...freshSrs(), ...cand.srs };
      keep.status = cand.status || ex.status;
    }
    return keep;
  }

  return { norm, clean, variantsOf, softVariants, allLookupKeys, register, inflect, defSig, sensesFromRaw, posSummary, mergeSenses, betterMeaning, makeWord, freshSrs, locate, planBatch, mergeInto, uid, blockOf, unitOf };
})();
if (typeof window !== "undefined") window.Lex = Lex;
