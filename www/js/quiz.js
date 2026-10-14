/* =========================================================================
 * quiz.js — Mode 2 考核引擎
 * 题型：e2c 英译中 / c2e 中译英 / cloze 语境填空 / poly 熟词生义 / dictation 听音拼写
 * 规则：错题立即入本并记混淆原因 → 加权高频复现 + 强制换题型 → 2 次不同题型答对才判「已掌握」
 * ========================================================================= */
const Quiz = (() => {
  const TYPES = {
    e2c: "四选一 · 英译中",
    c2e: "四选一 · 中译英",
    cloze: "语境填空",
    poly: "熟词生义",
    dictation: "听音拼写",
  };
  const rnd = Math.random;
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  let session = { scope: "all", wrongOnly: false, asked: 0, right: 0, current: null, count: 0, cool: new Map(), lastTypes: [], dailyCap: 0, pinId: null, revisit: [] };

  /* ---------- 工具 ---------- */
  const srs = (w) => (w.srs || (w.srs = Lex.freshSrs()));
  const primaryPos = (w) => (w.senses && w.senses[0] && w.senses[0].pos) || w.pos || "";
  const shortDef = (w, max) => {
    const txt = (w.senses || []).map((s) => (s.pos ? s.pos + " " : "") + s.meaning).join("；");
    max = max || 34;
    return txt.length > max ? txt.slice(0, max - 1) + "…" : txt;
  };
  const maskedDef = (w) => {
    // 只露首义，用于「熟词生义」题干
    const s = (w.senses || [])[0];
    return s ? (s.pos ? s.pos + " " : "") + s.meaning : w.definition;
  };

  /** 在例句里定位该词（含屈折/异形），返回 {surface, index, len} */
  function findSurface(word, sentence) {
    if (!sentence) return null;
    const spellings = [];
    Lex.variantsOf(word.word).forEach((v) => {
      spellings.push(v);
      Lex.inflect(v).forEach((f) => spellings.push(f));
    });
    spellings.sort((a, b) => b.length - a.length);
    for (const s of spellings) {
      const esc = String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\((.)\)/g, "$1?");
      const re = new RegExp("(?<![A-Za-z])" + esc + "(?![A-Za-z])", "i");
      const m = sentence.match(re);
      if (m) return { surface: m[0], index: m.index, len: m[0].length };
    }
    return null;
  }

  const has = (w, f) => !!(w && w[f]);
  const okSentence = (w) => w && w.example_en && findSurface(w, w.example_en);

  /* ---------- 可出题性判定（带缓存：similar() 是 O(词库×池) 的重活） ---------- */
  let eligMemo = new Map();
  function eligibleRaw(w, type) {
    if (!w) return false;
    const hasMeaning = !!(w.definition && /[一-龥]/.test(w.definition));
    switch (type) {
      case "e2c": return hasMeaning && Distract.similar(w, { limit: 3 }).length >= 3;
      case "c2e": return hasMeaning;
      case "cloze": return !!okSentence(w) && hasMeaning;
      case "poly": return hasMeaning && ((w.senses || []).length >= 2 || (DICT && DICT.enrich[Lex.norm(w.word)] && DICT.enrich[Lex.norm(w.word)].poly));
      case "dictation": return has(w, "phonetic") && hasMeaning;
      default: return false;
    }
  }
  function eligible(w, type) {
    if (!w) return false;
    const key = w.id + "|" + type + "|" + (w.updatedAt || 0) + "|" + Store.words.length + "|" + (Store.settings.usePool ? 1 : 0);
    if (eligMemo.has(key)) return eligMemo.get(key);
    const v = eligibleRaw(w, type);
    if (eligMemo.size > 6000) eligMemo.clear();
    eligMemo.set(key, v);
    return v;
  }
  const invalidateEligible = () => { eligMemo.clear(); };

  function enabledTypes() {
    // 专项模式：只出用户点选的那一种题型；混合模式：按设置里勾选的题型集合轮换（保持原方案）
    const p = Store.settings.plan || "mixed";
    if (p !== "mixed" && TYPES[p]) return [p];
    return Object.keys(TYPES).filter((t) => Store.settings.types[t] !== false);
  }
  const currentPlan = () => Store.settings.plan || "mixed";

  /** 题型选择：错题强制换题型；整体避免连续同型 */
  function typesFor(w) {
    let list = enabledTypes().filter((t) => eligible(w, t));
    if (!list.length) return [];
    if (w.status === "wrong" && srs(w).lastType) {
      const alt = list.filter((t) => t !== srs(w).lastType);
      if (alt.length) list = alt;                        // 交叉复习：必须更换题型
    }
    const last = session.lastTypes[session.lastTypes.length - 1];
    if (list.length > 1 && last) {
      const varied = list.filter((t) => t !== last);
      if (varied.length) list = varied;
    }
    return list;
  }

  /* ---------- 调度权重 ---------- */
  function priority(w, orderIdx) {
    const s = srs(w);
    if (session.wrongOnly) return w.status === "wrong" ? 2000 + s.wrong * 90 : 500 + s.wrong * 90;
    switch (w.status) {
      case "wrong":
        return 1200 + s.wrong * 90 + Math.min(150, (Date.now() - (s.lastAt || 0)) / 3.6e6 * 12) + rnd() * 40;
      case "learning":
        return 620 + (s.correctTypes.length >= 1 ? 40 : 0) + rnd() * 40;
      case "mastered":
        return -400 + rnd() * 220;                       // 低概率回炉抽查
      default:
        return 900 - (orderIdx || 0) * 0.8 + rnd() * 30;  // 待测按录入顺序推进
    }
  }

  /** 范围匹配：既接受单元名（含其下全部课次），也接受课次块名 "Unit 1 · Lesson 2" */
  const matchScope = (w, label) => !label ? true : (Store.inBlock(w, label) || Store.inUnit(w, label));

  function scopeWords() {
    const base = Store.words.filter((w) => !w.pool);
    const list = Store.settings.usePool ? base.concat(Distract.poolWords()) : base;
    if (session.wrongOnly) return list.filter((w) => w.status === "wrong" || w.status === "learning");
    if (Store.settings.mode === "sequence") {
      const cur = session.override || Store.currentBlock();
      if (!cur) return list;                                  // 全书通关 → 不再限制（自由回看）
      const inCur = list.filter((w) => matchScope(w, cur));
      if (Store.settings.carryWrong === false && !session.override) return inCur;
      // 已通关块里回潮的错题继续插队复习，不会烂在身后
      const stray = list.filter((w) => w.status === "wrong" && inCur.indexOf(w) < 0);
      return inCur.concat(stray);
    }
    if (session.override) return list.filter((w) => matchScope(w, session.override));
    if (session.scope === "unmastered") return list.filter((w) => w.status !== "mastered");
    if (session.scope && session.scope !== "all") return list.filter((w) => matchScope(w, session.scope));
    return list;
  }

  /** 冷却窗口：错题仍高频，但不至于把新词完全挤掉 */
  function cooling(w) {
    const until = session.cool.get(w.id);
    return until != null && until > session.count;
  }
  function coolFor(w) {
    return w.status === "wrong" ? 4 : w.status === "mastered" ? 10 : 6;
  }

  /** 选词：错题高频复现（插队），新词严格按书的排列顺序引入（不打乱） */
  function pickWord() {
    const list = scopeWords();
    if (!list.length) return null;
    const order = new Map();
    Store.words.forEach((w, i) => order.set(w.id, i));
    const ready = (arr) => arr.filter((w) => !cooling(w) && typesFor(w).length);
    // 被跳过的词优先回来（LRU 会把刚跳过的排到最后，与"待会儿再考"的意图相反）
    if (session.revisit && session.revisit.length) {
      const hit = session.revisit.find((id) => list.some((w) => w.id === id) && !cooling(list.find((w) => w.id === id)) && typesFor(list.find((w) => w.id === id)).length);
      if (hit) {
        session.revisit = session.revisit.filter((x) => x !== hit);
        const w = list.find((x) => x.id === hit);
        if (w) return w;
      }
      session.revisit = session.revisit.filter((id) => list.some((w) => w.id === id));   // 换范围后清掉失效项
    }
    const reviewPool = list.filter((w) => w.status === "wrong" || w.status === "learning");
    const freshPool = list.filter((w) => w.status === "new");
    const share = Store.settings.reviewShare == null ? 0.7 : Store.settings.reviewShare;
    let wantReview = session.wrongOnly ? true : !reviewPool.length ? false : !freshPool.length ? true : rnd() < share;

    if (!wantReview) {
      const next = ready(freshPool).sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0))[0];
      if (next) return next;                              // 书序指针：下一个没测的词
      wantReview = true;
    }
    // 复习槽位：轮转（最久没考的先用），避免「错得越多被抽得越狠」把书序卡死
    const rv = ready(reviewPool).sort((a, b) => {
      const ca = session.cool.get(a.id) || 0, cb = session.cool.get(b.id) || 0;
      if (ca !== cb) return ca - cb;                      // 越早解除冷却越优先
      return priority(b, order.get(b.id)) - priority(a, order.get(a.id));
    });
    if (rv.length) return rv[0];
    let pool = ready(freshPool);
    if (!pool.length) pool = list.filter((w) => typesFor(w).length);
    if (!pool.length) pool = list.slice();
    if (!pool.length) return null;
    const fresh = pool.filter((w) => w.status === "new").sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
    if (fresh.length) return fresh[0];
    let best = null, bestP = -Infinity;
    for (const w of pool) { const p = priority(w, order.get(w.id)); if (p > bestP) { bestP = p; best = w; } }
    return best || pool[0];
  }

  /** 书上进度指针：按词库顺序（＝书的排列顺序）找第一个还没测到的词 */
  function bookmark() {
    const list = Store.words.filter((w) => !w.pool);
    const next = list.find((w) => w.status === "new");
    const done = list.filter((w) => w.status !== "new").length;
    return { total: list.length, done, nextWord: next ? next.word : null, unit: next ? (next.unit || (next.units || [])[0] || "") : "" };
  }

  /* ---------- 出题 ---------- */
  const KEYS = ["A", "B", "C", "D"];

  function optionSet(target, correctText, distractors, tagKey) {
    const items = [{ text: correctText, isKey: true, word: target, tags: [] }];
    const seen = new Set([target.id]);
    const texts = new Set([correctText]);
    const push = (w, tags) => {
      if (!w || seen.has(w.id)) return false;
      const txt = tagKey === "def" ? shortDef(w) : w.word;
      if (!txt || texts.has(txt)) return false;
      seen.add(w.id); texts.add(txt);
      items.push({ text: txt, isKey: false, word: w, tags: tags || [] });
      return true;
    };
    (distractors || []).forEach((d) => d && push(d.word, d.tags));
    let guard = 0;
    while (items.length < 4 && guard++ < 8) {
      const cand = Distract.similar(target, { limit: 14, exclude: seen });
      if (!cand.length) break;
      for (const c of cand) { if (items.length >= 4) break; push(c.word, c.tags); }
    }
    return shuffle(items).map((o, i) => ({ ...o, key: KEYS[i] }));
  }

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function pointOf(w, type) {
    const pos = primaryPos(w);
    const bits = [];
    if (pos) bits.push(`词性 ${pos}`);
    if (w.phonetic) bits.push(`音标 ${w.phonetic}`);
    if (w.collocation) bits.push(`高频搭配 ${w.collocation}`);
    if ((w.senses || []).length > 1) bits.push(`多词性串考（${w.pos}），四级常只考后一个义项`);
    if (/u\/U|\(|-|\//.test(w.word)) bits.push(`异形拼写：${Lex.variantsOf(w.word).join(" = ")}`);
    const t = { e2c: "阅读中靠中文义项快速定位", c2e: "听力与完形的拼写再认", cloze: "写作与完形的词形变换", poly: "熟词生义（只记一义最容易失分）", dictation: "拼写还原，听力/翻译题的失分重灾区" }[type];
    if (t) bits.push(t);
    return bits.join(" ｜ ");
  }

  function build(w, type) {
    const q = {
      type, label: TYPES[type], wordId: w.id, word: w, answered: false,
      front: w.word, ipa: w.phonetic || "", sub: "", stem: "", options: null, input: null,
      answer: "", answerHtml: "", accept: [], point: pointOf(w, type),
    };
    q.example = { en: w.example_en || "", zh: w.example_zh || "" };

    if (type === "e2c") {
      const dis = Distract.pickThree(w);
      q.stem = `选出下列单词最贴切的四级释义：<b class="qword-inline">${w.word}</b>`;
      q.options = optionSet(w, w.definition || shortDef(w), dis, "def");
      q.answer = q.options.find((o) => o.isKey).text;
      q.check = (i) => {
        const o = q.options.find((x) => x.key === i);
        return { ok: !!(o && o.isKey), chose: o };
      };
    } else if (type === "c2e") {
      const dis = Distract.pickThree(w);
      q.stem = `下列哪个单词的意思是：<b>${w.definition}</b>`;
      q.options = optionSet(w, w.word, dis, "word");
      q.answer = w.word;
      q.accept = Lex.allLookupKeys(w.word);
      q.check = (i) => {
        const o = q.options.find((x) => x.key === i);
        return { ok: !!(o && o.isKey), chose: o };
      };
    } else if (type === "cloze") {
      const hit = findSurface(w, w.example_en);
      if (!hit) return null;                              // 例句里找不到可挖的空 → 不出该型
      const stem = w.example_en.slice(0, hit.index) + '<span class="qblank"> ' + "＿".repeat(Math.max(4, Math.min(12, hit.surface.length))) + ' </span>' + w.example_en.slice(hit.index + hit.len);
      const base = Lex.norm(w.word);
      const needForm = Lex.norm(hit.surface) !== base;
      q.stem = stem;
      q.sub = needForm ? `用 <b>${w.word}</b> 的<strong>适当形式</strong>填空（注意时态/语态/词形变换）` : `填入恰当的单词：<b>${w.word}</b>`;
      q.answer = hit.surface;
      q.accept = [Lex.norm(hit.surface)];
      q.input = { placeholder: needForm ? "正确形式的单词…" : "单词拼写…", hint: `首字母 ${hit.surface[0].toUpperCase()} · 共 ${hit.surface.length} 个字母` };
      q.answerHtml = `<b>${hit.surface}</b>${needForm ? `　<span class="tag warn">词形变换：原形 ${w.word} → ${hit.surface}</span>` : ""}`;
      q.check = (i) => {
        const v = Lex.norm(i), bare = v.replace(/[^a-z'’\-\/() ]/g, "");
        const ok = q.accept.includes(v) || q.accept.includes(bare);
        const baseOk = Lex.variantsOf(w.word).some((a) => Lex.norm(a) === v);
        return { ok, note: !ok && baseOk ? `只写了原形 ${w.word}，句中要求的是 <b>${hit.surface}</b>` : "" };
      };
    } else if (type === "poly") {
      const info = DICT && DICT.enrich[Lex.norm(w.word)];
      const polyCtx = info && info.poly && info.poly.length ? pick(info.poly) : null;
      const targetSense = (w.senses || []).length > 1 ? w.senses[w.senses.length - 1] : null;
      const aliens = Distract.alienSenses(w, 3);
      const senseText = (s) => (s.pos ? s.pos + " " : "") + s.meaning;
      if (polyCtx) {
        q.stem = `<b class="qword-inline">${w.word}</b> 在下句中的含义是：　“${polyCtx.ctx}”`;
        q.sub = `熟词生义：别用你最先想到的那个意思作答`;
        const items = [{ text: polyCtx.m, isKey: true, word: w, tags: [] }, ...aliens.map((a) => ({ text: a.text, isKey: false, word: a.from, tags: a.tags }))];
        q.options = shuffle(items).slice(0, 4).map((o, i) => ({ ...o, key: KEYS[i] }));
        q.answer = polyCtx.m;
        q.whyTarget = polyCtx.m;
      } else if (targetSense) {
        q.stem = `<b class="qword-inline">${w.word}</b> 你已知它的意思是「${maskedDef(w)}」，那么它<strong>还有</strong>下列哪个含义？`;
        q.sub = "熟词生义补全：四级阅读常在第二、三个义项上设坑";
        const items = [{ text: senseText(targetSense), isKey: true, word: w, tags: [] }, ...aliens.map((a) => ({ text: a.text, isKey: false, word: a.from, tags: a.tags }))];
        q.options = shuffle(items).slice(0, 4).map((o, i) => ({ ...o, key: KEYS[i] }));
        q.answer = senseText(targetSense);
        q.whyTarget = senseText(targetSense);
      } else return null;
      q.check = (i) => {
        const o = q.options.find((x) => x.key === i);
        return { ok: !!(o && o.isKey), chose: o };
      };
    } else if (type === "dictation") {
      if (!w.phonetic) return null;                       // 无音标无法听写
      q.stem = `根据音标与中文提示，写出单词。`;
      q.sub = `音标 <b class="mono">${w.phonetic}</b>　·　释义 <b>${w.definition}</b>`;
      if (w.collocation) q.sub += `　·　搭配 <b>${w.collocation}</b>`;
      q.answer = w.word;
      q.accept = [...new Set(Lex.variantsOf(w.word).map(Lex.norm).concat(Lex.allLookupKeys(w.word).map(Lex.norm)))];
      q.input = { placeholder: "拼写…", hint: `${q.accept[0].replace(/[^a-z]/g, "").length} 个字母左右` };
      q.answerHtml = `<b>${w.word}</b>`;
      q.check = (i) => { const v = Lex.norm(i).replace(/[^a-z'’\-\/() ]/g, ""); return { ok: q.accept.includes(v), gave: v }; };
    }
    q.stats = () => { const s = srs(w); return `${TYPES[type]}｜已考 ${s.seen} 次，错 ${s.wrong} 次`; };
    return q;
  }

  function arm(q, w) {
    session.count++;
    session.cool.set(w.id, session.count + coolFor(w));
    session.current = q;
    session.lastTypes.push(q.type);
    session.lastTypes = session.lastTypes.slice(-2);
    if (session.cool.size > 4000) {                       // 防止长时间会话里 Map 无限增长
      for (const [k, v] of session.cool) if (v <= session.count) session.cool.delete(k);
    }
  }

  function next() {
    if (Store.words.length < 4) return { empty: "词库至少需要 4 个词才能出题，请先去「录入」导入词表。" };
    if (session.pendingGate) return { gate: session.pendingGate };
    if (Store.settings.mode === "sequence" && Store.allCleared()) {
      return { done: "全书单元均已通关 🎉 可以回看任意单元巩固，或在「设置」里关闭顺序模式自由混合出题。" };
    }
    const cap = Store.settings.daily || 20;
    if (session.dailyCap >= cap) return { done: `本轮已完成 ${cap} 题，正确率 ${Math.round((session.right / Math.max(1, session.asked)) * 100)}%。可点「重开一轮」继续。` };
    /* 锁定题（错题本「立刻重考」）：仍按规则强制更换题型 */
    if (session.pinId) {
      const id = session.pinId; session.pinId = null;
      const w = Store.byId(id) || (Store.settings.usePool ? Distract.poolWords().find((x) => x.id === id) : null);
      if (w) {
        const ts = typesFor(w);
        const q = ts.length ? build(w, pick(ts)) : null;
        if (q) { arm(q, w); return { question: q }; }
      }
    }
    let q = null, guard = 0;
    while (!q && guard++ < 60) {
      const w = pickWord();
      if (!w) break;
      const ts = typesFor(w);
      if (!ts.length) { session.count++; session.cool.set(w.id, session.count + 3); continue; }
      q = build(w, pick(ts));
      if (!q) { session.count++; session.cool.set(w.id, session.count + 3); }
      else arm(q, w);
    }
    if (!q) return { empty: "当前范围内没有可出的题：请检查题型开关，或先给词条补音标/例句（设置里开 AI 补全）。" };
    return { question: q };
  }

  /** 跳过当前题（滑动切题时未作答即算跳过）：不计对错的、不判错、不碰掌握进度，只让它稍后回来 */
  function skip() {
    const q = session.current;
    if (!q || q.answered) return null;
    q.answered = true;
    q.skipped = true;
    const s = srs(q.word);
    s.skips = (s.skips || 0) + 1;
    s.lastType = s.lastType || "";                    // 跳过不算考过该题型，换题型约束不受影响
    session.cool.set(q.word.id, session.count);        // 立即可被再抽
    session.revisit = session.revisit || [];
    if (session.revisit.indexOf(q.wordId) < 0) session.revisit.push(q.wordId);
    Store.save();
    return { word: q.word.word, type: q.type };
  }

  /* ---------- 作答与状态机 ---------- */
  function submit(input) {
    const q = session.current;
    if (!q || q.answered) return null;
    const r = q.check(input);
    q.answered = true;
    q.given = input;
    const w = q.word, s = srs(w);
    s.seen++; s.lastType = q.type; s.lastAt = Date.now();
    if (!s.askedTypes.includes(q.type)) s.askedTypes.push(q.type);
    s.history = s.history || [];
    s.history.unshift({ ts: Date.now(), type: q.type, ok: !!r.ok, gave: typeof input === "string" ? input : (input || "") });
    s.history = s.history.slice(0, 12);

    if (r.ok) {
      s.correct++;
      if (!s.correctTypes.includes(q.type)) s.correctTypes.push(q.type);
      if (s.correctTypes.length >= 2) { w.status = "mastered"; s.masteredAt = Date.now(); s.weight = 0; }
      else w.status = "learning";
      if (w.status === "mastered") s.wrongReason = "";
      s.weight = Math.max(0, (s.weight || 0) - 25);
    } else {
      s.wrong++;
      w.status = "wrong";
      s.correctTypes = [];                     // 错题重置：需重新在 2 种不同题型上答对
      s.weight = (s.weight || 0) + 40;
      s.wrongReason = reasonFor(q, r);
    }
    Store.save();
    session.asked++; session.dailyCap++;
    if (r.ok) session.right++;
    const fb = feedback(q, r);
    fb.cleared = Store.syncCleared();                                  // 本轮答完是否有单元刚好达标
    if (fb.cleared.length && Store.settings.autoAdvance === false) {
      session.pendingGate = fb.cleared[fb.cleared.length - 1];         // 暂停在单元边界等用户确认
    }
    return fb;
  }

  /** 混淆原因（错题本要写清「怎么错的」） */
  function reasonFor(q, r) {
    const w = q.word;
    if (q.type === "cloze" && r.note) return "词形未变换：" + r.note;
    if (q.type === "dictation") {
      const gave = Lex.norm(r.gave || ""), want = Lex.norm(w.word);
      const d = Distract.lev(gave, want);
      return `拼写错误（相差 ${d} 个字母）：你写「${r.gave || "空"}」，应为「${w.word}」`;
    }
    if (r.chose && !r.chose.isKey) {
      const tags = (r.chose.tags || []);
      const t = tags.length ? tags.join("、") : "义近";
      const other = r.chose.word ? r.chose.word.word : "";
      return `误选「${r.chose.key} ${other}」——与目标词${t}：${Lex.norm(other) === Lex.norm(w.word) ? "拼写几乎相同" : "正确释义为 " + shortDef(r.chose.word, 24)}`;
    }
    return "未答对：" + (q.answer || "");
  }

  /** 五段式反馈 */
  function feedback(q, r) {
    const w = q.word;
    const st = Store.stats();
    const optLine = q.options
      ? q.options.map((o) => `<span class="tag ${o.isKey ? "ok" : ""}">${o.key}. ${o.text}</span>`).join(" ")
      : `<b class="mono">${q.answerHtml || q.answer}</b>`;
    const gave = r.ok ? "" : `<br><span class="muted small">你的作答：${escapeHtml(String(q.given ?? "（未选）"))}</span>`;
    const why = [];
    if (!r.ok && r.note) why.push(`<b>${r.note}</b>`);
    if (q.options) {
      const distract = q.options.filter((o) => !o.isKey && o.word);
      why.push("干扰项设置：" + distract.map((o) => `「${o.key} ${o.word.word}」${(o.tags || []).join("+") || "义近"}`).join("；"));
      if (!r.ok && r.chose) why.push(`<span class="verdict-no">避坑</span>：${reasonFor(q, r)}`);
    }
    if (q.type === "cloze") why.push("词形变换是完形与写作的高频失分点：先判断句子需要的时态/语态，再落笔。");
    if (q.type === "poly") why.push("四级阅读最爱在「第二义项」设题，背词时请连搭配一起记。");
    if (q.type === "dictation") why.push("注意重读音节与成对字母：" + (w.phonetic || "") + (w.aliases && w.aliases.length > 1 ? "；可接受拼写：" + Lex.variantsOf(w.word).join(" / ") : ""));
    why.push(pointLine(w, q));
    return {
      ok: !!r.ok,
      verdict: r.ok ? '<span class="verdict-yes">正确</span>' : '<span class="verdict-no">错误</span>',
      answer: (r.ok ? "" : "") + optLine + gave + `<br><span class="muted small">考点：${q.point}</span>`,
      why: why.filter(Boolean).join("<br>"),
      example: q.example && q.example.en
        ? `<div class="en">${escapeHtml(q.example.en)}</div><div class="zh">${escapeHtml(q.example.zh || "")}</div>`
        : `<span class="muted">该词暂无例句，可在词库编辑或用 AI 补全。</span>`,
      progress: `已掌握 ${st.mastered} ｜ 错题本 ${st.wrong} ｜ 待测 ${st.new + st.learning}`,
      counts: st,
      sessionId: session.id,
    };
  }

  function pointLine(w, q) {
    const bits = [];
    if (w.collocation) bits.push(`搭配：<b>${w.collocation}</b>`);
    if ((w.senses || []).length > 1) bits.push(`该词多词性（${w.pos}），命题点常落在后面的义项`);
    if (w.units && w.units.length > 1) bits.push(`跨册复现：${w.units.join(" / ")}`);
    if (w.status === "wrong") bits.push(`已打入错题本，将提高频率并更换题型再考`);
    return bits.join("　");
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  /* ---------- 会话控制 ---------- */
  function reset(opts) {
    session = { ...session, asked: 0, right: 0, dailyCap: 0, current: null, count: 0, cool: new Map(), lastTypes: [], pinId: null, pendingGate: null, revisit: [], ...opts };
    return session;
  }
  const clearGate = () => { session.pendingGate = null; };
  /**
   * 词被删除（单词或整课/整单元）后收敛会话状态，否则会留下鬼题：
   * 范围指向已消失的层级 → 出题池空；当前题的词对象已不在库里 → 答案无处可写。
   * pool 词（干扰项扩展池）的 id 本就不在 Store 里，不能误伤。
   */
  function forgetScope(label) {
    let touched = 0;
    // 删单元时其下课次一并消失：override 存的是 "Unit 1 · Lesson 2"，
    // 只比 label 相等会漏掉它（测试 X23 抓到过），所以要连 " · " 前缀一起认。
    const hit = (v) => !!label && (v === label || String(v).startsWith(label + " · "));
    if (hit(session.scope)) { session.scope = "all"; touched++; }
    if (hit(session.override)) { session.override = null; touched++; }
    const cur = session.current;
    if (cur) {
      const id = cur.wordId || (cur.word && cur.word.id);
      if (id && !String(id).startsWith("pool_") && !Store.byId(id)) { session.current = null; touched++; }
    }
    if (session.revisit && session.revisit.length) {
      const keep = session.revisit.filter((id) => String(id).startsWith("pool_") || Store.byId(id));
      if (keep.length !== session.revisit.length) { session.revisit = keep; touched++; }
    }
    if (session.pinId && !Store.byId(session.pinId) && !String(session.pinId).startsWith("pool_")) { session.pinId = null; touched++; }
    return touched;
  }
  const view = () => ({ asked: session.asked, right: session.right, acc: session.asked ? Math.round(session.right / session.asked * 100) : null, scope: session.scope, wrongOnly: session.wrongOnly, override: session.override || null, current: session.current });

  /* ---------- Mode 3：写作联动（抽 3 个错词） ---------- */
  function writingTask() {
    const wrong = Store.words.filter((w) => w.status === "wrong");
    const rest = Store.words.filter((w) => w.status !== "wrong");
    // 优先错题；不足时用未掌握的补；再不足则全书任选（保证 Mode 3 永远可用）
    const pool = wrong.length >= 3 ? wrong.slice() : wrong.concat(rest.filter((w) => w.status !== "mastered"));
    const final = pool.length >= 3 ? pool : pool.concat(rest.filter((w) => !pool.includes(w)));
    if (final.length < 3) return null;
    const three = shuffle(final.slice()).slice(0, 3);
    return three.map((w) => ({ word: w.word, id: w.id, def: shortDef(w, 26), col: w.collocation || "" }));
  }

  /* ---------- Mode 3：阅读联动（150–200 词短文，按词数预算离线拼装） ---------- */
  function readingTask(opts) {
    opts = opts || {};
    let hard = Store.words.filter((w) => w.status === "wrong" || w.status === "learning");
    if (!opts.useWrong || hard.length < 6) hard = hard.concat(Store.words.filter((w) => w.status === "new"));
    if (hard.length < 6) hard = hard.concat(Store.words.filter((w) => w.status === "mastered"));
    // 先保证「有例句」再取词数：否则 slice 之后被 filter 砍掉，短文会掉到 90 词
    const usable = [], seenW = new Set();
    for (const w of hard) if (w.example_en && w.example_zh && !seenW.has(w.id)) { usable.push(w); seenW.add(w.id); }
    if (usable.length < 5) return { error: "可用于组文的例句不足（至少 5 个带例句的词），请先补全例句或导入更多词。" };
    // 难词池太小时，从全库补足，否则 150 词的地板永远达不到（只会拼出 ~120 词）
    if (usable.length < 13) {
      const rest = shuffle(Store.words.filter((w) => w.example_en && w.example_zh && !seenW.has(w.id)));
      for (const w of rest) { if (usable.length >= 13) break; usable.push(w); seenW.add(w.id); }
    }
    const openers = [
      "When the department reviewed last year's figures, several issues came together at once.",
      "The report began with a simple statement, but its consequences were far from simple.",
      "Everything seemed ordinary until the results were carefully examined.",
    ];
    // 连接词必须是句首状语（自带大写/逗号）：用 and 这类从属连词接在句号后会不成句
    const links = ["In addition,", "Worse still,", "At the same time,", "Later data showed", "More importantly,", "Even so,"];
    const extras = [
      "The committee asked whether these patterns would persist if conditions stayed unchanged.",
      "Officials admitted that earlier forecasts had been far too optimistic.",
      "A follow-up review is expected before the end of the term.",
    ];
    const closer = " None of this could be dismissed as a temporary difficulty, and the group agreed to act before the situation deteriorated further.";
    const wc = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

    const pieces = [pick(openers)];
    let total = wc(pieces[0]) + wc(closer);
    const chosen = [];
    const usedSent = new Set();
    let lastLink = "";
    for (const w of shuffle(usable.slice())) {
      if (total >= 150) break;
      const sentence = String(w.example_en).replace(/\s+$/, "");
      if (!sentence || usedSent.has(sentence)) continue;
      const first = chosen.length === 0;
      let linkWord = "";
      if (!first) {                                   // 连接词不重复上一次，否则连着三个 in addition 很假
        let spin = 0;
        do { linkWord = pick(links); } while (linkWord === lastLink && spin++ < 6);
        lastLink = linkWord;
      }
      const bodySent = first ? sentence.charAt(0).toUpperCase() + sentence.slice(1)
        : sentence.charAt(0).toLowerCase() + sentence.slice(1);   // 首句保留大写，接在连接词后才小写
      const piece = (first ? "" : linkWord + " ") + bodySent;
      const addW = wc(piece);
      // 只在已达下限或因单句过长会超上限时中止，否则会卡在 120 词出不来
      if (total + addW > 205 && total >= 140) break;
      pieces.push(piece); total += addW; usedSent.add(sentence); chosen.push(w);
    }
    for (const x of extras) {
      if (total >= 150) break;
      pieces.push(x); total += wc(x);
    }
    let body = pieces.join(" ") + closer;
    body = body.replace(/\s+/g, " ").trim();
    const words = wc(body);
    const glossary = chosen.map((w) => ({ word: w.word, def: shortDef(w, 30), ipa: w.phonetic }));
    // 长难句：挑一个最长的句子做拆解
    const longest = body.split(/(?<=[.。])\s+/).sort((a, b) => b.length - a.length)[0];
    return { passage: body.trim(), length: words, glossary, analysis: analyse(longest) };
  }

  function analyse(sentence) {
    const clauses = sentence.split(/,| that | which | who | because | although | while /i).filter(Boolean);
    const step = Math.max(1, Math.floor(clauses.length / 3));
    const parts = [];
    for (let i = 0; i < clauses.length; i += step) {
      parts.push(clauses.slice(i, i + step).join(", ").trim());
    }
    return {
      sentence,
      chunks: parts.filter(Boolean).slice(0, 4).map((t, i) => ({ label: ["主干/起句", "承接层", "修饰与补充", "收束"][i] || "片段" + (i + 1), text: t })),
      tip: "先看主句主谓宾，再逐层剥离从句；四级长难句的失分点通常在「修饰语指向哪个名词」和「从句省略了哪个引导词」。",
    };
  }

  return { TYPES, eligible, enabledTypes, currentPlan, typesFor, build, next, submit, skip, reset, view, reasonFor, findSurface, shortDef, writingTask, readingTask, analyse, bookmark, invalidateEligible, clearGate, forgetScope, session: () => session };
})();
if (typeof window !== "undefined") window.Quiz = Quiz;
