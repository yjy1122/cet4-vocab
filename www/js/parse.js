/* =========================================================================
 * parse.js — 录入通道：粘贴文本 / .docx（浏览器内解压）/ .csv / .json / AI 契约
 * 与样例.docx 同构：`Unit N` 分册 + 制表符分隔两列；兼容逗号、空格、裸词三种贴法
 * ========================================================================= */
const Parse = (() => {
  const CJK = /[\u4e00-\u9fff]/;
  /* ---------- 两级结构：Unit（父）→ Lesson / List / Section（子） ---------- */
  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function cn2num(s) {
    s = String(s).trim();
    if (/^\d+$/.test(s)) return +s;
    if (s === "十") return 10;
    if (s.startsWith("十")) return 10 + (CN_NUM[s.slice(-1)] || 0);
    if (s.includes("十")) { const [a, b] = s.split("十"); return (CN_NUM[a] || 0) * 10 + (CN_NUM[b] || 0); }
    return CN_NUM[s] || 0;
  }
  const TOP_RE = /^(?:unit|module|chapter|u\.?)\s*\.?\s*([0-9]+|[一二三四五六七八九十]+)\b/i;
  const SUB_RE = /^(?:word\s*list|lesson|list|section|part|topic)\s*\.?\s*([0-9]+|[一二三四五六七八九十]+)\b/i;
  const TOP_CN_RE = /^第\s*([0-9一二三四五六七八九十]+)\s*(?:单元|模块|章)/;
  const SUB_CN_RE = /^第\s*([0-9一二三四五六七八九十]+)\s*(?:课|部分)/;
  const titleCase = (kw) => kw === "word list" ? "List" : kw[0].toUpperCase() + kw.slice(1);

  /** 识别一行的层级；返回 {level:'top'|'sub', label} 或 null */
  function headerOf(line) {
    const s = String(line).replace(/\s+/g, " ").trim();
    let m = s.match(TOP_CN_RE); if (m) return { level: "top", label: "Unit " + cn2num(m[1]) };
    m = s.match(SUB_CN_RE); if (m) return { level: "sub", label: "Lesson " + cn2num(m[1]) };
    m = s.match(TOP_RE);
    if (m) { const kw = (m[0].match(/^(unit|module|chapter|u\.?)/i) || ["unit"])[0].toLowerCase();
      return { level: "top", label: (kw.startsWith("u") ? "Unit" : titleCase(kw)) + " " + cn2num(m[1]) }; }
    m = s.match(SUB_RE);
    if (m) { const kw = (m[0].match(/^(word\s*list|lesson|list|section|part|topic)/i) || ["lesson"])[0].replace(/\s+/g, " ").toLowerCase();
      return { level: "sub", label: titleCase(kw) + " " + cn2num(m[1]) }; }
    return null;
  }
  const blockLabel = (unit, lesson) => [unit, lesson].filter(Boolean).join(" · ");
  const HEAD_CELL = /^(英文单词|单词|词汇|word|vocabulary|释义|meaning|definition|词性)/i;
  const NOISE_RE = /^(?:第?\s*\d+\s*页|page\s*\d+|p\.?\s*\d+|\d+\s*[/／]\s*\d+|[-—–=_*·.\s]+|课文|笔记|生词本|词汇表|单词表|unit\s*word\s*list)$/i;
  const ASCII_WORD = /^[A-Za-z][A-Za-z0-9()'’\-\.\/ ]*$/;
  // 纯数字 token = OCR 夹进来的页码/序号（abandon 001 / 002 (v.) / 137），从单词侧剔除
  const stripNums = (w) => String(w).split(/\s+/).filter((t) => t && !/^\d{1,4}[)）]?$/.test(t)).join(" ").trim();
  const POS_CN_MAP = {
    "及物动词": "vt.", "不及物动词": "vi.", "名词": "n.", "动词": "v.", "形容词": "adj.", "副词": "adv.",
    "介词": "prep.", "连词": "conj.", "代词": "pron.", "数词": "num.", "感叹词": "int.", "冠词": "art.", "助动词": "aux.", "缩写": "abbr.",
  };
  const SEP_RES = [/\t+/, /\s*[|｜]\s*/, /\s*[:：]\s*/, /\s+[—–]\s*/, /\s+-\s+/, /\s*[，,]\s+/, /\s{2,}/, /\s+/];

  /* ---------- 预处理：AI/OCR 提取文本的排版噪声 ---------- */
  function normalizeLine(rawLine) {
    let s = String(rawLine).replace(/\u00a0/g, " ").replace(/\r/g, "").trim();
    if (!s) return "";
    if (/[|｜]/.test(s)) {                                   // Markdown 表格行 → Tab 分隔
      const cells = s.replace(/^\|/, "").replace(/\|$/, "").split(/[|｜]/).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) return "";
      s = cells.filter((c) => c !== "").join("\t");
    }
    s = s.replace(/\*\*|__|~~|`/g, "");                     // markdown 加粗/行内码
    s = s.replace(/^\s*(?:\d{1,4}(?:\s*[.、)]|\s+)|\(\d+\)|[•·◦*]+|[-–—]+)\s*/, "");   // 序号/页码/项目符号（含 001 abandon 这种行首页码）
    return s.trim();
  }

  /** 从释义里拆出内联音标： realm /relm/ n. 领域 → {def, ph} */
  function extractPhonetic(def) {
    const m = def.match(/(^|\s)([\/\[∕])([a-zA-Zˈˌːæɒʃθðŋəɜɪʊʌ3ˤ'’\.\-\s,;:|!∣]{2,60}?)([\/\]])/);
    if (!m) return { def, ph: "" };
    const ph = "/" + m[3].trim() + "/";
    const rest = (def.slice(0, m.index) + " " + def.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    return { def: rest, ph };
  }

  /** 拆出 AI 顺手带出来的例句： …；例：The hotel can accommodate 500. 这家酒店… */
  function extractExample(def) {
    const m = def.match(/(?:^|[\s；;，,])\s*(?:例句?|Example|ex\.?)\s*[:：]\s*/i);
    if (!m) return { def, en: "", zh: "" };
    const head = def.slice(0, m.index).replace(/[\s；;，,]+$/, "");
    const tail = def.slice(m.index + m[0].length).trim();
    const cm = tail.match(/^([A-Za-z0-9 ,'’\-\.\?!:;()"]{6,}?)\s*([\u4e00-\u9fff][\s\S]*)$/);
    if (cm) return { def: head, en: cm[1].trim(), zh: (cm[2] || "").trim() };
    return { def: head, en: tail, zh: "" };
  }

  /** 「（n.）」「(名词)」等词性括号归位到释义开头 */
  function fixPosBrackets(w, d) {
    const take = (s) => {
      const m = s.match(/[（(]\s*([^）)]{1,12})\s*[)）]/);
      if (!m) return null;
      const inner = m[1].trim();
      const pos = POS_CN_MAP[inner] || (/^(n|v|adj|adv|prep|conj|pron|num|int|art|aux|abbr|vt|vi|a|ad)\.?$/i.test(inner) ? inner.replace(/\.?$/, ".") : null);
      if (!pos) return null;
      return { word: s.replace(m[0], "").trim(), def: pos + " " + d };
    };
    let r = take(w);
    if (r) return [r.word, r.def];
    const m2 = d.match(/^[（(]\s*((?:及物|不及物)?[名动形副介连代数感冠助][词语]?|n|v|adj|adv|vt|vi|prep)\s*[)）]\s*([\s\S]*)$/i);
    if (m2) {
      const pos = POS_CN_MAP[m2[1]] || (m2[1].length <= 4 ? m2[1].replace(/^(n|v|adj|adv|prep|vt|vi)$/i, "$1.") + "." : null);
      if (pos) return [w, pos + " " + m2[2]];
    }
    return [w, d];
  }

  /** 左半必须纯英文；若把词性吞进了单词侧（realm n.），退回释义 */
  function detachTrailingPos(w, d) {
    const m = w.match(/\s((?:n|v|adj|adv|prep|conj|pron|num|int|art|aux|abbr|vt|vi)\.)$/i);
    if (!m) return [w, d];
    return [w.slice(0, m.index).trim(), m[1] + " " + d];
  }

  const looksLikeDef = (d) => /^([（(【]?\s*(?:n|v|adj|adv|prep|conj|pron|num|int|art|aux|abbr|vt|vi|a|ad)\.|[\/\[∕（(【]|[\u4e00-\u9fff])/i.test(String(d || "").trim());

  /**
   * 拆「单词 | 释义」。关键：单词侧贪婪匹配（这样 give up 不会被拆散），
   * 再把被吞掉的尾部 token 一个个退回释义侧，直到释义看起来像释义。
   */
  function splitWordDef(line) {
    for (const re of SEP_RES) {
      const rx = new RegExp("^([A-Za-z][A-Za-z0-9()'’\\-\\./ ]*)" + re.source + "([\\s\\S]+)$");
      const m = line.match(rx);
      if (!m) continue;
      const tokens = m[1].trim().split(/\s+/).filter(Boolean);
      const tail = m[2].trim();
      for (let k = tokens.length; k >= 1; k--) {
        let w = tokens.slice(0, k).join(" ");
        let d = [tokens.slice(k).join(" "), tail].filter(Boolean).join(" ").trim();
        [w, d] = detachTrailingPos(w, d);
        [w, d] = fixPosBrackets(w, d);
        w = stripNums(w); d = d.trim();
        if (!w || !d) continue;
        if (!ASCII_WORD.test(w) || /[\u4e00-\u9fff]/.test(w)) continue;
        if (w.split(/\s+/).length > 3) continue;              // 单词或至多三词短语
        if (!looksLikeDef(d)) continue;
        return { word: w, def: d };
      }
    }
    if (ASCII_WORD.test(line) && /^[A-Za-z]/.test(line)) return { word: stripNums(line), def: "" };
    return null;
  }

  /** 中文词性 → 缩写；「代名词 / 动词短语」这类被包住的词不拆 */
  function cnPosInDef(def) {
    const cjk = (c) => /[\u4e00-\u9fff]/.test(c || "");
    return String(def || "")
      .replace(/(及物动词|不及物动词|名词|动词|形容词|副词|介词|连词|代词|数词|感叹词|冠词|助动词|缩写词|缩写)/g, (m, g, off, str) => {
        if (cjk(str[off - 1]) || cjk(str[off + m.length])) return m;
        return POS_CN_MAP[m] || m;
      })
      .replace(/^[（(【]\s*([a-z]{1,4}\.)\s*[)）】]\s*/i, "$1 ")
      .replace(/^\s+/, "");
  }

  /** 主入口：任意粘贴文本（含 AI 拍照提取的杂乱格式）→ 候选词条数组 */
  function text(raw, opts) {
    opts = opts || {};
    const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
    let unit = opts.pinnedUnit || "";        // 父级：可被文本里的 Unit 标题更新，也可手动钉住
    let lesson = opts.pinnedUnit ? (opts.pinnedLesson || "") : (opts.pinnedLesson || "");   // 子级：Lesson / List / Section
    const out = [], skipped = [], blocks = [];
    let pending = null;                                       // 处理「单词一行、释义下一行」的折行

    const commit = (word, def) => {
      const { def: d1, ph } = extractPhonetic(def);
      const { def: d2, en, zh } = extractExample(cnPosInDef(d1));
      const senses = Lex.sensesFromRaw(d2);
      out.push({
        word, unit, lesson, senses, definition: d2, definition_raw: d2,
        phonetic: ph, example_en: en, example_zh: zh, source: "import",
        orphanLesson: !unit && !!lesson,                     // 只提取到 Lesson、丢了父级 Unit
      });
    };

    for (const rawLine of lines) {
      const line = normalizeLine(rawLine);
      if (!line) continue;
      if (NOISE_RE.test(line)) { continue; }
      const h = headerOf(line);
      if (h) {
        if (h.level === "top") { unit = h.label; lesson = ""; }
        else if (!unit && !opts.pinnedUnit) { unit = h.label; lesson = ""; }   // 无父级时子级标题升为顶层（只有 Word List 的书表）
        else { if (!unit) unit = opts.pinnedUnit; lesson = h.label; }          // 有 Unit（或钉住了）→ 正常作为课次
        continue;
      }
      if (HEAD_CELL.test(line)) {                          // 表头行：单词⇥释义
        const cells = line.split(/[\t|]/).map((c) => c.trim());
        if (cells.length <= 1 || cells.every((c) => HEAD_CELL.test(c))) continue;
      }

      if (pending) {                                       // 上一行是裸词，本行是它的释义
        if (/^[（(]?[A-Za-z\u4e00-\u9fff]/.test(line)) {
          commit(pending, line);
          pending = null;
          continue;
        }
        out.push(makeBare(pending)); pending = null;
      }

      const sd = splitWordDef(line);
      if (!sd || !sd.word || !/^[A-Za-z]/.test(sd.word)) { skipped.push(rawLine.trim().slice(0, 40)); continue; }
      if (!sd.def) { pending = sd.word; continue; }        // 可能是折行的前半
      commit(sd.word, sd.def);
    }
    if (pending) out.push(makeBare(pending));

    function makeBare(word) {
      return { word, unit, lesson, senses: [], definition: "", definition_raw: "", source: "import", orphanLesson: !unit && !!lesson };
    }
    if (!opts || opts.autofill !== false) out.forEach((c) => autofill(c));
    // blocks 只列"真的有词的叶子块"，按文档顺序去重（不要把光杆 Unit 标题也算成一个块）
    out.forEach((c) => { const bl = blockLabel(c.unit, c.lesson); if (bl && blocks.indexOf(bl) < 0) blocks.push(bl); });
    return { candidates: out, skipped, unit, lesson, blocks, structure: blocks.join(" → ") };
  }

  /** 内置离线词典包补全（音标 / 搭配 / 例句 / 裸词的中文释义） */
  function autofill(c) {
    if (!window.DICT) return c;
    const keys = Lex.variantsOf(c.word).map(Lex.norm);
    let hit = null;
    for (const k of keys) { if (DICT.enrich[k]) { hit = DICT.enrich[k]; break; } }
    if (!hit) for (const k of keys) { const f = DICT.bySurface && DICT.bySurface[k]; if (f) { hit = f; break; } }
    if (!hit) return c;
    if (!c.phonetic && hit.ph) c.phonetic = hit.ph;
    if (!c.collocation && hit.col) c.collocation = hit.col;
    if (!c.example_en && hit.en) { c.example_en = hit.en; c.example_zh = hit.zh || ""; }
    if ((!c.senses || !c.senses.length) && hit.gloss) {
      c.senses = Lex.sensesFromRaw(hit.gloss);
      c.definition = hit.gloss;
      c.dictFilled = true;
    }
    return c;
  }

  /* ---------- 浏览器内解析 .docx（ZIP + deflate-raw，无需任何库） ---------- */
  async function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dec = new TextDecoder("utf-8");
    let eocd = -1;
    const min = Math.max(0, u8.length - 22 - 65536);
    for (let i = u8.length - 22; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("不是有效的 .docx（未找到 ZIP 目录）");
    const count = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) break;
      const method = dv.getUint16(ptr + 10, true);
      const csize = dv.getUint32(ptr + 20, true);
      const nlen = dv.getUint16(ptr + 28, true);
      const elen = dv.getUint16(ptr + 30, true);
      const clen = dv.getUint16(ptr + 32, true);
      const loff = dv.getUint32(ptr + 42, true);
      const name = dec.decode(u8.subarray(ptr + 46, ptr + 46 + nlen));
      const lnlen = dv.getUint16(loff + 26, true);
      const lelen = dv.getUint16(loff + 28, true);
      const dstart = loff + 30 + lnlen + lelen;
      files[name] = { method, bytes: u8.subarray(dstart, dstart + csize) };
      ptr += 46 + nlen + elen + clen;
    }
    return files;
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持内置解压器，请改用「粘贴文本」导入");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function xmlToText(xml) {
    return xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }
  async function docxFile(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const zip = await readZip(u8);
    const main = zip["word/document.xml"];
    if (!main) throw new Error("压缩包内没有 word/document.xml");
    const bytes = main.method === 0 ? main.bytes : await inflate(main.bytes);
    let textOut = xmlToText(new TextDecoder("utf-8").decode(bytes));
    // Word 里两列也可能做成表格：按行内单元格顺序还原成 Tab
    textOut = textOut.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return textOut;
  }

  async function file(file, opts) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".docx")) return text(await docxFile(file), opts);
    const raw = await file.text();
    if (name.endsWith(".json")) return json(raw, opts);
    return text(raw, opts);
  }

  /** AI / 备份 JSON：兼容 Mode 1 契约、词条数组、{words:[]} */
  function json(raw, opts) {
    const p = JSON.parse(String(raw).replace(/^\uFEFF/, "").replace(/```(json)?/gi, "").trim());
    const list = Array.isArray(p) ? p : Array.isArray(p.words) ? p.words : Array.isArray(p.data) ? p.data : p.result && Array.isArray(p.result.words) ? p.result.words : null;
    if (!list) throw new Error("JSON 里找不到 words 数组");
    const unit = p.unit || "";
    const out = list.filter(Boolean).map((w) => {
      const senses = w.senses && w.senses.length
        ? w.senses
        : (w.pos !== undefined || w.definition) ? [{ pos: w.pos || "", meaning: String(w.definition || w.meaning || w.gloss || "").replace(/^[a-z]+\.\s*/i, "") }] : Lex.sensesFromRaw(w.definition_raw || "");
      const c = {
        word: w.word || w.vocabulary || w.name,
        unit: w.unit || unit,
        lesson: w.lesson || "",
        senses,
        definition: w.definition || (senses.map((s) => `${s.pos} ${s.meaning}`.trim()).join(" ")),
        phonetic: w.phonetic || w.ipa || "",
        collocation: w.collocation || w.collocations || "",
        example_en: w.example_en || (w.example && w.example.en) || "",
        example_zh: w.example_zh || (w.example && w.example.zh) || "",
        note: w.note || "",
        source: w.source === "ai" || p.has_words !== undefined ? "ai" : "import",
      };
      if (!c.word) return null;
      return (opts && opts.autofill === false) ? c : autofill(c);
    }).filter(Boolean);
    return { candidates: out, skipped: [], unit, reply: p.reply_message || "" };
  }

  /* ---------- 导出给 Mode 1 引擎的契约样例 ---------- */
  const CONTRACT = `{
  "has_words": true,
  "reply_message": "已为你识别并提取 N 个四级词汇，请确认入库：",
  "words": [
    {
      "word": "accommodate",
      "phonetic": "/əˈkɒmədeɪt/",
      "pos": "vt.",
      "definition": "容纳；向…提供住处；顺应，适应",
      "collocation": "accommodate to / accommodate sb. with",
      "example_en": "The hotel can accommodate up to 500 guests.",
      "example_zh": "这家酒店最多可容纳500名客人。"
    }
  ]
}`;

  return { text, file, docxFile, json, autofill, splitWordDef, readZip, headerOf, blockLabel, cn2num, CONTRACT };
})();
if (typeof window !== "undefined") window.Parse = Parse;
