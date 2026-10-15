/* 设备端冒烟测试：装在 Android 模拟器/真机上的 noadic，端到端走真实 UI。
 *
 *   node _tools/device-smoke.mjs [--serial 127.0.0.1:16416] [--apk dist/noadic-debug.apk] [--shots]
 *   node _tools/device-smoke.mjs --selftest    # 负向对照：故意加一条假断言，验证这套检查真会失败
 *
 * 定位方式：不写死坐标，也不依赖 WebView devtools（MuMu 的系统 WebView 即使
 * webContentsDebuggingEnabled=true 也不开 socket）。改用 uiautomator 无障碍树按**文字**
 * 找节点、现算中心点，因此对旋转/分辨率免疫；每次点击前重新 dump，绝不用旧坐标。
 *
 * 它抓到过一个纯逻辑测试永远抓不到的 bug：撤销按钮的 disabled 只在打开设置抽屉时刷新，
 * 于是"删完一整单元→按钮仍是灰的→点不动"（D12b 就是那条回归断言）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const ADB = arg("adb", path.join(ROOT, ".tooling", "android-sdk", "platform-tools", "adb.exe"));
const SERIAL = arg("serial", "127.0.0.1:16416");
let APK = arg("apk", path.join(ROOT, "dist", "noadic-debug.apk"));
if (!path.isAbsolute(APK)) APK = path.join(ROOT, APK);
const PKG = "com.noadic.app";
const SELFTEST = argv.includes("--selftest");
const SHOTS = argv.includes("--shots");
const SHOT_DIR = path.join(ROOT, ".tooling", "shots");

const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
const ok = (name, cond, extra) => { R.push({ name, pass: !!cond, extra: extra == null ? "" : String(extra) }); };

/* adb 的 Windows 构建处理含中文的文件路径会静默失败，所以给 adb 的路径一律走 ASCII 联接。 */
const JUNCTION = "D:\\noadic-build";
const hasJ = fs.existsSync(JUNCTION);
const ascii = (p) => {
  if (!hasJ) return p;
  const rootN = ROOT.replace(/[\\/]$/, "");
  return p.startsWith(rootN) ? path.join(JUNCTION, p.slice(rootN.length)) : p;
};
const adb = (...a) => run(ADB, ["-s", SERIAL, ...a]);
/* MuMu 的 uiautomator dump 会写完文件再 SIGSEGV（exit 139），所以这里不看退出码。 */
const adbSoft = (...a) => { try { return run(ADB, ["-s", SERIAL, ...a]); } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };

function report() {
  console.log("");
  let pass = 0;
  for (const x of R) {
    if (x.pass) { pass++; console.log("  ✅ " + x.name); }
    else console.log("  ❌ " + x.name + "   →  " + x.extra);
  }
  console.log("\n" + pass + "/" + R.length + " 通过");
  return pass;
}
function die(m) { console.error("\n❌ " + m); report(); process.exit(1); }

/* ---------- 无障碍树 ---------- */
function nodes(xml) {
  const out = [];
  const re = /<node\b[^>]*/g;
  let m;
  while ((m = re.exec(xml || ""))) {
    const tag = m[0];
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!b) continue;
    const g = (k) => { const r2 = new RegExp(k + '="([^"]*)"').exec(tag); return r2 ? r2[1] : ""; };
    const x1 = +b[1], y1 = +b[2], x2 = +b[3], y2 = +b[4];
    out.push({
      text: g("text"), desc: g("content-desc"), hint: g("hint"), cls: g("class"), id: g("resource-id"),
      enabled: g("enabled") !== "false", clickable: g("clickable") === "true",
      x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1,
    });
  }
  return out;
}
function dump() {
  const local = ascii(path.join(ROOT, ".tooling", "smoke-ui.xml"));
  for (let i = 0; i < 6; i++) {
    try { if (fs.existsSync(local)) fs.unlinkSync(local); } catch (e) { }
    adbSoft("shell", "rm", "-f", "/sdcard/smoke-ui.xml");
    adbSoft("shell", "uiautomator", "dump", "/sdcard/smoke-ui.xml");
    adbSoft("pull", "/sdcard/smoke-ui.xml", local);
    let x = "";
    try { x = fs.readFileSync(local, "utf8"); } catch (e) { }
    if (x.length > 200) return x;
    sleep(500);
  }
  return "";
}
const allText = (xml) => nodes(xml).map((n) => n.text).filter(Boolean).join(" | ");
/* 词数取自顶栏「N 词 ｜ 已补全 M」。
   为什么不用"那个词还在不在树里"判断删除成功：
     · toast 的文案里就写着被删的词名（外层+子节点两层，按 id 滤不干净）；
     · Chrome 会把无语义的容器压平——实测 #lib-list 的子树里只有单元表头，
       词条行并不挂在它下面，所以"按 DOM id 取子树"这条路的假设是错的。
   计数是唯一不受文案污染、也不依赖树结构的信号。 */
