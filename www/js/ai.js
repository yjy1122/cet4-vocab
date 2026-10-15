/* =========================================================================
 * ai.js — Mode 1 引擎（数据补全）与 Mode 3 批改
 * 三条通道：① 本地零网络（意图提取 + 内置词典） ② 复制粘贴桥（任何大模型都能用）
 *           ③ 直连 OpenAI 兼容端点（含视觉模型拍照识别；受 CORS 限制，失败会明确提示）
 * 契约恒定：has_words / reply_message / words[{word,phonetic,pos,definition,collocation,example_en,example_zh}]
 * ========================================================================= */
const AI = (() => {
  const cfg = () => Store.settings.ai || {};
  const available = () => !!(cfg().baseURL && cfg().baseURL.trim() && cfg().key && cfg().key.trim());

  const SPEC = [
    "你是 noadic录入引擎（Mode 1）。必须且仅能输出纯 JSON 字符串，禁止 Markdown 代码块、禁止任何解释文字。",
    "规则：1) 过滤 a/the/is/at 等极简词，但保留其作为核心短语一部分的词；2) 单词统一还原英文原形(Lemma)；",
    "3) 每个词补齐 英式IPA、CET-4 核心考点释义、常见搭配、1 个四级难度例句（含译文）；",
    "4) 若用户已给出中文释义，以用户释义为准，只做补全不得改写；5) 若没有需要收录的词，words 返回空数组且 has_words 为 false。",
    "输出结构：" + Parse.CONTRACT,
  ].join("\n");

  /* ---------- ① 本地意图提取（离线，无需模型） ---------- */
  // 「把 accommodate、address 加进生词本」→ 直接抓出词形
  function extractIntent(text) {
    const found = [];
    const push = (w) => {
      w = String(w).trim().replace(/^[.·、,，;；:：!！?？”“"'`]+|[.·、,，;；:：!！?？”“"'`]+$/g, "");
      if (!w) return;
      const clean = w.replace(/\s+/g, " ");
      if (!/^[A-Za-z][A-Za-z()'’\-\./ ]{1,28}$/.test(clean)) return;
      const kw = Lex.norm(clean.split("/")[0].replace(/\((.)\)/g, "$1"));
      if (STOP.has(kw)) return;
      if (!found.some((f) => Lex.norm(f) === kw)) found.push(clean);
    };
    // a) 显式动词句式：把/将 X 加(进)生词本 —— 只取动词与目标之间区域里的英文 token
    let m = String(text).match(/[把将]([^，,。;；]{1,120}?)(?:加|加入|收录|录入|记|存)(?:入|到|进)?([^，,。;；]{0,20}?)(?:生词本|词汇本|单词本|词库|本子)/);
    if (m) {
      ((m[1] + " " + m[2]).match(/[A-Za-z][A-Za-z'’\-\/\.()]{1,}/g) || []).forEach(push);
    }
    // b) 引号/书名号内
    (String(text).match(/[“"'`「『]([A-Za-z][A-Za-z()'’\-\./ ]*)[”"'』」]/g) || []).forEach((s) => push(s.slice(1, -1)));
    // c) 「X 这个词 / X 生词」
    (String(text).match(/([A-Za-z][A-Za-z\-/'()]{2,})\s*(?:这|那)?个?\s*(?:单词|词|生词|词汇)/g) || []).forEach((s) => push(s.split(/\s/)[0]));
    // d) 兜底：只收「中文环境里隔离出现的单个英文词」——绝不逐词吞掉整句英文
    if (!found.length) {
      const runs = String(text).split(/[一-鿿　-〿，,、。；;：:！？!?（）()【】[\]"'“”‘’《》]+/g);
      runs.map((s) => s.trim()).filter(Boolean).forEach((seg) => {
        const parts = seg.split(/\s+/).filter(Boolean);
        if (parts.length === 1 && /^[A-Za-z][A-Za-z'’\-]{3,}$/.test(parts[0])) push(parts[0]);
      });
    }
    const words = Parse.text(found.join("\n")).candidates.map(toContract);
    return {
      has_words: words.length > 0,
      reply_message: words.length ? `已为你识别并提取 ${words.length} 个四级词汇，请确认入库：` : "这段话里没有识别到需要收录的四级生词。",
      words,
    };
  }
  const STOP = new Set(["a", "an", "the", "is", "are", "was", "were", "at", "in", "on", "of", "to", "and", "or", "i", "you", "he", "she", "it", "we", "they", "this", "that", "my", "me", "do", "does", "did", "word", "words", "cet", "vocab", "app"]);

  const toContract = (c) => ({
    word: c.word,
    phonetic: c.phonetic || "",
    pos: (c.senses && c.senses[0] && c.senses[0].pos) || "",
    definition: (c.senses || []).map((s) => (s.pos ? s.pos + " " : "") + s.meaning).join(" ") || c.definition || "",
    collocation: c.collocation || "",
    example_en: c.example_en || "",
    example_zh: c.example_zh || "",
    unit: c.unit || "",
    source: c.source || "ai",
  });

  /* ---------- ② 复制粘贴桥 ---------- */
  function bridgePrompt(cands) {
    const list = cands.map((c) => ({ word: c.word, 中文释义: c.definition || (c.senses || []).map((s) => s.meaning).join("；") })).slice(0, 60);
    return SPEC + "\n\n现在请为下列单词补全 IPA / 搭配 / 例句（中文释义保持原样）：\n" + JSON.stringify(list, null, 1) +
      "\n\n只输出 JSON。";
  }

  /* ---------- ③ 直连端点 ---------- */
  /* 单次请求的墙钟上限（秒）。没有它，端点不通/模型慢就会让界面永远停在
     "正在调用…"——用户看到的"点了没反应"其实是这里，不是没发请求。 */
  function timeoutSec() {
    const n = Number(cfg().timeout);
    // 收敛而不是回退：填 3 秒的人要的是"快点失败"，直接跳到 90 反而违背他的意思
    if (!Number.isFinite(n) || n <= 0) return 90;
    return Math.min(600, Math.max(10, Math.round(n)));
  }

  /** 每批送多少个词。默认 20：一次要生成 IPA+搭配+例句+译文，批太大模型容易输出到一半截断，
   *  批太小则请求数与限流风险上升。上限受 MAX_PER_REQUEST 约束。 */
  function batchSize() {
    const n = Number(cfg().batch);
    if (!Number.isFinite(n) || n <= 0) return 20;
    return Math.min(MAX_PER_REQUEST, Math.max(1, Math.round(n)));
  }

  async function chat(messages, opts) {
    const c = cfg();
    if (!available()) throw new Error("未配置 AI 端点：在「设置 → AI 端点」填 Base URL 与 Key，或改用「复制粘贴桥」。");
    const url = c.baseURL.replace(/\/+$/, "") + "/chat/completions";
    const sec = timeoutSec();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), sec * 1000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.key },
        signal: ctrl.signal,
        body: JSON.stringify({ model: c.model || "gpt-4o-mini", temperature: 0.2, messages, response_format: (opts || {}).json !== false ? { type: "json_object" } : undefined }),
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || ctrl.signal.aborted)) {
        throw new Error(`端点 ${sec} 秒内没有响应，已中断等待。本地模型（Ollama 等）首次加载权重可能超时——把「设置 → AI 端点 → 超时」调大，或改用「复制粘贴桥」。`);
      }
      throw new Error("请求没能发出（多为浏览器 CORS 拦截或网络不通）。端点示例：Ollama 等本地服务一般允许跨域；云端请改用「复制粘贴桥」。原始信息：" + e.message);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error("端点返回 " + res.status + "：" + (await res.text()).slice(0, 200));
    const j = await res.json();
    // 有些网关（DeepSeek 的 "Service is too busy" 就是这个形状）会把错误塞进 200 的 body 里。
    // 不认出来的话只会报"没有 message.content"，把真正的原因藏起来。
    if (j && j.error) {
      const em = typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error));
      throw new Error("端点以 200 返回了错误体：" + em);
    }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error("返回体里没有 message.content");
    return content;
  }

  const stripFence = (s) => String(s).trim().replace(/^```(json|javascript)?/im, "").replace(/```$/m, "").trim();
  function parseContract(text) {
    const t = stripFence(text);
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("回复里找不到 JSON 对象。请确认让模型「只输出 JSON」。");
    const obj = JSON.parse(t.slice(start, end + 1));
    const list = Array.isArray(obj.words) ? obj.words : Array.isArray(obj) ? obj : [];
    const cands = list.filter((w) => w && w.word).map((w) => ({
      word: w.word, unit: w.unit || "",
      senses: w.definition ? [{ pos: w.pos || "", meaning: String(w.definition).replace(/^[a-z]+\.\s*/i, "") }] : [],
      definition: w.definition || "",
      phonetic: w.phonetic || "", collocation: w.collocation || "",
      example_en: w.example_en || "", example_zh: w.example_zh || "", source: "ai",
    }));
    cands.forEach(Parse.autofill);
    return { candidates: cands, reply: obj.reply_message || "", has_words: !!obj.has_words };
  }

  /** 切成不超过 n 个一批。抽成纯函数是为了能被测到：分批最容易丢尾批。 */
  function chunk(list, n) {
    const size = Math.max(1, Math.floor(n) || 1);
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /* 单次请求的词数硬上限。超过就明确报错，
     绝不再像以前那样 cands.slice(0, 40) 静默丢掉多余的词 ——
     用户以为补全了 50 个，实际只发了 40 个，那和 4000 字符截断是同一类缺陷。 */
  const MAX_PER_REQUEST = 80;

  async function enrichDirect(cands) {
    if (cands.length > MAX_PER_REQUEST) {
      throw new Error(`一次最多送 ${MAX_PER_REQUEST} 词（当前 ${cands.length} 词），请分批调用。`);
    }
    const list = cands.map((c) => ({ word: c.word, 中文释义: c.definition || (c.senses || []).map((s) => s.meaning).join("；") }));
    const content = await chat([
      { role: "system", content: SPEC },
      { role: "user", content: "为下列单词补全 IPA/搭配/例句，中文释义保持原样，只输出 JSON：\n" + JSON.stringify(list) },
    ]);
    return parseContract(content);
  }

  /** 拍照/图片录入（需视觉模型，如 gpt-4o / qwen-vl） */
  async function fromImage(file) {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("读取图片失败"));
      fr.readAsDataURL(file);
    });
    const content = await chat([
      { role: "system", content: SPEC },
      { role: "user", content: [
        { type: "text", text: "识别图片中的生词表/笔记圈画词，提取 CET-4 核心生词并按契约输出 JSON（只输出 JSON）。" },
        { type: "image_url", image_url: { url: dataUrl } },
      ] },
    ], { json: true });
    return parseContract(content);
  }

  /* ---------- 连通性自检：把失败原因分门别类说清楚 ---------- */
  function classify(status, body, ms, ids, via) {
    const c = cfg();
    const model = (c.model || "").trim();
    const has = (n) => ids.some((x) => x === n || x.indexOf(n) >= 0);
    if (status === 200) {
      return { ok: true, kind: "ok", ms, via, models: ids.slice(0, 12), count: ids.length,
        modelOk: !model || has(model),
        msg: `连通 ✅（${ms}ms，${via === "models" ? "发现 " + ids.length + " 个模型" : "chat 试探成功"}）`
          + (model ? (has(model) ? `，已包含 ${model}` : `，但列表里没有你填的 ${model}`) : "，未填 Model 名称") };
    }
    if (status === 401 || status === 403) return { ok: false, kind: "auth", ms, msg: `鉴权失败（${status}）：API Key 无效、过期或没有该模型权限。` + (body ? `　服务端：${String(body).slice(0, 120)}` : "") };
    if (status === 404) return { ok: false, kind: "path", ms, msg: "404：Base URL 路径不对（多数端点应填到 /v1 为止，例如 https://api.openai.com/v1），或该模型名不存在。" };
    if (status === 429) return { ok: false, kind: "quota", ms, msg: "429：限流或额度不足（余额/速率限制）。" };
    if (status >= 500) return { ok: false, kind: "server", ms, msg: `服务端 ${status}：稍后重试或换模型。` + (body ? `　${String(body).slice(0, 120)}` : "") };
    return { ok: false, kind: "http", ms, msg: `HTTP ${status}` + (body ? `：${String(body).slice(0, 160)}` : "") };
  }

  /* 最小一次生成试探。必须自带超时：DeepSeek 实测会回 200 + keep-alive 永不给 body，
     不设上限的话"测试连接"自己就会挂死在那里。 */
  async function chatPing(base, H, c, budgetMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budgetMs);
    try {
      const r = await fetch(base + "/chat/completions", {
        method: "POST", headers: H, signal: ctrl.signal,
        body: JSON.stringify({ model: c.model || "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      });
      const body = await r.text().catch(() => "");
      let j = null; try { j = JSON.parse(body); } catch (e) { }
      if (j && j.error) return { ok: false, status: r.status, body: (j.error.message || JSON.stringify(j.error)).slice(0, 140) };
      const hasContent = !!(j && j.choices && j.choices[0]);
      return { ok: r.ok && hasContent, status: r.status, body: r.ok ? (hasContent ? "" : "返回体里没有 choices") : body.slice(0, 140) };
    } catch (e) {
      const aborted = e && (e && e.name === "AbortError" || ctrl.signal.aborted);
      return { ok: false, status: 0, body: aborted ? `超时中断（${Math.round(budgetMs / 1000)} 秒内没有响应）` : String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  }

  async function probe() {
    const c = cfg();
    const t0 = Date.now();
    if (!c.baseURL || !String(c.baseURL).trim()) return { ok: false, kind: "unconfigured", msg: "还没填 Base URL —— 此时只能用「复制粘贴桥」或离线词典。" };
    if (!/^https?:\/\//i.test(String(c.baseURL).trim())) return { ok: false, kind: "badurl", msg: "Base URL 需要以 http:// 或 https:// 开头。" };
    const base = String(c.baseURL).trim().replace(/\/+$/, "");
    const H = { "Content-Type": "application/json" };
    if (c.key) H.Authorization = "Bearer " + String(c.key).trim();
    let res = null, err1 = null;
    try { res = await fetch(base + "/models", { headers: H }); } catch (e) { err1 = e; }
    if (res) {
      let data = null; try { data = await res.json(); } catch (e) { }
      const ids = ((data && (data.data || data.models || data.result)) || []).map((m) => m && (m.id || m.name || m)).filter((x) => typeof x === "string");
      if (res.ok) {
        /* 关键：/models 通**不等于**能补全。DeepSeek 实测 /models 秒回 200，
           而 chat 被跨域拦死；只看前者就会报"连通 ✅"骗人。
           所以取到列表后必须再真打一次生成通道，两者都过才算通过。 */
        const cls = classify(res.status, "", Date.now() - t0, ids, "models");
        const ping = await chatPing(base, H, c, Math.min(timeoutSec() * 1000, 25000));
        if (ping.ok) return Object.assign(cls, { ms: Date.now() - t0, msg: cls.msg + "；生成通道也通了" });
        return {
          ok: false, kind: "generate", ms: Date.now() - t0,
          msg: `能取到模型列表（${ids.length} 个），但生成通道不通`
            + (ping.status ? `（HTTP ${ping.status}：${ping.body}）` : `（${ping.body}）`)
            + "。补全会失败——云端 API 多半是不放行跨域，请改用「复制粘贴桥」。",
        };
      }
      if (res.status === 404 || res.status === 405) {   // 有些端点不提供 /models，改用一次最小 chat
        try {
          const r2 = await fetch(base + "/chat/completions", {
            method: "POST", headers: H,
            body: JSON.stringify({ model: c.model || "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
          });
          return classify(r2.status, await r2.text().catch(() => ""), Date.now() - t0, [], "chat");
        } catch (e2) {
          return { ok: false, kind: "network", ms: Date.now() - t0, msg: "/models 不支持且 chat 也发不出去：" + (e2.message || e2) };
        }
      }
      return classify(res.status, JSON.stringify(data || {}).slice(0, 200), Date.now() - t0, ids, "models");
    }
    try {
      const r3 = await fetch(base + "/chat/completions", {
        method: "POST", headers: H,
        body: JSON.stringify({ model: c.model || "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      });
      return classify(r3.status, await r3.text().catch(() => ""), Date.now() - t0, [], "chat");
    } catch (e) {
      return { ok: false, kind: "network", ms: Date.now() - t0,
        msg: "请求没能发出：多为浏览器/WebView 的 CORS 拦截或网络不通（" + ((e && e.message) || e) + "）。云端 API 通常不放行跨域 —— 可用「复制粘贴桥」，或改指本地服务（Ollama 等）。" };
    }
  }
  return { SPEC, available, extractIntent, bridgePrompt, chat, parseContract, enrichDirect, fromImage, toContract, STOP, probe, classify, timeoutSec, chunk, batchSize, MAX_PER_REQUEST };
})();

/* ---------- Mode 3 写作批改（离线可用，AI 可选增强） ---------- */
const Writing = (() => {
  const UPGRADE = [
    [/很?重要/g, "of great significance / crucial"],
    [/越来越多/g, "an increasing number of"],
    [/认为/g, "hold the view that / contend that"],
    [/因为/g, "owing to / in that"],
    [/帮助/g, "assist / lend a hand to"],
    [/引起，导致/g, "give rise to / trigger"],
    [/解决问题/g, "tackle the issue / address the problem"],
    [/获得/g, "obtain / acquire"],
    [/尽力/g, "spare no effort to"],
    [/非常好的/g, "highly beneficial / rewarding"],
  ];
  function gradeOffline(task, text) {
    const t = Lex.norm(text);
    const lines = [];
    task.forEach((item) => {
      const forms = Lex.inflect(item.word).map(Lex.norm);
      const hit = forms.some((f) => f.length > 2 && t.includes(f));
      lines.push({ word: item.word, used: hit, def: item.def, col: item.col });
    });
    const missing = lines.filter((l) => !l.used).map((l) => l.word);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const tips = [];
    if (words < 25) tips.push(`段落仅 ${words} 词，四级写作一个论证段建议 35–60 词。`);
    if (!/[.。!?]"/.test(text) && !/[.;:]/.test(text)) tips.push("注意断句：一句话一个主谓，避免逗号连接（comma splice）。");
    if (/\bvery\b/i.test(text)) tips.push("very → <b>exceedingly / remarkably</b>");
    if (/\bmany\b/i.test(text)) tips.push("many → <b>a large number of / numerous</b>");
    if (/\bthink\b/i.test(text)) tips.push("think → <b>maintain / hold the view that</b>");
    if (/\bmore and more\b/i.test(text)) tips.push("more and more → <b>an increasing number of</b>");
    if (/\bhelp\b/i.test(text)) tips.push("help → <b>assist sb in doing / do one's utmost to</b>");
    if (/\bbecause of\b/i.test(text)) tips.push("because of → <b>owing to / on account of</b>");
    return { lines, missing, words, tips: tips.length ? tips : ["用词已较为书面，可再补一个「举例 + 因果」的衔接句。"], score: Math.max(40, Math.min(95, 60 + (lines.filter((l) => l.used).length * 8) + Math.min(12, Math.round(words / 5)))) };
  }
  async function gradeAI(task, text) {
    const content = await AI.chat([
      { role: "system", content: "你是大学英语四级写作评分教练。给出：是否用上所给单词、词形/搭配错误、3 条四级高分替换建议（附例句）、一个 0-100 分。输出 JSON：{used:[{word,ok,note}],score,tips:[string]}" },
      { role: "user", content: `必须使用的词：${task.map((t) => t.word).join(", ")}\n学生段落：${text}` },
    ]);
    return JSON.parse(AI.parseContract ? stripJsonLoose(content) : content);
  }
  function stripJsonLoose(s) { const a = String(s).indexOf("{"), b = String(s).lastIndexOf("}"); return s.slice(a, b + 1); }
  return { UPGRADE, gradeOffline, gradeAI };
})();
if (typeof window !== "undefined") { window.AI = AI; window.Writing = Writing; }
