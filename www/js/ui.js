/* =========================================================================
 * ui.js — 渲染层（不含业务判定）
 * ========================================================================= */
const UI = (() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let toastTimer;
  let libFilter = { kw: "", st: "" };        // 词库当前的搜索/状态筛选，删除确认框用它提示"屏幕显示 M / 实删 N"
  function toast(msg, err) {
    const t = $("#toast");
    t.innerHTML = msg;
    t.style.borderColor = err ? "#5b2730" : "#2a3854";
    t.style.color = err ? "#fca5a5" : "#e8eefb";
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
  }

  /* ---------- 顶部进度 ---------- */
  function renderProgress() {
    const s = Store.stats();
    $("#p-mastered").textContent = s.mastered;
    $("#p-wrong").textContent = s.wrong;
    $("#p-new").textContent = s.new + s.learning;
    $("#lib-summary").textContent = `${s.total} 词 ｜ 已补全 ${s.total - s.unenriched} ｜ 缺音标例句 ${s.unenriched}`;
    return s;
  }

  /* ---------- 测验 ---------- */
  const TYPE_LABEL = { e2c: "四选一 · 英译中", c2e: "四选一 · 中译英", cloze: "语境填空", poly: "熟词生义", dictation: "听音拼写" };

  function renderScope() {
    const seg = $("#scope-seg");
    const units = ["all", ...Store.units(), "wrong", "unmastered"];
    const v = Quiz.view();
    const labels = { all: "全部词库", wrong: "专练错题", unmastered: "未掌握" };
    const stat = {}; Store.unitStats().forEach((g) => { stat[g.unit] = g; });
    const all = Store.stats();
    const seq = Store.settings.mode === "sequence";
    const active = v.wrongOnly ? "wrong" : (seq ? (v.override || Store.currentUnit()) : v.scope);
    seg.innerHTML = units.map((u) => {
      const on = u === active;
      const n = u === "all" ? all.total : u === "wrong" ? all.wrong : u === "unmastered" ? Store.words.filter((w) => w.status !== "mastered").length : (stat[u] ? stat[u].total : 0);
      const done = stat[u] ? `<span class="muted"> 掌握${stat[u].mastered}</span>` : "";
      return `<button data-scope="${esc(u)}" class="${on ? "on" : ""}">${esc(labels[u] || u)} <span class="muted">${n}</span>${done}</button>`;
    }).join("");
  }

  /* ---------- 顺序闯关：模式条 / 单元步骤 / 通关卡 ---------- */
  function renderMode() {
    const seq = Store.settings.mode !== "free";
    $("#mode-seg").innerHTML = [["sequence", "▶ 按单元顺序学"], ["free", "∞ 自由混合练习"]]
      .map(([k, l]) => `<button data-mode="${k}" class="${(k === "sequence") === seq ? "on" : ""}">${l}</button>`).join("");
    $$("#mode-seg [data-mode]").forEach((b) => b.onclick = () => {
      Store.setSetting("mode", b.dataset.mode);
      Quiz.reset({ override: null });
      Quiz.invalidateEligible();
      renderMode(); renderScope(); app.next();
      toast(b.dataset.mode === "sequence" ? "已开启顺序闯关：先攻当前单元，达标自动进下一个" : "自由模式：全词库混出，新词仍按书序");
    });

    const ov = Quiz.session().override;
    const cur = Store.currentBlock();
    const hint = $("#mode-hint");
    if (!seq) hint.innerHTML = "自由模式：范围由上方选择；新词仍严格按书序引入";
    else if (ov) hint.innerHTML = `正在<b>回看 ${esc(ov)}</b>（顺序线暂停）　<button class="ghost tiny" id="btn-back-seq">返回顺序线</button>`;
    else if (cur) hint.innerHTML = `当前学习块 <b>${esc(cur)}</b> ｜ 达标线 ${Math.round((Store.settings.passRatio || .8) * 100)}% 掌握 + 错题清零`;
    else hint.innerHTML = Store.words.length ? "全部课次已通关 🎉" : "词库为空";
    const bb = $("#btn-back-seq");
    if (bb) bb.onclick = () => app.backToSequence();
    renderSeqBar();
    renderPlanSeg();
    renderStrip();
  }

  /* ---------- 题型方案：混合轮换（原方案）+ 五个专项 ---------- */
  const PLAN_LABEL = { mixed: "混合轮换", e2c: "看词选义", c2e: "看义选词", cloze: "语境填空", poly: "熟词生义", dictation: "听音拼写" };
  function renderPlanSeg() {
    const seg = $("#plan-seg"); if (!seg) return;
    const cur = Quiz.currentPlan();
    const total = Store.words.length;
    seg.innerHTML = Object.keys(PLAN_LABEL).map((k) => {
      const n = k === "mixed"
        ? Store.words.filter((w) => Quiz.enabledTypes().some((t) => Quiz.eligible(w, t))).length
        : Store.words.filter((w) => Quiz.eligible(w, k)).length;
      return `<button data-plan="${k}" class="${k === cur ? "on" : ""}">${PLAN_LABEL[k]}<span class="muted"> ${n}</span></button>`;
    }).join("");
    $$("#plan-seg [data-plan]").forEach((b) => b.onclick = () => app.setPlan(b.dataset.plan));
    const h = $("#plan-hint");
    if (cur === "mixed") h.innerHTML = "按设置里勾选的题型轮换出题（默认方案）";
    else {
      const skip = total - Store.words.filter((w) => Quiz.eligible(w, cur)).length;
      const need = { e2c: "", c2e: "", cloze: "缺英文例句", poly: "只有单个义项", dictation: "缺音标" }[cur];
      h.innerHTML = `专项：只出「${PLAN_LABEL[cur]}」。<b>掌握判定不变</b>（仍需 2 种不同题型答对），专项适合单点突破，收口请切回混合轮换。`
        + (skip && need ? `　<span class="tag warn">${skip} 个词${need}，本专项会跳过</span>` : "");
    }
  }

  function renderSeqBar() {
    const bar = $("#seq-bar");
    if (Store.settings.mode === "free" || !Store.words.length) { bar.innerHTML = ""; bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const bf = Store.blockFlags();
    const hasLesson = bf.some((b) => b.lesson);
    bar.innerHTML = bf.map((f) => `
      <div class="step ${f.state}${f.regressed ? " regress" : ""}" data-block="${esc(f.label)}"
           title="${esc(f.label)}：共 ${f.total} 词 ｜ 掌握 ${f.mastered} ｜ 错题 ${f.wrong} ｜ 学习中 ${f.learning} ｜ 待测 ${f.new}">
        <span class="st-ico">${f.state === "cleared" ? "✓" : f.state === "active" ? "▶" : "🔒"}</span>
        <span class="st-name">${esc(hasLesson ? (f.lesson || f.label) : f.label)}</span>
        ${hasLesson ? `<span class="st-of">${esc(f.unit)}</span>` : ""}
        <span class="st-bar"><i style="width:${f.gatePct}%"></i></span>
        <span class="st-meta">${f.mastered}/${f.total}${f.wrong ? ` · 错${f.wrong}` : ""}${f.state !== "cleared" && f.needMore ? ` · 差${f.needMore}` : ""}</span>
        ${f.regressed ? `<span class="st-warn">回潮 ${f.wrong}</span>` : ""}
      </div>`).join("");
    $$("#seq-bar .step").forEach((el) => el.addEventListener("click", () => app.visitBlock(el.dataset.block)));
  }

  function showGate(units) {
    const u = Array.isArray(units) ? units[units.length - 1] : units;
    const nextU = Store.unitFlags().find((f) => !f.cleared);
    $("#feedback").classList.add("hidden");
    $("#quiz-stage").innerHTML = `<div class="qcard clear-card">
      <div class="cc-title">🎉 ${esc(u)} 已通关</div>
      <p class="muted">达标线：已掌握 ${Math.round((Store.settings.passRatio || .8) * 100)}% 且本单元错题清零。</p>
      <div class="row">
        <button class="primary" id="btn-gate-next">${nextU ? "进入 " + esc(nextU.unit) + " ▶" : "查看全书成绩"}</button>
        <button class="ghost" id="btn-gate-stay">留在 ${esc(u)} 回看</button>
      </div></div>`;
    $("#btn-gate-next").onclick = () => { Quiz.clearGate(); app.next(); };
    $("#btn-gate-stay").onclick = () => { Quiz.clearGate(); app.visitUnit(u); };
  }

  /* ---------- 顶部进度带：一行说清"在学哪儿、掌握多少、什么方案" ---------- */
  function renderStrip() {
    const lab = $("#strip-label"), meta = $("#strip-meta"), fill = $("#strip-fill");
    if (!lab) return;
    const v = Quiz.view();
    const seq = Store.settings.mode === "sequence";
    const s = Store.stats();
    let label = "", m = s.mastered, tot = s.total;
    if (v.wrongOnly) { label = "专练错题"; }
    else if (seq && !v.override) {
      const cur = Store.currentBlock();
      if (cur) { const f = Store.blockFlags().find((b) => b.label === cur) || { mastered: 0, total: 0 }; label = cur; m = f.mastered; tot = f.total; }
      else label = "全书已通关";
    } else {
      const key = v.override || v.scope;
      label = (!key || key === "all") ? "全部词库" : key === "unmastered" ? "未掌握" : key;
      if (key && key !== "all" && key !== "unmastered") {
        const list = Store.words.filter((w) => Store.inBlock(w, key) || Store.inUnit(w, key));
        m = list.filter((w) => w.status === "mastered").length; tot = list.length;
      } else if (key === "unmastered") { tot = Store.words.filter((w) => w.status !== "mastered").length; }
    }
    const plan = Quiz.currentPlan();
    lab.textContent = label;
    meta.textContent = m + "/" + tot + " 已掌握 · " + (plan === "mixed" ? "混合轮换" : "专项·" + PLAN_LABEL[plan]);
    if (fill) fill.style.width = (tot ? Math.round((m / tot) * 100) : 0) + "%";
    const hint = $("#swipe-hint");
    if (hint) hint.classList.toggle("hidden", Store.settings.swipeNext === false);
  }

  function renderQuestion(q) {
    const stage = $("#quiz-stage");
    $("#feedback").classList.add("hidden");
    if (!q) { stage.innerHTML = `<div class="empty">词库为空。去「📥 录入」粘贴词表或上传 .docx。</div>`; return; }
    let head = "";
    let big = "", ipa = "";
    if (q.type === "e2c" || q.type === "dictation" || q.type === "poly") { big = q.type === "e2c" ? q.front : (q.type === "poly" ? q.front : ""); ipa = q.ipa || (q.type === "dictation" ? "" : q.ipa); }
    if (q.type === "dictation") { big = ""; ipa = q.ipa; }
    if (q.type === "c2e") big = "";
    const hot = q.word.status === "wrong" ? " hot" : "";
    const statusTag = q.word.status === "wrong" ? `<span class="tag bad">错题加权复现 · 已错 ${q.word.srs.wrong} 次</span>`
      : q.word.status === "mastered" ? `<span class="tag ok">已掌握抽查</span>`
      : q.word.status === "learning" ? `<span class="tag warn">待第 2 种题型确认</span>` : `<span class="tag">新词首测</span>`;
    head = `<div class="qhead"><span class="qtype${hot}">${TYPE_LABEL[q.type]}</span>
      <span class="tag acc">${esc(q.word.unit || (q.word.units || []).join("/"))}</span>${statusTag}
      ${Store.settings.sound && q.word.word ? `<button class="speak" data-speak="${esc(q.type === "c2e" ? "" : q.word.word)}">🔊 朗读</button>` : ""}</div>`;

    let body = "";
    if (big) body += `<div class="qword">${esc(big)}</div>`;
    if (q.type === "dictation") body += `<div class="qword mono">${esc(q.ipa)}</div>`;
    if (q.ipa && big && q.type !== "dictation") body += `<div class="qipa">${esc(q.ipa)}</div>`;
    body += `<div class="qstem">${q.stem}</div>`;
    if (q.sub) body += `<div class="qhint">${q.sub}</div>`;

    if (q.options) {
      body += `<div class="qopts">` + q.options.map((o) =>
        `<button class="opt" data-key="${o.key}"><span class="k">${o.key}</span><span>${esc(o.text)}</span></button>`).join("") + `</div>`;
    } else if (q.input) {
      body += `<div class="answerrow"><input id="answer-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(q.input.placeholder)}">
        <button class="primary" id="btn-submit">判定</button></div>
        <div class="qhint">${esc(q.input.hint || "")}　<span class="muted">回车提交</span></div>`;
    }
    stage.innerHTML = `<div class="qcard">${head}${body}</div>`;

    const inp = $("#answer-input");
    if (inp) { inp.focus(); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); app.answer(inp.value); } }); }
    $("#btn-submit") && $("#btn-submit").addEventListener("click", () => app.answer($("#answer-input").value));
    $$(".opt", stage).forEach((b) => b.addEventListener("click", () => app.answer(b.dataset.key)));
    $$("[data-speak]", stage).forEach((b) => b.addEventListener("click", () => speak(b.dataset.speak)));
  }

  function renderFeedback(fb, q) {
    const box = $("#feedback");
    box.classList.remove("hidden", "good", "bad");
    box.classList.add(fb.ok ? "good" : "bad");
    $("#fb-verdict").innerHTML = fb.verdict + ` <span class="muted small">（${TYPE_LABEL[q.type]}）</span>`;
    $("#fb-answer").innerHTML = fb.answer;
    $("#fb-why").innerHTML = fb.why;
    $("#fb-example").innerHTML = fb.example;
    $("#fb-progress").innerHTML = fb.progress + (q.word.status === "wrong" ? `　<span class="tag bad">已入错题本，将更换题型高频复现</span>` : "")
      + (q.word.status === "mastered" && fb.ok ? `　<span class="tag ok">已达 2 种不同题型答对 → 移入已掌握</span>` : "");
    renderProgress();
    renderScope();
    renderStrip();
  }

  /* ---------- 词库（按单元分类） ---------- */
  let libSort = "default";
  const ST = { new: ["待测", ""], learning: ["学习中", "warn"], wrong: ["错题", "bad"], mastered: ["已掌握", "ok"] };

  function wordRow(w) {
    const s = ST[w.status] || ["待测", ""];
    const cross = (w.units || []).filter((u) => u && u !== Store.unitKey(w));
    return `<div class="litem" data-id="${w.id}">
      <div>
        <div class="w">${esc(w.word)} <span class="ipa">${esc(w.phonetic || "")}</span>
          ${w.aliases && w.aliases.length > 1 ? `<span class="tag">${esc(w.aliases.join(" / "))}</span>` : ""}
          ${cross.length ? `<span class="tag acc">也见于 ${esc(cross.join("、"))}</span>` : ""}</div>
        <div class="def">${esc(w.definition || "（无释义）")}</div>
        ${w.collocation ? `<div class="ex">搭配：${esc(w.collocation)}</div>` : ""}
        ${w.example_en ? `<div class="ex">${esc(w.example_en)}<br>${esc(w.example_zh || "")}</div>` : ""}
        <div class="meta">${esc(w.pos || "")} ｜ 已考 ${w.srs.seen}（对 ${w.srs.correct}/错 ${w.srs.wrong}） 正确题型 ${w.srs.correctTypes.length}/2 ｜ 源:${esc(w.source)}${w.enriched ? "" : " ｜ <span class='tag bad'>缺补全</span>"}</div>
        ${w.srs.wrongReason && w.status === "wrong" ? `<div class="meta" style="color:var(--bad)">错因：${esc(w.srs.wrongReason)}</div>` : ""}
      </div>
      <div class="acts">
        <span class="tag ${s[1]}">${s[0]}</span>
        <button data-act="speak" title="朗读">🔊</button><button data-act="edit">编辑</button><button data-act="reset">重置</button><button data-act="del" class="danger">删除</button>
      </div></div>`;
  }

  function sortList(list) {
    if (libSort === "priority") return list.slice().sort((a, b) => (b.srs.weight || 0) - (a.srs.weight || 0));
    if (libSort === "word") return list.slice().sort((a, b) => a.word.localeCompare(b.word));
    return list;                                       // 默认＝书序（词库插入顺序）
  }

  function renderLibrary() {
    const kw = ($("#lib-search").value || "").trim().toLowerCase();
    const unit = $("#lib-unit").value;
    const st = $("#lib-status").value;
    libFilter = { kw, unit, st };
    let list = Store.words.slice();
    if (unit) list = list.filter((w) => Store.unitKey(w) === unit);
    if (st === "unenriched") list = list.filter((w) => !w.enriched);
    else if (st) list = list.filter((w) => w.status === st);
    if (kw) list = list.filter((w) => Lex.norm(w.word).includes(kw) || w.definition.toLowerCase().includes(kw) || (w.aliases || []).some((a) => Lex.norm(a).includes(kw)));

    const sel = $("#lib-unit"), sig = Store.units().join("|");
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = `<option value="">全部单元</option>` + Store.units().map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
      sel.dataset.sig = sig;
    }
    sel.value = unit;

    const grouped = Store.settings.libGroup !== false;
    const gbtn = $("#btn-lib-group");
    if (gbtn) gbtn.textContent = grouped ? "▦ 按单元分组" : "☰ 平铺列表";
    // 单元筛选框选中了具体单元时，工具栏出现"删除该单元"：平铺模式下没有分组头部，这是唯一入口
    const dub = $("#btn-del-unit");
    if (dub) {
      dub.classList.toggle("hidden", !unit);
      dub.textContent = unit ? `删除「${unit}」(${Store.scopeStats("unit", unit).total})` : "删除该单元";
    }

    if (!list.length) { $("#lib-list").innerHTML = `<div class="empty">没有匹配的词。换个筛选条件，或去「录入」加词。</div>`; return bindLib(); }
    if (!grouped) { $("#lib-list").innerHTML = `<div class="list">${sortList(list).map(wordRow).join("")}</div>`; return bindLib(); }

    /* 两级分组：Unit（外层）→ Lesson（内层）；没有课次时自动退回单层 */
    const collapsed = Store.settings.collapsed || {};
    const uFlags = {}; Store.unitFlags().forEach((u) => { uFlags[u.unit] = u; });
    const groups = [];
    const seenU = new Map();
    for (const b of Store.blockFlags()) {
      if (!list.some((w) => Store.blockKey(w) === b.label)) continue;
      if (!seenU.has(b.unit)) { seenU.set(b.unit, groups.length); groups.push({ unit: b.unit, blocks: [] }); }
      groups[seenU.get(b.unit)].blocks.push(b);
    }
    const chips = (o) => `<span class="tag ok">掌握 ${o.mastered}</span><span class="tag bad">错题 ${o.wrong}</span>
      <span class="tag warn">学习中 ${o.learning}</span><span class="tag">待测 ${o.new}</span>
      ${o.unenriched ? `<span class="tag bad">缺补全 ${o.unenriched}</span>` : ""}`;

    $("#lib-list").innerHTML = groups.map((grp) => {
      const u = uFlags[grp.unit] || { unit: grp.unit, total: 0, mastered: 0, new: 0, learning: 0, wrong: 0, unenriched: 0, pct: 0 };
      const uOpen = !collapsed[grp.unit];
      const hasLesson = grp.blocks.some((b) => b.lesson);
      const shown = grp.blocks.reduce((n, b) => n + list.filter((w) => Store.blockKey(w) === b.label).length, 0);
      const inner = grp.blocks.map((b) => {
        const items = sortList(list.filter((w) => Store.blockKey(w) === b.label));
        if (!hasLesson) return items.map(wordRow).join("");
        const bOpen = !collapsed[b.label];
        const mark = b.cleared ? "✓" : b.state === "active" ? "▶" : "○";
        return `<div class="lgroup ${b.state}${bOpen ? "" : " closed"}" data-block="${esc(b.label)}">
          <div class="lghead">
            <button class="ug-caret" data-bact="toggle">${bOpen ? "▾" : "▸"}</button>
            <b class="lg-name">${mark} ${esc(b.lesson || b.label)}</b>
            <span class="muted small">${items.length}/${b.total} 词</span>
            ${b.cleared ? `<span class="tag ok">已达标</span>` : ""}
            ${b.regressed ? `<span class="tag warn">回潮 ${b.wrong}</span>` : ""}
            ${!b.cleared && b.needMore ? `<span class="tag">距达标还差 ${b.needMore}</span>` : ""}
            <span class="lg-acts"><button data-bact="drill">只练这课</button><button data-bact="del" class="danger" title="删除本课全部单词">删除本课</button></span>
          </div>
          ${bOpen ? `<div class="list">${items.map(wordRow).join("")}</div>` : ""}
        </div>`;
      }).join("");
      return `<section class="ugroup" data-unit="${esc(grp.unit)}">
        <header class="ughead">
          <button class="ug-caret" data-uact="toggle" title="折叠/展开">${uOpen ? "▾" : "▸"}</button>
          <div class="ug-title"><b>${esc(grp.unit)}</b><span class="muted small">${shown}/${u.total} 词${kw || st ? "（已筛选）" : ""}</span>
            <span class="pct" title="本单元已掌握比例">${u.pct}%</span>
            ${hasLesson ? `<span class="tag">${grp.blocks.length} 个课次</span>` : ""}</div>
          <div class="ug-chips">${chips(u)}</div>
          <div class="ug-acts">
            <button data-uact="drill">只练本单元</button>
            ${u.unenriched ? `<button data-uact="fill">补全 ${u.unenriched} 项</button>` : ""}
            <button data-uact="del" class="danger" title="删除本单元及其下所有课次的单词">删除单元</button>
          </div>
          <div class="ubar" title="已掌握 ${u.pct}% ｜ 待测 ${u.new}"><i style="width:${u.pct}%"></i></div>
        </header>
        ${uOpen ? `<div class="ugbody">${inner}</div>` : ""}
      </section>`;
    }).join("");
    bindLib();
  }


  function bindLib() {
    $$("#lib-list .litem").forEach((el) => {
      const id = el.dataset.id;
      $$("[data-act]", el).forEach((b) => b.addEventListener("click", () => {
        const w = Store.byId(id);
        if (b.dataset.act === "speak") speak(w.word);
        if (b.dataset.act === "edit") openEditor(w);
        if (b.dataset.act === "reset") { w.srs = Lex.freshSrs(); w.status = "new"; Store.save(); renderLibrary(); renderProgress(); toast(`已重置 <b>${esc(w.word)}</b> 的进度`); }        if (b.dataset.act === "del") {
          if (!confirm(`删除「${w.word}」？
该词的错题记录与掌握进度会一并删除。删错可用词库上方「撤销上次改动」恢复。`)) return;
          Store.snapshot();                       // 删除前打快照，走同一条撤销通道
          Store.remove(id);
          Quiz.forgetScope(null);                 // 当前题若正是这个单词，必须作废，否则答案写进已删对象
          renderLibrary(); renderProgress(); renderWrongbook(); renderScope(); renderStrip();
          toast(`已删除 <b>${esc(w.word)}</b>　<span class="tag">点词库上方「撤销上次改动」可恢复</span>`);
        }
      }));
    });
    $$("#lib-list .ughead [data-uact]").forEach((b) => b.addEventListener("click", () => {
      const sec = b.closest(".ugroup"); if (!sec) return;
      const unit = sec.dataset.unit, act = b.dataset.uact;
      if (act === "toggle") {
        const c = { ...(Store.settings.collapsed || {}) };
        c[unit] = !c[unit];
        Store.setSetting("collapsed", c); renderLibrary();
      } else if (act === "drill") app.focusUnit(unit);
      else if (act === "fill") app.fillUnit(unit);
      else if (act === "del") askScopeDelete("unit", unit);
    }));
    $$("#lib-list .lghead [data-bact]").forEach((b) => b.addEventListener("click", () => {
      const g = b.closest(".lgroup"); if (!g) return;
      const label = g.dataset.block, act = b.dataset.bact;
      if (act === "toggle") {
        const c = { ...(Store.settings.collapsed || {}) };
        c[label] = !c[label];
        Store.setSetting("collapsed", c); renderLibrary();
      } else if (act === "drill") app.visitBlock(label);
      else if (act === "del") askScopeDelete("lesson", label);
    }));
  }

  /* ---------- 导入归属选择器（Unit / Lesson 可自动识别或手动钉住） ---------- */
  function renderPins() {
    const usel = $("#pin-unit"), lsel = $("#pin-lesson");
    if (!usel || !lsel) return;
    const us = Store.units().filter((u) => u && u !== "未分组");
    const curU = Store.settings.pinnedUnit || "", curL = Store.settings.pinnedLesson || "";
    usel.innerHTML = `<option value="auto">自动识别单元</option>` + us.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("")
      + `<option value="__new">＋ 新建单元…</option>`;
    usel.value = curU ? (us.indexOf(curU) >= 0 ? curU : "__new") : "auto";
    const known = curU ? Store.blockFlags().filter((b) => b.unit === curU && b.lesson).map((b) => b.lesson) : [];
    if (known.indexOf(curL) < 0 && curL) known.push(curL);
    lsel.innerHTML = `<option value="auto">自动识别课次</option><option value="">整单元（不分课次）</option>`
      + [...new Set(known)].sort((a, b) => Store.labelOrder(a, b)).map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")
      + `<option value="__new">＋ 新建课次…</option>`;
    lsel.value = curL ? (known.indexOf(curL) >= 0 ? curL : "__new") : "auto";
    const tip = $("#pin-tip");
    if (tip) tip.innerHTML = (curU || curL)
      ? `已钉住：<b>${esc(blockish(curU, curL))}</b>　<span class="tag">文本里的标题仍会覆盖后续行</span>`
      : "默认自动识别文本里的 Unit / Lesson 标题；分页提取只截到 “Lesson 3” 时，在这里钉住父级单元";
  }
  const blockish = (u, l) => [u, l].filter(Boolean).join(" · ") || "自动";
  function bindPins() {
    const usel = $("#pin-unit"), lsel = $("#pin-lesson");
    if (!usel || usel.dataset.bound) return;
    usel.dataset.bound = "1"; lsel.dataset.bound = "1";
    usel.onchange = () => {
      let v = usel.value;
      if (v === "__new") { v = (prompt("单元名称（如 Unit 1 / Module 3）", "Unit " + (Store.units().filter((u) => u !== "未分组").length + 1)) || "").trim(); if (!v) { renderPins(); return; } }
      Store.setSetting("pinnedUnit", v === "auto" ? "" : v);
      if (v === "auto") Store.setSetting("pinnedLesson", "");
      renderPins();
      if (app.refreshParsePreview) app.refreshParsePreview();
    };
    lsel.onchange = () => {
      let v = lsel.value;
      if (v === "__new") { v = (prompt("课次名称（如 Lesson 2）", "Lesson 1") || "").trim(); if (!v) { renderPins(); return; } }
      Store.setSetting("pinnedLesson", v === "auto" ? "" : v);
      renderPins();
      if (app.refreshParsePreview) app.refreshParsePreview();
    };
  }

  /* ---------- 录入预览（含去重标注） ---------- */
  let pendingPlan = null;
  function renderPreview(plan) {
    pendingPlan = plan;
    const panel = $("#preview-panel");
    if (!plan || !plan.rows.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const s = plan.summary;
    $("#pv-count").textContent = plan.rows.length;
    $("#pv-summary").innerHTML = [
      `<span class="tag ok">新增 ${s.new}</span>`,
      `<span class="tag warn">合并义项 ${s.merge}</span>`,
      `<span class="tag bad">重复忽略 ${s.dup}</span>`,
      s.dupBatch ? `<span class="tag bad">同批折叠 ${s.dupBatch}</span>` : "",
      `<span class="muted">策略：${plan.strategy === "overwrite" ? "新释义覆盖" : plan.strategy === "skip" ? "重复即跳过" : "合并义项"} ｜ 错题与已掌握状态不受影响</span>`,
    ].join(" ");
    const BADGE = { new: ["新增", "ok"], merge: ["合并", "warn"], dup: ["重复", "bad"], dupBatch: ["同批", "bad"] };
    const orphans = plan.rows.filter((r) => r.cand && r.cand.orphanLesson).length;
    $("#pv-table").innerHTML = `<table class="dt"><thead><tr>
      <th>处理</th><th>单词</th><th>归属</th><th>音标</th><th>词性/释义</th><th>搭配</th><th>例句</th><th>判定依据</th></tr></thead><tbody>` +
      plan.rows.map((r) => {
        const w = r.merged, b = BADGE[r.action] || ["?", ""];
        const bl = Lex.blockOf(w);
        const orphan = r.cand && r.cand.orphanLesson;
        return `<tr class="${r.action === "dup" ? "dup" : ""}">
          <td><span class="tag ${b[1]}">${b[0]}</span></td>
          <td><b>${esc(w.word)}</b>${(w.aliases || []).length > 1 ? `<br><span class="muted small">${esc(w.aliases.join(" / "))}</span>` : ""}</td>
          <td class="small">${orphan ? `<span class="tag bad" title="只提取到课次、丢了父级单元，请在上方钉住单元">缺单元</span>` : ""}${esc(bl === "未分组" ? "未分组" : bl)}</td>
          <td class="mono">${esc(w.phonetic || "—")}</td>
          <td>${esc(w.definition || "—")}</td>
          <td>${esc(w.collocation || "—")}</td>
          <td>${esc(w.example_en || "—")}</td>
          <td class="muted small">${esc(r.reason || "")}</td></tr>`;
      }).join("") + `</tbody></table>`;
    if (orphans) $("#pv-summary").insertAdjacentHTML("beforeend",
      `<span class="tag bad">${orphans} 条只有课次、缺父级单元</span><span class="muted">在上方「导入归属」里选对 Unit 后重新解析即可</span>`);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  const commit = () => { if (!pendingPlan) return null; const p = pendingPlan; pendingPlan = null; $("#preview-panel").hidden = true; return p; };

  /* ---------- 错题本 ---------- */
  function renderWrongbook() {
    const list = Store.words.filter((w) => w.status === "wrong").sort((a, b) => (b.srs.weight || 0) - (a.srs.weight || 0));
    $("#wb-list").innerHTML = list.length ? list.map((w) => {
      const need = Math.max(0, 2 - w.srs.correctTypes.length);
      return `<div class="litem" data-id="${w.id}">
        <div>
          <div class="w">${esc(w.word)} <span class="ipa">${esc(w.phonetic || "")}</span> <span class="tag bad">权重 ${w.srs.weight || 0}</span></div>
          <div class="def">${esc(w.definition)}</div>
          <div class="meta">错因：<span style="color:var(--bad)">${esc(w.srs.wrongReason || "未记录")}</span></div>
          <div class="meta">上次题型：${esc(TYPE_LABEL[w.srs.lastType] || "—")} → 下次必须换题型 ｜ 还需 <b>${need}</b> 种不同题型答对 ｜ 已对题型：${w.srs.correctTypes.map((t) => TYPE_LABEL[t]).join("、") || "无"}</div>
        </div>
        <div class="acts"><button data-act="drill">立刻重考</button><button data-act="edit">编辑</button></div></div>`;
    }).join("") : `<div class="empty">错题本干净。答错的词会自动进这里，并提高复现频率。</div>`;
    $$("#wb-list [data-act]").forEach((b) => b.addEventListener("click", () => {
      const id = b.closest(".litem").dataset.id;
      if (b.dataset.act === "edit") return openEditor(Store.byId(id));
      app.drillWord(id);
    }));
  }

  /* ---------- 词条编辑 ---------- */
  function openEditor(w) {
    if (!w) return;
    $("#modal-title").textContent = "编辑词条 · " + w.word;
    $("#modal-body").innerHTML = `
      <div class="field"><label>单词（异形用 / 分隔，如 despatch/dispatch）</label><input id="ed-word" value="${esc(w.word)}"></div>
      <div class="field"><label>单元</label><input id="ed-unit" value="${esc((w.units || [w.unit]).join(" "))}"></div>
      <div class="field"><label>词性与中文释义（一行一个，如 <code>n. 领域，场所</code>）</label>
        <textarea id="ed-senses" rows="4">${esc((w.senses || []).map((s) => `${s.pos} ${s.meaning}`.trim()).join("\n"))}</textarea></div>
      <div class="field"><label>音标 IPA</label><input id="ed-ph" value="${esc(w.phonetic || "")}"></div>
      <div class="field"><label>常见搭配</label><input id="ed-col" value="${esc(w.collocation || "")}"></div>
      <div class="field"><label>英文例句</label><input id="ed-en" value="${esc(w.example_en || "")}"></div>
      <div class="field"><label>中文译文</label><input id="ed-zh" value="${esc(w.example_zh || "")}"></div>
      <div class="row"><button class="ghost danger" id="ed-del">删除该词</button>
        <button class="ghost" id="ed-one">仅此词 AI 补全</button></div>`;
    $("#modal").classList.remove("hidden");
    $("#modal-save").textContent = "保存"; $("#modal-save").classList.remove("danger");
    $("#ed-del").onclick = () => { if (confirm(`从词库删除「${w.word}」？\n该词的错题记录与掌握进度会一并删除，可用「撤销上次改动」恢复。`)) { Store.snapshot(); Store.remove(w.id); Quiz.forgetScope(null); closeModal(); renderLibrary(); renderWrongbook(); renderProgress(); renderScope(); renderStrip(); toast(`已删除 <b>${esc(w.word)}</b>`); } };
    $("#ed-one").onclick = () => app.aiOne(w);
    $("#modal-save").onclick = () => {
      const senses = Parse.text($("#ed-senses").value.split("\n").map((l) => `${$("#ed-word").value}\t${l}`).join("\n")).candidates[0];
      const us = $("#ed-unit").value.match(/[Uu]nit\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*单元/g) || [];
      Store.update(w.id, {
        word: $("#ed-word").value.trim() || w.word,
        unit: us[0] || w.unit,
        units: us.length ? us : w.units,
        senses: senses && senses.senses.length ? senses.senses : w.senses,
        phonetic: $("#ed-ph").value.trim(), collocation: $("#ed-col").value.trim(),
        example_en: $("#ed-en").value.trim(), example_zh: $("#ed-zh").value.trim(),
      });
      closeModal(); renderLibrary(); renderProgress(); renderWrongbook(); toast("已保存");
    };
  }
  /* ---------- 整课 / 整单元删除 ---------- */
  /** 当前筛选下该层级里"看得见"的词数：看不见的那些同样会被删，必须在确认框里说清 */
  function scopeShown(kind, label) {
    const { kw, unit, st } = libFilter;
    return Store.scopeWords(kind, label).filter((w) => {
      if (unit && Store.unitKey(w) !== unit) return false;
      if (st === "unenriched" && w.enriched) return false;
      if (st && st !== "unenriched" && w.status !== st) return false;
      if (kw && !(Lex.norm(w.word).includes(kw) || (w.definition || "").toLowerCase().includes(kw) || (w.aliases || []).some((a) => Lex.norm(a).includes(kw)))) return false;
      return true;
    }).length;
  }

  function askScopeDelete(kind, label) {
    const s = Store.scopeStats(kind, label);
    if (!s.total) return toast(`「${esc(label)}」下已经没有单词了`, true);
    const what = kind === "unit" ? "整个单元" : "整个课次";
    const shown = scopeShown(kind, label);
    $("#modal-title").textContent = `删除${kind === "unit" ? "单元" : "课次"} · ${label}`;
    $("#modal-body").innerHTML = `
      <p>将删除${what} <b>${esc(label)}</b>，共 <b>${s.total}</b> 个单词：</p>
      <ul class="del-scope">
        ${shown < s.total ? `<li class="bad">当前筛选只显示 ${shown} 个，另外 <b>${s.total - shown}</b> 个同样会被删掉</li>` : ""}
        <li>已掌握 <b>${s.mastered}</b> ｜ 学习中 ${s.learning} ｜ 错题 ${s.wrong} ｜ 待测 ${s.new}</li>
        ${kind === "unit" && s.lessons.length ? `<li>连带其下 ${s.lessons.length} 个课次：${esc(s.lessons.join("、"))}</li>` : ""}
        ${s.cleared ? `<li>该${kind === "unit" ? "单元" : "课次"}此前<b>已达标</b>，通关记录一并清除（留着的话日后重导同名课次会被误判为已达标）</li>` : ""}
        ${s.unenriched ? `<li>其中 ${s.unenriched} 个词还缺音标/例句</li>` : ""}
        <li class="muted small">${esc(s.words.slice(0, 8).join("、"))}${s.words.length > 8 ? " …" : ""}</li>
      </ul>
      <p class="muted small">错题本记录与掌握进度都挂在词条上，随之一并删除。删错可用词库上方「撤销上次改动」一步恢复（只保留最近一次操作）。</p>`;
    const btn = $("#modal-save");
    btn.textContent = `删除这 ${s.total} 个词`;
    btn.classList.add("danger");
    btn.onclick = () => {
      const r = Store.removeScope(kind, label);
      Quiz.forgetScope(label);                    // 当前题/范围可能指向已删的层级
      // 筛选框若指着已被删空的单元，要一起清掉：否则工具栏会显示「删除「Unit 8」(0)」这种死状态
      const sel = $("#lib-unit");
      if (sel && sel.value && !Store.scopeWords("unit", sel.value).length) sel.value = "";
      $("#modal").classList.add("hidden");
      renderLibrary(); renderProgress(); renderWrongbook(); renderScope(); renderStrip();
      toast(`已删除 <b>${esc(label)}</b> 的 ${r.removed} 个词　<span class="tag">点词库上方「撤销上次改动」可恢复</span>`);
    };
    $("#modal").classList.remove("hidden");
  }

  function closeModal() {
    $("#modal").classList.add("hidden");
    const btn = $("#modal-save");                 // 还原成编辑弹窗的普通保存按钮
    btn.textContent = "保存"; btn.classList.remove("danger"); btn.onclick = null;
  }

  /* ---------- 设置抽屉 ---------- */
  function renderTypeChecks() {
    $("#type-checks").innerHTML = Object.keys(Quiz.TYPES).map((t) => {
      const on = Store.settings.types[t] !== false;
      const cnt = Store.words.filter((w) => Quiz.eligible(w, t)).length;
      return `<label><input type="checkbox" data-type="${t}" ${on ? "checked" : ""}> ${TYPE_LABEL[t]} <span class="muted small">（当前 ${cnt}/${Store.words.length} 词可出该型）</span></label>`;
    }).join("");
    $$("#type-checks input").forEach((i) => i.addEventListener("change", () => {
      const types = {};
      $$("#type-checks input").forEach((x) => { types[x.dataset.type] = x.checked; });
      Store.setSetting("types", types);
      renderTypeChecks();
    }));
  }
  function fillSettings() {
    const s = Store.settings;
    $("#set-daily").value = s.daily; $("#daily-val").textContent = s.daily;
    const rs = Math.round((s.reviewShare == null ? 0.7 : s.reviewShare) * 100);
    $("#set-review").value = rs; $("#review-val").textContent = rs + "%";
    $("#set-order").checked = s.strictOrder !== false;
    const pr = Math.round((s.passRatio == null ? 0.8 : s.passRatio) * 100);
    $("#set-pass").value = pr; $("#pass-val").textContent = pr + "%";
    $("#set-autoadv").checked = s.autoAdvance !== false;
    $("#set-carry").checked = s.carryWrong !== false;
    $("#set-dedup").value = s.dedup || "merge";
    $("#ingest-dedup").value = s.dedup || "merge";
    $("#set-sound").checked = !!s.sound;
    const swb = $("#set-swipe"); if (swb) swb.checked = s.swipeNext !== false;
    $("#chk-autonext").checked = !!s.autoNext;
    $("#set-usepool").checked = !!s.usePool;
    $("#set-ai-base").value = s.ai.baseURL || "";
    $("#set-ai-model").value = s.ai.model || "";
    $("#set-ai-key").value = s.ai.key || "";
    const u = Store.usage();
    $("#storage-info").innerHTML = `本机已存 ${u.words} 词，约 ${u.kb} KB（localStorage 上限一般 5 MB）。导出 JSON 可跨设备迁移，导入时同样走合并去重；备份里的学习进度会带回，本机练得更多的不会被覆盖。`;
    $("#btn-undo-import").disabled = !Store.canUndo();
    renderTypeChecks();
  }

  function speak(word) {
    if (!word) return;
    if (!("speechSynthesis" in window)) return toast("该浏览器不支持朗读，可只看音标。", true);
    const u = new SpeechSynthesisUtterance(word);
    u.lang = "en-GB"; u.rate = 0.85;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  const emptyStage = (msg) => { $("#quiz-stage").innerHTML = `<div class="empty">${msg}</div>`; $("#feedback").classList.add("hidden"); };

  const SORTS = ["default", "priority", "word"];
  const SORT_LABEL = { default: "默认", priority: "错题权重", word: "字母" };
  function cycleSort() { libSort = SORTS[(SORTS.indexOf(libSort) + 1) % SORTS.length]; renderLibrary(); return SORT_LABEL[libSort]; }

  return { $, $$, esc, toast, renderProgress, renderMode, renderSeqBar, renderPlanSeg, renderPins, bindPins, renderStrip, showGate, renderQuestion, renderFeedback, renderLibrary, renderPreview, commit, renderWrongbook, renderScope, openEditor, closeModal, askScopeDelete, scopeShown, fillSettings, renderTypeChecks, speak, emptyStage, TYPE_LABEL, PLAN_LABEL, cycleSort, sortLabel: () => SORT_LABEL[libSort] };
})();
if (typeof window !== "undefined") window.UI = UI;