const wordCount = (xml) => { const m = /(\d+) 词 ｜ 已补全/.exec(allText(xml)); return m ? +m[1] : null; };
function findNode(xml, want) {
  const ns = nodes(xml);
  return ns.find((n) => n.text === want) || ns.find((n) => n.text && n.text.includes(want))
    || ns.find((n) => n.desc && n.desc.includes(want)) || null;
}
/* 按 resource-id 精确取撤销按钮：DOM 元素的 id 会作为 resource-id 出现在
   Chrome 的无障碍树里，比按文字找可靠——toast 文案里也有「撤销上次改动」这几个字。 */
const undoBtn = (xml) => nodes(xml || dump()).find((n) => /btn-undo-import$/.test(n.id || "")) || null;
/* 每次点击前重新 dump：用旧坐标点过一次的教训是"旋转/布局一变就点到别处"。 */
function tapText(want, label) {  const n = findNode(dump(), want);
  if (!n) { ok("点击「" + (label || want) + "」", false, "屏幕上找不到该文字的节点"); return false; }
  if (!n.enabled) { ok("点击「" + (label || want) + "」", false, "节点存在但是禁用态（enabled=false）"); return false; }
  adb("shell", "input", "tap", String(Math.round(n.x)), String(Math.round(n.y)));
  return true;
}
const nodeById = (xml, re) => nodes(xml || dump()).find((n) => re.test(n.id || "")) || null;
/* 屏幕高度：uiautomator 会给"被裁切到可视区外"的节点照常报坐标，
   照着那个坐标点下去什么也不会发生——弹窗里的按钮就是这么被吃掉的（D21 第一次就是这么挂的）。 */
let SH = 1920, SW = 1080;
try {
  const m = /(\d+)x(\d+)/.exec(adb("shell", "wm", "size") || "");
  if (m) { SW = +m[1]; SH = +m[2]; }
} catch (e) { }
const inView = (n) => !!n && n.w > 0 && n.h > 0 && n.y + n.h / 2 <= SH && n.y - n.h / 2 >= 0 && n.x + n.w / 2 <= SW && n.x - n.w / 2 >= 0;
/* 朝上滑动把目标滚进可视区，最多 5 次；每次都重新 dump（布局一变旧坐标就是废的）。 */
async function revealNode(find, label) {
  for (let i = 0; i < 5; i++) {
    const n = find(dump());
    if (n && inView(n)) return n;
    if (i === 0 && n) console.log("  ↻ 「" + label + "」在可视区外（y=" + Math.round(n.y) + "，屏高 " + SH + "），先滚进来");
    adb("shell", "input", "swipe", String(Math.round(SW / 2)), String(Math.round(SH * 0.72)),
      String(Math.round(SW / 2)), String(Math.round(SH * 0.34)), "350");
    await sleep(700);
  }
  const last = find(dump());
  return last && inView(last) ? last : null;
}
/* 按 resource-id 点击：确认弹层的按钮文字（"删除"）在词库行上也存在，
   按文字找会点到行上的那个，所以这条新路径必须按 id 点。 */
function tapId(re, label) {
  const n = nodeById(dump(), re);
  if (!n) { ok("点击 #" + label, false, "无障碍树里没有 #" + label + " 节点（弹层大概没弹出）"); return false; }
  if (!n.enabled) { ok("点击 #" + label, false, "#" + label + " 是禁用态"); return false; }
  adb("shell", "input", "tap", String(Math.round(n.x)), String(Math.round(n.y)));
  return true;
}
function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  try {
    adbSoft("shell", "screencap", "-p", "/sdcard/s.png");
    adbSoft("pull", "/sdcard/s.png", ascii(path.join(SHOT_DIR, "smoke-" + name + ".png")));
  } catch (e) { }
}

