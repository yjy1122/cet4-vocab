/* =========================================================================
 * app.js — 装配与事件流（单题循环 + 录入 + AI 通道 + 进阶 + 设置）
 * ========================================================================= */
const app = (() => {
  const $ = UI.$, $$ = UI.$$;
  let autoTimer = null, autoLeft = 0, currentQ = null;

  /* ---------------- 测验主循环 ---------------- */
  function next() {
    stopAuto();
    const r = Quiz.next();
    if (r.question) { currentQ = r.question; UI.renderQuestion(r.question); }
    else if (r.gate) { currentQ = null; UI.showGate(r.gate); }
    else { currentQ = null; UI.emptyStage(r.empty || r.done || "没有可出的题了。"); }
    UI.renderSeqBar(); UI.renderStrip();
    $("#q-asked").textContent = Quiz.view().asked;
    $("#swipe-hint") && $("#swipe-hint").classList.toggle("hidden", Store.settings.swipeNext === false || !r.question);
    const acc = Quiz.view().acc;
    $("#q-acc").textContent = acc == null ? "—" : acc + "%";
    const bm = Quiz.bookmark();
    $("#q-bookmark").textContent = bm.nextWord
      ? `书上进度 ${bm.done}/${bm.total} ｜ 下一个 ${bm.nextWord}`
      : `全书 ${bm.total} 词均已过完，进入复习`;
  }

  function answer(val) {
    if (!currentQ || currentQ.answered) return;
    const fb = Quiz.submit(val);
    if (!fb) return;
    if (currentQ.options) {
      currentQ.options.forEach((o) => {
        const btn = $(`.opt[data-key="${o.key}"]`);
        if (!btn) return;
        if (o.isKey) btn.classList.add("right");
        else if (o.key === val) btn.classList.add("wrong");
        else btn.classList.add("dim");
        btn.disabled = true;
      });
    } else {
      const inp = $("#answer-input");
      if (inp) { inp.value = val; inp.disabled = true; inp.blur(); }
    }
    UI.renderFeedback(fb, currentQ);
    if (fb.cleared && fb.cleared.length) {
      const u = fb.cleared[fb.cleared.length - 1];
      const left = Store.unitFlags().filter((f) => !f.cleared);
      UI.renderMode();
      UI.toast(Store.settings.autoAdvance !== false
        ? `🎉 <b>${UI.esc(u)}</b> 已通关 → ${left.length ? "进入 <b>" + UI.esc(left[0].unit) + "</b>" : "全书通关"}`
        : `🎉 <b>${UI.esc(u)}</b> 已通关，已在单元边界暂停`);
    } else UI.renderSeqBar();
    renderWrongbookSoon();
    startAuto();
  }

  function startAuto() {
    if (!Store.settings.autoNext) { $("#auto-tip").textContent = ""; return; }
    autoLeft = Math.round((Store.settings.autoNextMs || 5000) / 1000);
    $("#auto-tip").textContent = `自动下一题 ${autoLeft}s（可点上方直接进）`;
    clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      autoLeft--;
      if (autoLeft <= 0) { stopAuto(); next(); return; }
      $("#auto-tip").textContent = `自动下一题 ${autoLeft}s`;
    }, 1000);
  }
  const stopAuto = () => { clearInterval(autoTimer); autoTimer = null; $("#auto-tip") && ($("#auto-tip").textContent = ""); };

  function drillWord(id) {
    Quiz.reset({ scope: "all", wrongOnly: false, pinId: id });
    switchView("quiz");
    next();
    UI.toast("已把该词锁定为本轮第一题（仍会按规则更换题型）");
  }

  /* ---------------- 录入：离线通道 ---------------- */
  const fillOpts = () => ({
    autofill: !!$("#ingest-autofill").checked,
    pinnedUnit: Store.settings.pinnedUnit || "",      // 导入归属：手动钉住的单元/课次（文本自带标题仍优先）
    pinnedLesson: Store.settings.pinnedLesson || "",
  });

  function parseNow() {
    const raw = $("#ingest-text").value;
    if (!raw.trim()) return UI.toast("先粘贴词表，或上传 .docx / 图片。", true);
    let res;
    try { res = Parse.text(raw, fillOpts()); } catch (e) { return UI.toast("解析失败：" + UI.esc(e.message), true); }
    if (!res.candidates.length) return UI.toast(`没解析到词条${res.skipped.length ? `，已跳过 ${res.skipped.length} 行` : ""}`, true);
    const plan = Store.plan(res.candidates, $("#ingest-dedup").value);
    UI.renderPreview(plan);
    UI.toast(`解析 ${res.candidates.length} 条：新增 ${plan.summary.new}、合并 ${plan.summary.merge}、重复 ${plan.summary.dup + plan.summary.dupBatch}`);
  }

  function commit() {
    const plan = UI.commit();
    if (!plan) return UI.toast("没有待确认的词条。", true);
    const r = Store.commitPlan(plan);
    Quiz.invalidateEligible();
    UI.renderProgress(); UI.renderLibrary(); UI.renderScope(); UI.fillSettings();
    UI.toast(`入库完成：新增 <b>${r.added}</b>，合并 <b>${r.merged}</b>，忽略重复 <b>${r.dup}</b>。进度未被重置，可「撤销上次入库」。`);
  }

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    e.target.value = "";
    try {
      if (/\.json$/i.test(f.name)) {
        const txt = await f.text();
        const sniff = Store.sniffJSON(txt);
        if (sniff.isBackup) {              // 认 app 字段，改名前的旧备份（cet4-engine）也收
          const r = Store.importJSON(txt);
          UI.renderProgress(); UI.renderLibrary(); UI.renderScope(); UI.fillSettings();
          Quiz.invalidateEligible();
          return UI.toast(`备份已合并导入：新增 ${r.added}、合并 ${r.merged}、重复 ${r.dup}`);
        }
        // 不是合法 JSON 时别把 V8 的术语丢给用户：说清是哪个文件、断在哪、可以怎么办
        if (sniff.error) {
          const at = (/at position (\d+)/.exec(sniff.error) || [])[1];
          throw new Error(`${f.name} 不是合法 JSON${at ? `（第 ${Number(at) + 1} 个字符处断掉）` : ''}。`
            + `若它是导出的备份，请确认导出过程没被打断；若是词表，请改用 .docx/.csv 或直接把内容粘到文本框。原始信息：${sniff.error}`);
        }
        const res = Parse.json(txt, fillOpts());
        UI.renderPreview(Store.plan(res.candidates, $("#ingest-dedup").value));
        return;
      }
      const res = await Parse.file(f, fillOpts());
      if (!res.candidates.length) return UI.toast("文件里没解析到词条，请把内容直接粘贴到文本框。", true);
      const plan = Store.plan(res.candidates, $("#ingest-dedup").value);
      UI.renderPreview(plan);
      UI.toast(`从 ${UI.esc(f.name)} 解析 ${res.candidates.length} 条：新增 ${plan.summary.new}、合并 ${plan.summary.merge}、重复 ${plan.summary.dup + plan.summary.dupBatch}`);
    } catch (err) {
      UI.toast("读取失败：" + UI.esc(err.message), true);
    }
  }

  /* ---------------- 录入：AI 通道 ---------------- */
  /** 只挑「缺音标或缺例句」的词做补全，避免重复消耗 token */
  function aiTargetList() {
    return Store.words.filter((w) => !w.enriched).slice(0, 20);
  }

  let aiBusy = false;
  function aiStatus(html, cls) {
    const z = $("#ai-zone");
    if (z) z.innerHTML = `<p class="ai-status ${cls || ""}">${html}</p>`;
  }
  async function aiDirect(list) {
    if (aiBusy) return UI.toast("上一次调用还没结束，先看「录入」页的状态。", true);
    list = (Array.isArray(list) && list.length) ? list : aiTargetList();
    if (!list.length) return UI.toast("当前没有「缺音标/例句」的词；如需重新补全，请在词条里清空字段或手动指定。", true);
    // 结果画在「录入」页的预览区里。不切过去就是"点了没反应"的头号成因：
    // 词库单元卡上的「补全 N 项」也走这里，用户当时人还在词库页。
    switchView("ingest");
    const sec = AI.timeoutSec();
    aiBusy = true;
    aiStatus(`正在调用端点补全 <b>${list.length}</b> 词…（最长等 ${sec} 秒，超时会中断并说明原因）`, "run");
    UI.toast("正在调用端点补全 " + list.length + " 词…");
    try {
      const res = await AI.enrichDirect(list.map((w) => ({ word: w.word, definition: w.definition, senses: w.senses })));
      if (!res.candidates.length) {
        aiStatus("端点回应了，但回复里没有 words 数组——多半是模型没按契约只输出 JSON。可改用「复制粘贴桥」再粘一次。", "bad");
        return UI.toast("模型没返回词条。", true, 6000);
      }
      aiStatus(`✅ 端点返回 ${res.candidates.length} 词，已在下方生成入库预览（确认后才写库）。`, "ok");
      UI.renderPreview(Store.plan(res.candidates, "merge"));
      $("#pv-summary").insertAdjacentHTML("beforeend", `<span class="tag acc">AI 补全结果：确认后将只填空缺字段</span>`);
    } catch (e) {
      aiStatus("❌ " + UI.esc(e.message) + ' <button class="ghost" id="ai-fallback">改用复制粘贴桥</button>', "bad");
      const fb = $("#ai-fallback");
      if (fb) fb.onclick = () => aiBridge(list);
      UI.toast(UI.esc(e.message), true, 8000);
    } finally { aiBusy = false; }
  }

  function aiBridge(prefList) {
    const list = prefList && prefList.length ? prefList : aiTargetList();
    const zone = $("#ai-zone");
    zone.innerHTML = `<p class="muted small">把下面这段丢给任意大模型（网页版 ChatGPT / DeepSeek / 通义都行），再把它的回复整段粘回来。</p>
      <textarea id="bridge-out" rows="7" readonly>${UI.esc(AI.bridgePrompt(list.length ? list : [{ word: "accommodate", definition: "" }]))}</textarea>
      <div class="row"><button class="ghost" id="btn-copy-prompt">复制 Prompt</button></div>
      <textarea id="bridge-in" rows="5" placeholder="粘贴模型返回的 JSON（可以带 \`\`\` 代码块，会自动剥离）"></textarea>
      <div class="row"><button class="primary" id="btn-bridge-parse">解析回复并生成入库预览</button></div>`;
    $("#btn-copy-prompt").onclick = async () => {
      try { await navigator.clipboard.writeText($("#bridge-out").value); UI.toast("已复制"); }
      catch (e) { $("#bridge-out").select(); document.execCommand && document.execCommand("copy"); UI.toast("已选中，按 Ctrl+C 复制"); }
    };
    $("#btn-bridge-parse").onclick = () => {
      try {
        const res = AI.parseContract($("#bridge-in").value || $("#bridge-out").value);
        if (!res.candidates.length) return UI.toast("回复里没有 words 数组。", true);
        UI.renderPreview(Store.plan(res.candidates, "merge"));
        if (res.reply) UI.toast(UI.esc(res.reply));
      } catch (e) { UI.toast(UI.esc(e.message), true); }
    };
  }

  async function aiOne(w) {
    if (aiBusy) return UI.toast("上一次调用还没结束（看「录入」页的状态）。", true);
    aiBusy = true;
    UI.toast(`正在补全 ${w.word}…（最长 ${AI.timeoutSec()} 秒）`);
    try {
      const res = await AI.enrichDirect([w]);
      const got = res.candidates[0];
      if (!got) return UI.toast("模型没返回内容。", true, 6000);
      Store.update(w.id, {
        phonetic: got.phonetic || w.phonetic, collocation: got.collocation || w.collocation,
        example_en: got.example_en || w.example_en, example_zh: got.example_zh || w.example_zh,
      });
      UI.closeModal(); UI.renderLibrary(); UI.renderProgress();
      UI.toast(`已补全 <b>${UI.esc(w.word)}</b>`);
    } catch (e) { UI.toast(UI.esc(e.message), true, 8000); }
    finally { aiBusy = false; }
  }

  function intentExtract() {
    const zone = $("#ai-zone");
    zone.innerHTML = `<div class="field"><label>一句话抓词（本地即可，无需模型）</label>
      <input id="intent-in" placeholder="例：把 undertake、give rise to 和 accommodate 加入生词本"></div>
      <div class="row"><button class="primary" id="btn-intent">提取</button></div>
      <pre id="intent-out" class="hidden"></pre>`;
    $("#btn-intent").onclick = () => {
      const out = AI.extractIntent($("#intent-in").value || "");
      $("#intent-out").classList.remove("hidden");
      $("#intent-out").textContent = JSON.stringify(out, null, 2);
      if (out.has_words) UI.renderPreview(Store.plan(Parse.json(JSON.stringify(out)).candidates, $("#ingest-dedup").value));
      else UI.toast("没抓到需要收录的词。");
    };
  }

  async function onImage(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    e.target.value = "";
    try {
      const res = await AI.fromImage(f);
      UI.renderPreview(Store.plan(res.candidates, $("#ingest-dedup").value));
      UI.toast(`图片识别出 ${res.candidates.length} 词，请确认入库`);
    } catch (err) { UI.toast(UI.esc(err.message), true); }
  }

  /* ---------------- Mode 3 ---------------- */
  let wrTask = null;                      // 面板显示与批改必须用同一批词
  function renderWriting() {
    const task = Quiz.writingTask();
    wrTask = task;
    $("#wr-task").innerHTML = task
      ? `<div class="row">` + task.map((t) => `<span class="tag warn" title="${UI.esc(t.def)}">${UI.esc(t.word)}${t.col ? " · " + UI.esc(t.col) : ""}</span>`).join("") + `</div>`
      : `<p class="muted small">错题/未掌握词不足 3 个，先从测验里攒几个错词。</p>`;
    $("#wr-result").innerHTML = "";
    return task;
  }
  function gradeWriting(useAI) {
    const task = wrTask || Quiz.writingTask();
    const text = $("#wr-input").value.trim();
    if (!task) return UI.toast("先积累 3 个错词。", true);
    if (text.length < 8) return UI.toast("写点内容再批改。", true);
    if (useAI && AI.available()) {
      Writing.gradeAI(task, text).then((j) => {
        $("#wr-result").innerHTML = `<pre>${UI.esc(JSON.stringify(j, null, 2))}</pre>`;
      }).catch((e) => UI.toast(UI.esc(e.message), true));
      return;
    }
    const r = Writing.gradeOffline(task, text);
    $("#wr-result").innerHTML = `
      <div class="row">` + r.lines.map((l) => `<span class="tag ${l.used ? "ok" : "bad"}">${UI.esc(l.word)} ${l.used ? "已用上" : "未使用"}</span>`).join("") + `</div>
      <p class="small">字数 <b>${r.words}</b> ｜ 参考分 <b>${r.score}</b>/100${r.missing.length ? ` ｜ 建议把 <b>${UI.esc(r.missing.join("、"))}</b> 写进段落` : ""}</p>
      <div class="list">${r.tips.map((t) => `<div class="litem"><div>${t}</div><div class="acts">↗</div></div>`).join("")}</div>
      <p class="muted small">离线规则批改；在设置里配置端点后可用「AI 精批」。</p>`;
  }
  function genReading() {
    const r = Quiz.readingTask({ useWrong: $("#rd-usewrong").checked });
    if (r.error) return UI.toast(UI.esc(r.error), true);
    $("#rd-result").innerHTML = `
      <p class="small">${UI.esc(r.passage)}</p>
      <p class="muted small">全文 ${r.length} 词 ｜ 覆盖生词：${r.glossary.map((g) => `<span class="tag">${UI.esc(g.word)} ${UI.esc(g.def)}</span>`).join("")}</p>
      <p class="muted small">离线拼装说明：句子直接取自你词库里的真实例句，因此<b>语法正确但主题不连贯</b>——练的是「在语境里认出这个词」，不是读篇章。配好 AI 端点后可让模型生成主题统一的一体化短文。</p>
      <h4>长难句拆解</h4>
      <div class="list">${r.analysis.chunks.map((c) => `<div class="litem"><div><span class="tag acc">${UI.esc(c.label)}</span> ${UI.esc(c.text)}</div></div>`).join("")}</div>
      <p class="muted small">${UI.esc(r.analysis.tip)}</p>`;
  }

  /* ---------------- 单元级操作（词库按单元分类后的入口） ---------------- */
  function focusUnit(unit) {
    Quiz.reset({ scope: unit, override: unit, wrongOnly: false });
    UI.renderMode(); UI.renderScope();
    switchView("quiz");
    next();
    UI.toast(`出题范围锁定 <b>${UI.esc(unit)}</b>：新词按书序推进，错题在复习配额内插队轮转（点「▶ 继续学习」回到顺序线）`);
  }

  /** 背诵页标完「不熟」→ 一键进测验只练这些词。
   *  范围切到 free+weak，但判定规则完全不变：仍走同一套加权、冷却与"必须换题型"。 */
  function drillWeak() {
    const n = Store.weakCount();
    if (!n) { UI.toast("还没有标记「背不熟」的词 —— 先在背诵页点几下 ☆", true); return; }
    Store.setSetting("mode", "free");
    Quiz.reset({ scope: "weak", override: null, wrongOnly: false });
    UI.renderMode(); UI.renderScope();
    switchView("quiz");
    next();
    UI.toast(`只练不熟：${n} 个词（出题规则不变，仍会换题型复现错题）`);
  }

  /* ---------------- 滑动切题（左右滑均为下一题；未答先跳过） ---------------- */
  function attachSwipe(el) {
    if (!el || el.dataset.sw) return;
    el.dataset.sw = "1";
    let x0 = 0, y0 = 0, t0 = 0, on = false;
    const rest = () => { el.style.setProperty("--dx", "0px"); el.classList.remove("swiping"); };
    el.addEventListener("pointerdown", (e) => {
      if (Store.settings.swipeNext === false) return;
      if (e.target.closest("input,textarea,select,.seg,.seqbar,.table-wrap,.sheet,.litem")) return;
      on = true; x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); el.classList.add("swiping");
    });
    el.addEventListener("pointermove", (e) => {
      if (!on) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;      // 竖向滚动不劫持
      el.style.setProperty("--dx", Math.max(-46, Math.min(46, dx * 0.4)) + "px");
    });
    const finish = (e) => {
      if (!on) return;
      on = false;
      const dx = e.clientX - x0, dy = e.clientY - y0, dt = Date.now() - t0;
      rest();
      if (dt > 700 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      swipeGo();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", () => { on = false; rest(); });
  }

  function swipeGo() {
    if (currentQ && !currentQ.answered) {
      const s = Quiz.skip();
      if (s) UI.toast(`已跳过 <b>${UI.esc(s.word)}</b>（不计分、不判错，稍后会再出现）`);
    }
    stopAuto();
    next();
  }

  /* ---------------- 顺序闯关：继续 / 回看 / 返回 ---------------- */
  function continueLearning() {
    Store.setSetting("mode", "sequence");
    Quiz.reset({ override: null, wrongOnly: false, scope: "all" });
    UI.renderMode(); UI.renderScope(); UI.renderProgress();
    switchView("quiz");
    next();
    const cur = Store.currentUnit();
    UI.toast(cur ? `顺序线：当前单元 <b>${UI.esc(cur)}</b>` : "全书单元均已通关，现在可自由回看");
  }
  function visitUnit(label) {
    Quiz.reset({ override: unit, wrongOnly: false });
    UI.renderMode(); UI.renderScope();
    switchView("quiz");
    next();
    UI.toast(`正在回看 <b>${UI.esc(unit)}</b>（顺序线已暂停，点「▶ 继续学习」返回）`);
  }
  /** 题型方案：mixed 混合轮换（原方案）或单一专项 */
  function setPlan(k) {
    Store.setSetting("plan", k);
    Quiz.reset({});
    UI.renderPlanSeg(); UI.renderMode();
    next();
    UI.toast(k === "mixed" ? "已回到混合轮换（按设置勾选的题型轮换）" : "专项模式：只出「" + UI.PLAN_LABEL[k] + "」。掌握仍需 2 种不同题型答对");
  }
  /** 回看某个课次块或整个单元 */
  function visitBlock(label) {
    Quiz.reset({ override: label, wrongOnly: false });
    UI.renderMode(); UI.renderScope();
    switchView("quiz");
    next();
    UI.toast(`正在回看 <b>${UI.esc(label)}</b>（顺序线已暂停，点「▶ 继续学习」返回）`);
  }
  /** 改了归属后，若已有输入内容就重新解析一次，让预览同步 */
  function refreshParsePreview() {
    if (!$("#ingest-text") || !$("#ingest-text").value.trim()) return;
    parseNow();
  }
  function backToSequence() {
    Quiz.reset({ override: null });
    UI.renderMode(); UI.renderScope();
    next();
    UI.toast("已返回顺序线");
  }

  function fillUnit(unit) {
    const n0 = Store.backfill();                       // 先用内置离线词典免费补
    const list = Store.words.filter((w) => !w.enriched && Store.unitKey(w) === unit).slice(0, 20);
    Quiz.invalidateEligible();
    UI.renderLibrary(); UI.renderProgress();
    if (n0) UI.toast(`内置词典已补齐 <b>${n0}</b> 个词的音标/例句`);
    if (!list.length) return UI.toast(`<b>${UI.esc(unit)}</b> 已全部补全，语境填空与听写题现在都能出`);
    if (!AI.available()) {
      UI.toast(`词典补完后本单元仍缺 ${list.length} 项，且未配置端点 → 已为你生成复制粘贴桥的 Prompt`, true);
      switchView("ingest"); aiBridge(list);
      return;
    }
    aiDirect(list);
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    $$(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
    if (v === "library") UI.renderLibrary();
    if (v === "recite") UI.renderRecite();
    if (v === "wrongbook") UI.renderWrongbook();
    /* 录入页的钉选下拉在 boot 里被推迟了，切进来时补上。
       bindPins 自己有 dataset.bound 幂等保护，重复调用不会绑两遍。 */
    if (v === "ingest") { UI.renderPins(); UI.bindPins(); }
    if (v === "advanced") renderWriting();
  }
  const renderWrongbookSoon = () => { if ($("#view-wrongbook").classList.contains("active")) UI.renderWrongbook(); };

  /* ---------------- 绑定 ---------------- */
  function bind() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
    $("#btn-settings").onclick = () => { UI.fillSettings(); $("#drawer").classList.remove("hidden"); $("#drawer-mask").classList.remove("hidden"); };
    $("#btn-close-drawer").onclick = $("#drawer-mask").onclick = () => { $("#drawer").classList.add("hidden"); $("#drawer-mask").classList.add("hidden"); };
    $("#modal-close").onclick = $("#modal-cancel").onclick = UI.closeModal;
    UI.bindAsk();                                 // 页内确认/输入弹层（鸿蒙没有默认 JS 弹框）

    $("#btn-continue").onclick = continueLearning;
    $("#btn-qbar").onclick = () => {
      const sh = $("#quiz-sheet"); const open = sh.classList.toggle("hidden") === false;
      $("#btn-qbar").setAttribute("aria-expanded", open ? "true" : "false");
    };
    attachSwipe($("#quiz-stage")); attachSwipe($("#feedback"));
    $("#btn-reset-session").onclick = () => { Quiz.reset({ dailyCap: 0 }); UI.renderScope(); UI.renderMode(); next(); UI.toast("已重开一轮（错题优先级仍最高）"); };
    $("#btn-next").onclick = () => { stopAuto(); next(); };
    $("#scope-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-scope]"); if (!b) return;
      const v = b.dataset.scope;
      if (v === "wrong") {
        Quiz.reset({ wrongOnly: true, override: null });
        UI.renderMode(); UI.renderScope(); next(); return;
      }
      if (Store.settings.mode === "sequence") {
        const FREE = { all: "全部词库", unmastered: "未掌握", weak: "只练不熟" };
        if (FREE[v]) {                                            // 顺序模式里点这些＝切到自由范围
          Store.setSetting("mode", "free");
          Quiz.reset({ wrongOnly: false, scope: v, override: null });
          UI.renderMode(); UI.renderScope(); next();
          UI.toast(`已切换自由模式，范围：<b>${UI.esc(FREE[v])}</b>`);
          return;
        }
        visitUnit(v); return;                                    // 点单元＝回看该单元（顺序线暂停）
      }
      Quiz.reset({ wrongOnly: false, scope: v, override: null });
      UI.renderScope(); next();
    });

    $("#btn-parse").onclick = parseNow;
    $("#btn-pv-commit").onclick = commit;
    $("#btn-pv-discard").onclick = () => { $("#preview-panel").hidden = true; UI.commit(); UI.toast("已丢弃本次预览"); };
    $("#ingest-file").onchange = onFile;
    $("#ingest-image") && ($("#ingest-image").onchange = onImage);
    $("#btn-ai-direct").onclick = () => aiDirect();     // 不能直接把 aiDirect 交给 onclick：那样第一个实参是 Event 对象
    $("#btn-ai-bridge").onclick = aiBridge;
    $("#btn-intent-open").onclick = intentExtract;
    $("#btn-undo-import").onclick = () => {
      const u = Store.undo();
      if (!u) return UI.toast("没有可撤销的操作（只保留最近一次入库或批量删除）。", true);
      UI.renderProgress(); UI.renderLibrary(); UI.renderWrongbook();
      if ($("#view-recite").classList.contains("active")) UI.renderRecite();   // 撤销回来的词带着当初的不熟标记
      UI.toast(`已回滚到 ${new Date(u.at).toLocaleTimeString()} 的 ${u.count} 词状态`);
    };

    $("#btn-lib-sort").onclick = (e) => { e.target.textContent = "排序：" + UI.cycleSort(); };
    $("#btn-lib-group").onclick = () => {
      Store.setSetting("libGroup", Store.settings.libGroup === false);
      UI.renderLibrary();
      UI.toast(Store.settings.libGroup !== false ? "词库已按单元分组" : "词库已切换为平铺（顺序仍按书）");
    };
    /* 搜索防抖：整表重建在 3000 词时是百毫秒级，
       逐键重建会让输入框看起来"吞字"。停 140ms 再渲染，手感与结果都不变。 */
    let libDebounce = 0;
    $("#lib-search").oninput = () => { clearTimeout(libDebounce); libDebounce = setTimeout(() => UI.renderLibrary(), 140); };
    $("#lib-unit").onchange = () => UI.renderLibrary();
    $("#lib-status").onchange = () => UI.renderLibrary();
    $("#btn-del-unit").onclick = () => { const u = $("#lib-unit").value; if (u) UI.askScopeDelete("unit", u); };

    $("#btn-wb-clear").onclick = async () => {
      if (!(await UI.askConfirm("清空全部错题记录（词条本身保留，状态回到待测）？", { okText: "清空", danger: true }))) return;
      Store.words.forEach((w) => { if (w.status === "wrong") { w.status = "new"; w.srs.wrongReason = ""; w.srs.correctTypes = []; w.srs.weight = 0; } });
      Store.save(); UI.renderWrongbook(); UI.renderProgress(); UI.toast("已清空错题本");
    };
    $("#btn-wb-drill").onclick = () => { Quiz.reset({ wrongOnly: true, override: null }); UI.renderMode(); UI.renderScope(); switchView("quiz"); next(); UI.toast("已切到错题专练"); };

    $("#btn-wr-check").onclick = () => gradeWriting(false);
    $("#btn-rd-gen").onclick = genReading;

    $("#chk-autonext").onchange = (e) => Store.setSetting("autoNext", e.target.checked);
    $("#set-daily").oninput = (e) => { Store.setSetting("daily", +e.target.value); $("#daily-val").textContent = e.target.value; };
    $("#set-sound").onchange = (e) => Store.setSetting("sound", e.target.checked);
    $("#set-review").oninput = (e) => { Store.setSetting("reviewShare", +e.target.value / 100); $("#review-val").textContent = e.target.value + "%"; };
    $("#set-order").onchange = (e) => Store.setSetting("strictOrder", e.target.checked);
    $("#set-pass").oninput = (e) => {
      Store.setSetting("passRatio", +e.target.value / 100);
      $("#pass-val").textContent = e.target.value + "%";
      UI.renderSeqBar(); UI.renderMode();
    };
    $("#set-autoadv").onchange = (e) => Store.setSetting("autoAdvance", e.target.checked);
    $("#set-carry").onchange = (e) => { Store.setSetting("carryWrong", e.target.checked); UI.renderSeqBar(); };
    $("#set-swipe").onchange = (e) => { Store.setSetting("swipeNext", e.target.checked); UI.renderStrip(); UI.toast(e.target.checked ? "已开启滑动切题" : "已关闭滑动切题"); };
    $("#set-dedup").onchange = (e) => { Store.setSetting("dedup", e.target.value); $("#ingest-dedup").value = e.target.value; };
    $("#ingest-dedup").onchange = (e) => Store.setSetting("dedup", e.target.value);
    $("#set-usepool").onchange = (e) => { Store.setSetting("usePool", e.target.checked); UI.toast("扩展池出题不入库，重开页面后其进度不保留"); };
    const resetProbe = () => { const el = $("#ai-probe-out"); if (el) { el.className = "mini muted"; el.textContent = "未测试"; } };
    $("#btn-ai-probe").onclick = async () => {
      const el = $("#ai-probe-out"); if (!el) return;
      el.className = "mini muted"; el.textContent = "正在连接…";
      const r = await AI.probe();
      el.className = "mini " + (r.ok ? "ok" : "warn");
      el.textContent = r.msg;
      UI.toast(r.ok ? "✅ 端点可用" : "❌ " + r.msg, !r.ok);
    };
    $("#set-ai-base").onchange = (e) => { Store.setSetting("ai.baseURL", e.target.value.trim()); resetProbe(); };
    $("#set-ai-model").onchange = (e) => Store.setSetting("ai.model", e.target.value.trim());
    $("#set-ai-key").onchange = (e) => { Store.setSetting("ai.key", e.target.value.trim()); resetProbe(); };
    $("#set-ai-timeout").onchange = (e) => {
      const n = Math.min(600, Math.max(10, +e.target.value || 90));
      Store.setSetting("ai.timeout", n);
      e.target.value = n;                                  // 立刻回显被收敛后的值，别让人以为填生效了
      UI.toast(`AI 单次请求上限 ${n} 秒`);
    };

    $("#btn-export").onclick = () => {
      const text = Store.exportJSON();
      const name = `noadic-备份-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      const kb = Math.round(text.length / 1024);
      // 壳内（安卓 Capacitor / 鸿蒙 ArkWeb）<a download> 都不会把文件交给用户：
      // Capacitor 整个依赖树里没有任何 DownloadListener（实测点完全盘搜不到文件、
      // 系统下载器也没参与），ArkWeb 则落进应用私有目录。
      // 备份是这个 App 唯一的跨设备迁移动作，静默失败等于骗人，所以壳内一律摊开文本给复制。
      if (UI.isNativeShell()) {
        const where = UI.isArkWeb() ? "鸿蒙" : "安卓";
        UI.toast(`${where}壳内下载不会落地，已改为可复制的文本`, true, 5000);
        UI.openCopyBox("复制这份备份", text,
          `${where}的应用壳不把下载文件交给你（点了不会有任何文件出现）。请长按下面文本框全选复制，`
          + `存进备忘录或任意文本文件，文件名用：${name}　（约 ${kb} KB）`);
      } else {
        UI.toast(`已导出 ${name}（约 ${kb} KB）`);
      }
    };
    $("#btn-import").onchange = onFile;
    $("#btn-wipe").onclick = async () => {
      if (!(await UI.askConfirm("彻底清空词库与进度？建议先导出 JSON。", { okText: "全部清空", danger: true }))) return;
      Store.wipe(); UI.renderProgress(); UI.renderLibrary(); UI.renderWrongbook(); UI.renderScope(); next();
      UI.toast("已清空，可去「录入」重新导入");
    };

    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
        if (e.key === "Enter" && currentQ && !currentQ.answered && $("#answer-input") && document.activeElement.id === "answer-input") { /* handled in ui */ }
        return;
      }
      if (currentQ && !currentQ.answered && currentQ.options) {
        const k = e.key.toUpperCase();
        const map = { "1": "A", "2": "B", "3": "C", "4": "D", "A": "A", "B": "B", "C": "C", "D": "D" };
        if (map[k]) { e.preventDefault(); const opt = currentQ.options.find((o) => o.key === map[k]); if (opt) answer(opt.key); }
      } else if (e.key === "Enter" || e.key === " ") {
        if (currentQ && currentQ.answered) { e.preventDefault(); next(); }
      }
    });
  }

  function boot() {
    Store.load();
    /* 首屏只画"看得见的那一屏"。词库/错题本/设置抽屉在启动时都不可见，
       但 20 倍降频实测 renderLibrary 要 177ms —— 全堆在首屏前面就是白屏时间。
       切到对应标签时 switchView 会自己重渲染，所以推迟不会漏画。 */
    UI.renderProgress(); UI.renderScope(); UI.renderMode();
    bind();
    next();
    const defer = () => {
      try { UI.fillSettings(); UI.renderLibrary(); UI.renderWrongbook(); UI.renderPins(); UI.bindPins(); }
      catch (e) { /* 延后渲染失败不该拖垮已经可用的首屏 */ }
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(defer, { timeout: 1500 });
    else setTimeout(defer, 0);
    if (!Store.words.length) UI.emptyStage("词库为空。去「录入」粘贴 <code>英文单词 ⇥ 词性及中文释义</code>，或上传 <code>.docx</code>。");
    else {
      const touch = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
      UI.toast(`已载入 ${Store.words.length} 词` + (touch ? "，点选项即可作答" : "，按 1/2/3/4 或 A/B/C/D 作答"));
    }
    // PWA：只在浏览器 http(s) 下注册 SW。Capacitor 壳里资源已是原生打包的，
    // 再套一层 SW 缓存会在 App 更新后继续吐旧 JS（白屏／改了没生效的经典成因）。
    // 鸿蒙 ArkWeb 里资源同样是只读打包进 HAP 的（resource:// 协议），一样不该套 SW。
    const inNativeApp = !!window.Capacitor || /^capacitor:/i.test(location.protocol) || UI.isArkWeb();
    if (!inNativeApp && location.protocol !== "file:" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => { });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  return { boot, answer, next, swipeGo, drillWord, aiOne, switchView, focusUnit, drillWeak, fillUnit, continueLearning, visitUnit, visitBlock, backToSequence, setPlan, refreshParsePreview, UI };
})();
if (typeof window !== "undefined") window.app = app;