/* ---------- 装包启动 ---------- */
console.log("adb      " + ADB);
console.log("device   " + SERIAL);
console.log("apk      " + APK + "  (" + (fs.statSync(APK).size / 1048576).toFixed(2) + " MB)");
if (!hasJ) console.log("⚠ 没有 " + JUNCTION + " 联接，adb 文件路径将使用含中文的原路径");
if (SELFTEST) console.log("mode     SELFTEST（期望最终判失败）");
execFileSync(ADB, ["connect", SERIAL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (!run(ADB, ["devices"]).split("\n").some((l) => l.trim().startsWith(SERIAL) && /\sdevice$/.test(l.trim())))
  die("设备不在线（" + SERIAL + "）");

console.log("\n[1/4] 彻底卸载后安装（pm clear 不清 app_webview，会跑到上一版缓存资源上）");
adbSoft("uninstall", PKG);
if (!/Success/.test(adb("install", "-r", "-g", ascii(APK)))) die("安装失败");
adb("shell", "pm", "clear", PKG);
console.log("[2/4] 启动并等首屏就绪");
adb("shell", "am", "start", "-n", PKG + "/.MainActivity");
let xml = "", ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  await sleep(1000);
  xml = dump();
  ready = /\d+ 词 ｜ 已补全/.test(allText(xml));
}
if (!ready) die("首屏 30 秒内没就绪（顶栏没出现「N 词 ｜ 已补全」）");

/* MuMu 会自己转成横屏（历史上跑测试中途转过两次）。整套断言按竖屏布局写，
   朝向一错报出来的就是"点不到"，很容易被误读成"功能坏了"——先锁回竖屏再继续。
   顺带用根节点真实宽高刷新 SW/SH：wm size 给的是物理尺寸，不随朝向变。 */
async function ensurePortrait() {
  for (let i = 0; i < 3; i++) {
    const root = nodes(dump())[0];
    if (root) { SW = Math.min(root.w, root.h); SH = Math.max(root.w, root.h); }
    if (root && root.w <= root.h) return true;
    console.log("  ↻ 检测到横屏（根节点 " + (root ? root.w + "x" + root.h : "?") + "），锁回竖屏");
    adbSoft("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    adbSoft("shell", "settings", "put", "system", "user_rotation", "0");
    await sleep(2600);
  }
  const r = nodes(dump())[0];
  return !!r && r.w <= r.h;
}
if (!(await ensurePortrait())) die("锁不住竖屏，断言的坐标前提不成立");

/* ---------- 断言 ---------- */
console.log("[3/4] 断言");
let all = allText(xml);
ok("D1 顶栏词数与播种一致（127）", /127 词 ｜ 已补全 127/.test(all), (all.match(/\d+ 词 ｜ 已补全 \d+/) || ["无"])[0]);
ok("D2 品牌已是 noadic / 不止词典", all.includes("noadic") && all.includes("不止词典"), "");
ok("D3 底部六个导航项", ["测验", "背诵", "词库", "录入", "错题本", "进阶"].every((t) => all.includes(t)),
  ["测验", "背诵", "词库", "录入", "错题本", "进阶"].filter((t) => !all.includes(t)).join(",") || "全在");
ok("D4 顺序闯关条显示当前块与达标进度", /Unit \d+.*已掌握.*混合轮换/.test(all.replace(/\|/g, "")),
  (all.match(/Unit \d+[^|]{0,40}/) || ["无"])[0]);

/* 判定按钮的 nowrap：直接查**装进 APK 的那份 CSS**，而不是猜渲染高度
   （flex 会把按钮拉伸到输入框等高，高度量不出换行） */
let cssInApk = "";
try {
  // 只做子串查找，不写正则：往 JS 字符串里塞 python 正则的转义层，上一版就是这么把
  // 明明存在的规则读成 NORULE 的（假失败）。
  const py = [
    "import zipfile,sys",
    "z=zipfile.ZipFile(sys.argv[1])",
    "c=z.read('assets/public/css/app.css').decode('utf-8')",
    "i=c.find('.answerrow button')",
    "print('NORULE' if i<0 else c[i:i+80].replace(chr(10),' '))",
  ].join(";");
  cssInApk = run("python", ["-c", py, APK]).trim();
} catch (e) { cssInApk = "ERR:" + e.message; }
ok("D5 出厂 CSS 里判定按钮有 white-space:nowrap", cssInApk.includes("nowrap"), cssInApk.slice(0, 110));

/* 滑动切题：在题型标签那一行上滑（它是卡片里的静态元素，不在 attachSwipe 的
   排除名单 input/.seg/.seqbar/.litem 里；上一版按"宽节点"选位，结果选到了顶栏 y=114，
   滑了个寂寞） */
xml = dump();
const before = allText(xml);
const TYPE_RE = /四选一|听音拼写|语境填空|熟词生义/;
const prompt = nodes(xml).find((n) => TYPE_RE.test(n.text || "") && n.h > 15 && n.h < 90)
  || nodes(xml).find((n) => /根据音标|选出下列|填入恰当|哪个含义/.test(n.text || ""));
if (!prompt) {
  ok("D6 右滑切到下一题", false, "找不到题型标签/题面提示节点，无法确定安全滑动位置");
} else {
  const yy = Math.round(prompt.y);
  adb("shell", "input", "swipe", "950", String(yy), "150", String(yy), "260");
  await sleep(1300);
  ok("D6 右滑切到下一题（题面文字变化）", allText(dump()) !== before, "滑动位置 y=" + yy + "（" + prompt.text + "），文字未变");
  shot("after-swipe");
}

/* 删除整单元 → 确认 → 撤销，全走真实点击 */
if (!tapText("词库", "词库")) die("无法进入词库页");
await sleep(1200);
xml = dump(); all = allText(xml);
ok("D7 词库页有单元卡与「删除单元」", all.includes("删除单元") && /Unit \d+/.test(all), "");
if (!tapText("删除单元", "删除单元")) die("点不到删除单元");
await sleep(900);
xml = dump(); all = allText(xml);
const m = all.match(/共 (\d+) 个单词/);
const cnt = m ? +m[1] : 0;
// 弹窗标题形如「删除单元 · Unit 2」；用 · 区分它和工具栏上那个纯文字「删除单元」按钮
const titleUnit = (nodes(xml).find((n) => /删除单元\s*·/.test(n.text || "")) || {}).text || "";
const unitName = (titleUnit.match(/Unit \d+/) || [""])[0];
ok("D8 确认弹窗说明删的是整个单元并报出词数", /将删除整个单元/.test(all) && cnt > 0, m ? "报数 " + cnt : all.slice(0, 120));
ok("D9 弹窗提示可用「撤销上次改动」恢复", /撤销上次改动/.test(all), "");
shot("del-modal");
if (!tapText("删除这 " + cnt + " 个词", "红色确认按钮")) {
  const any = nodes(dump()).find((n) => /删除这/.test(n.text || ""));
  if (any) adb("shell", "input", "tap", String(Math.round(any.x)), String(Math.round(any.y)));
  else die("找不到红色确认按钮");
}
await sleep(1600);
xml = dump(); all = allText(xml);
const topN = +((all.match(/(\d+) 词 ｜ 已补全/) || [0, -1])[1]);
ok("D10 确认后词库真的少了一个单元", topN === 127 - cnt, "顶栏 " + topN + " 词，期望 " + (127 - cnt));
const unitCards = (x) => nodes(x).map((n) => n.text).filter((t) => /^Unit \d+$/.test(t || ""));
ok("D11 被删的那个单元已不在列表，其余单元还在",
  unitCards(xml).length > 0 && !(unitCards(xml).includes(unitName)),
  "删的是 " + (unitName || "?") + "；现存 " + (unitCards(xml).join(",") || "无"));
shot("after-delete");

/* 撤销：断言的是**行为**（点得动、词数回来），不是某个可能说谎的状态位。
   上一版这里查 a11y 的 enabled，结果它给的是过期值，真机上一度把好的实现判成失败。 */
const ub = undoBtn();
ok("D12 「撤销上次改动」按钮可点（不被 disabled 卡住）", !!ub && ub.enabled,
  ub ? "enabled=" + ub.enabled + " 位置=(" + Math.round(ub.x) + "," + Math.round(ub.y) + ")" : "找不到 resource-id=btn-undo-import 节点");
if (ub) adb("shell", "input", "tap", String(Math.round(ub.x)), String(Math.round(ub.y)));
await sleep(1700);
xml = dump(); all = allText(xml);
ok("D13 撤销把整单元恢复回来（回到 127 词且该单元回来）",
  /127 词 ｜ 已补全 127/.test(all) && unitCards(xml).includes(unitName),
  (all.match(/\d+ 词 ｜ 已补全 \d+/) || ["无"])[0] + " | 单元 " + (unitCards(xml).join(",") || "无"));
shot("after-undo");
const ub2 = undoBtn();
if (ub2) adb("shell", "input", "tap", String(Math.round(ub2.x)), String(Math.round(ub2.y)));
await sleep(1200);
const all2 = allText(dump());
ok("D14 再点一次不会破坏数据，并明确告知没有可撤销记录",
  /127 词 ｜ 已补全 127/.test(all2) && /没有可撤销/.test(all2),
  (all2.match(/\d+ 词 ｜ 已补全 \d+/) || ["无"])[0] + " | toast: " + ((all2.match(/[^|]*没有可撤销[^|]*/) || ["无"])[0]).trim());

/* ---------- 背诵页：遮罩与标记（D15–D19） ----------
 * 遮罩用 visibility:hidden 实现，被遮的文字会**从无障碍树里消失**，
 * 所以这里能拿到一条行为级断言，而不是"看起来像遮住了"。 */
if (!tapText("背诵", "背诵")) die("无法进入背诵页");
await sleep(1300);
xml = dump(); all = allText(xml);
ok("D15 背诵页是两列表（英文单词 / 词性及中文释义）", all.includes("英文单词") && all.includes("词性及中文释义"), all.slice(0, 100));

/** 计数条是一个**合并文本节点**："全部词库 共 127 词 ｜ 标了不熟 1 个 ｜ 本页 1 个　当前不遮罩"。
 *  所以必须锚在 rc-summary 这个 resource-id 上，不能"找含标签的节点"——
 *  工具栏里那个「标了不熟的词 → 去测验只练这些」按钮也含"标了不熟"，而且排在它前面。 */
const sumNode = (xml) => nodes(xml).find((n) => /rc-summary$/.test(n.id || "")) || null;
function numInSummary(xml, label) {
  const n = sumNode(xml);
  if (!n) return null;
  const m = new RegExp(label + "\\s*(\\d+)").exec(n.text || "");
  return m ? +m[1] : null;
}
/** 第一行（英文, 中文）探针对。
 *  ① 必须锚在表头下方：顶栏的 noadic 也是纯小写英文，它右边那行正是 "127 词 ｜ 已补全…"；
 *  ② 英文格子的节点文字是「词 + 音标」合并串（"observe əbˈzɜːv"），整串 ^[a-z]+$ 匹配不上，
 *     只能取开头的词。 */
function firstPair(xml) {
  const ns = nodes(xml);
  const head = ns.find((n) => (n.text || "").trim() === "英文单词");
  if (!head) return null;
  const texts = ns.map((n) => n.text).filter(Boolean);
  for (const e of ns.filter((n) => n.y > head.y)) {
    const wm = /^([a-z][a-z-]{3,})(\s|$)/.exec(e.text || "");
    if (!wm) continue;
    const c = ns.find((n) => /[一-龥]/.test(n.text || "") && n.x > e.x + 10 && Math.abs(n.y - e.y) <= 24
      && n.text.length >= 4 && !/不止词典|遮罩|不熟|本页|单元|课次|全部|词库|掌握|错题|待测|点击显示/.test(n.text));
    // 探针必须在全页唯一：① 不能有第二个一模一样的节点（两个词都写"保护"，遮住第一行、
    // 第二行还在，会把"遮住了"判成"没遮住"）；② 也不能是别的节点文字的一部分
    // （"保护；保留"里就含着"保护"）。
    if (!c) continue;
    const dup = texts.filter((t) => t === c.text).length !== 1;
    const nested = texts.filter((t) => t !== c.text && t.includes(c.text)).length;
    if (!dup && !nested) return { en: wm[1], zh: c.text };
  }
  return null;
}

/* 先「不遮」，取第一行的中文释义作为探针 */
tapText("全部", "全部筛选");            // 建立已知状态：上一轮可能把筛选留在「只看不熟」
await sleep(900);
if (!tapText("不遮", "不遮")) die("点不到「不遮」");
await sleep(1100);
xml = dump();
const pair = firstPair(xml);
if (!pair) {
  ok("D16 遮中文后该释义从无障碍树里消失", false, "没取到第一行的中英探针对，无法判断遮罩是否生效");
  ok("D17 「显示全部」把整页中文放回来", false, "同上：探针缺失");
} else {
  ok("D16a 不遮时中文释义在树里（探针 " + pair.en + "）", allText(xml).includes(pair.zh), pair.zh);
  if (!tapText("遮中文", "遮中文")) die("点不到「遮中文」");
  await sleep(1100);
  const afterMask = allText(dump());
  ok("D16 遮中文后该释义真的从无障碍树消失（不是透明、不是模糊）", !afterMask.includes(pair.zh),
    "探针「" + pair.zh + "」" + (afterMask.includes(pair.zh) ? "仍在树里=遮罩没生效" : "已消失"));
  if (!tapText("显示全部", "显示全部")) die("点不到「显示全部」");
  await sleep(1100);
  ok("D17 「显示全部」把整页中文放回来", allText(dump()).includes(pair.zh), "探针「" + pair.zh + "」没回来");
  if (!tapText("全部遮回", "全部遮回")) die("点不到「全部遮回」");
  await sleep(1000);
  ok("D17b 「全部遮回」再遮回去", !allText(dump()).includes(pair.zh), "探针又可见了=遮回没生效");
}

/* 标记不熟：点第一行的 ☆，看计数条与筛选计数 */
const star0 = numInSummary(dump(), "标了不熟");
if (!tapText("☆", "☆ 标记不熟")) {
  ok("D18 点 ☆ 标记背不熟并同步计数", false, "找不到 ☆ 节点");
} else {
  await sleep(1100);
  const xml2 = dump();
  const star1 = numInSummary(xml2, "标了不熟");
  ok("D18 点 ☆ 标记背不熟并同步计数", star0 != null && star1 === star0 + 1 && allText(xml2).includes("★"),
    "标前 " + star0 + " → 标后 " + star1);
  if (!tapText("只看不熟", "只看不熟")) die("点不到「只看不熟」筛选");
  await sleep(1100);
  const xml3 = dump();
  ok("D19 「只看不熟」筛到只剩标记过的那些", numInSummary(xml3, "本页") === 1 && allText(xml3).includes("★"),
    "本页 " + numInSummary(xml3, "本页") + " 个");
  shot("recite-weak");
  if (!tapText("全部", "全部")) die("点不回「全部」筛选");
  await sleep(900);
}
shot("recite");

/* ---------- 页内确认弹层（鸿蒙 ArkWeb 不提供默认 JS 弹框，删除改走这条路径） ---------- */
console.log("[4/4] 词库删除确认弹层");
if (!tapText("词库", "词库标签")) die("点不到「词库」");
await sleep(1200);
const edNode = await revealNode((x) => findNode(x, "编辑"), "编辑");
if (!edNode) die("词库行上的「编辑」滚不进可视区");
adb("shell", "input", "tap", String(Math.round(edNode.x)), String(Math.round(edNode.y)));
await sleep(1000);
const tNode = nodeById(null, /modal-title$/);
const word = tNode ? (tNode.text || "").replace(/^编辑词条\s*[·:]\s*/, "").trim() : "";
ok("D20 编辑弹窗打开（探针词 " + (word || "?") + "）", !!tNode && /编辑词条/.test(tNode.text || "") && word.length > 2,
  tNode ? tNode.text : "没有 #modal-title 节点");

if (!tNode || !word) {
  ok("D21 确认框压在编辑弹窗之上并显示词名", false, "上一步没拿到探针词");
  ok("D22 取消后词没被删、编辑弹窗没被一起关掉", false, "同上");
  ok("D23 确认后少了一个词、弹层收起、可撤销", false, "同上");
  ok("D24 撤销把词恢复回来", false, "同上");
} else {
  const del1 = await revealNode((x) => findNode(x, "删除该词"), "删除该词");
  if (!del1) die("编辑弹窗里的「删除该词」滚不进可视区（弹窗 max-height 裁切）");
  adb("shell", "input", "tap", String(Math.round(del1.x)), String(Math.round(del1.y)));
  await sleep(900);
  const qm = nodeById(null, /qbox-msg$/);
  ok("D21 确认框压在编辑弹窗之上并显示词名", !!qm && (qm.text || "").includes(word) && !!nodeById(null, /modal-title$/),
    qm ? qm.text.slice(0, 60) : "#qbox-msg 不存在=页内弹层没弹出（删除该词中心 y=" + Math.round(del1.y) + "，屏高 " + SH + "）");
  shot(qm ? "qbox" : "qbox-missing");     // 遮挡关系、字号、按钮位置这类问题断言看不见，必须留一张图

  const n0 = wordCount(dump());
  if (n0 === null) die("顶栏读不到「N 词 ｜ 已补全」，D22–D24 的计数判据不成立");
  if (!tapId(/qbox-cancel$/, "qbox-cancel")) die("点不到取消");
  await sleep(900);
  const nCancel = wordCount(dump());
  ok("D22 取消后词没被删、编辑弹窗没被一起关掉", nCancel === n0 && !nodeById(null, /qbox-msg$/) && !!nodeById(null, /modal-title$/),
    "词数 " + n0 + "→" + nCancel + "，确认框" + (nodeById(null, /qbox-msg$/) ? "还开着" : "已关")
    + "，编辑弹窗" + (nodeById(null, /modal-title$/) ? "还在" : "没了"));

  // D22 已确认编辑弹窗还开着（滚动位置也还在），直接再点一次「删除该词」
  const del2 = await revealNode((x) => findNode(x, "删除该词"), "删除该词");
  if (!del2) die("第二次找不到「删除该词」");
  adb("shell", "input", "tap", String(Math.round(del2.x)), String(Math.round(del2.y)));
  await sleep(900);
  if (!nodeById(null, /qbox-msg$/)) die("第二次点删除没有弹出确认框");
  if (!tapId(/qbox-ok$/, "qbox-ok")) die("点不到确认");
  await sleep(1600);
  const afterXml = dump();
  const nAfter = wordCount(afterXml);
  const qboxStill = !!nodeById(afterXml, /qbox-msg$/);
  const ub = undoBtn();
  ok("D23 确认后少了一个词、弹层收起、可撤销", nAfter === n0 - 1 && !qboxStill && !!ub && ub.enabled,
    "词数 " + n0 + "→" + nAfter + "；确认框" + (qboxStill ? "还开着（#qbox-ok 那一下没被接住）" : "已关闭")
    + "；撤销按钮" + (ub ? (ub.enabled ? "可点" : "灰着") : "不存在"));
  if (nAfter !== n0 - 1 || qboxStill) shot("qbox-stuck");

  if (ub && tapId(/btn-undo-import$/, "btn-undo-import")) {
    await sleep(1800);
    const nUndo = wordCount(dump());
    ok("D24 撤销把词恢复回来", nUndo === n0, "词数 " + n0 + "→" + nAfter + "→" + nUndo + "（撤销后应回到 " + n0 + "）");
  } else {
    ok("D24 撤销把词恢复回来", false, "撤销按钮点不到");
  }
}

if (SELFTEST) R.push({ name: "Z. SELFTEST 负向对照（本应失败）", pass: false, extra: "故意写错" });

/* ---------- 报告 ---------- */
console.log("[4/4] 结果");
const pass = report();
if (SELFTEST) {
  if (pass < R.length) { console.log("\n✅ 负向对照通过：假断言确实被判失败，这套检查不是空转"); process.exit(0); }
  console.log("\n❌ 负向对照失败：故意写错的断言没被抓出来 —— 检查是空转的");
  process.exit(1);
}
process.exit(pass === R.length ? 0 : 1);
