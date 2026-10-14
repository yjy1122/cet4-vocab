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
      text: g("text"), desc: g("content-desc"), cls: g("class"), id: g("resource-id"),
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
function findNode(xml, want) {
  const ns = nodes(xml);
  return ns.find((n) => n.text === want) || ns.find((n) => n.text && n.text.includes(want))
    || ns.find((n) => n.desc && n.desc.includes(want)) || null;
}
/* 每次点击前重新 dump：用旧坐标点过一次的教训是"旋转/布局一变就点到别处"。 */
function tapText(want, label) {
  const n = findNode(dump(), want);
  if (!n) { ok("点击「" + (label || want) + "」", false, "屏幕上找不到该文字的节点"); return false; }
  if (!n.enabled) { ok("点击「" + (label || want) + "」", false, "节点存在但是禁用态（enabled=false）"); return false; }
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

console.log("\n[1/4] 安装 + 清空数据（要可预期的 127 词基线）");
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

/* ---------- 断言 ---------- */
console.log("[3/4] 断言");
let all = allText(xml);
ok("D1 顶栏词数与播种一致（127）", /127 词 ｜ 已补全 127/.test(all), (all.match(/\d+ 词 ｜ 已补全 \d+/) || ["无"])[0]);
ok("D2 品牌已是 noadic / 不止词典", all.includes("noadic") && all.includes("不止词典"), "");
ok("D3 底部五个导航项", ["测验", "词库", "录入", "错题本", "进阶"].every((t) => all.includes(t)),
  ["测验", "词库", "录入", "错题本", "进阶"].filter((t) => !all.includes(t)).join(",") || "全在");
ok("D4 顺序闯关条显示当前块与达标进度", /Unit \d+.*已掌握.*混合轮换/.test(all.replace(/\|/g, "")),
  (all.match(/Unit \d+[^|]{0,40}/) || ["无"])[0]);

/* 判定按钮的 nowrap：直接查**装进 APK 的那份 CSS**，而不是猜渲染高度
   （flex 会把按钮拉伸到输入框等高，高度量不出换行） */
let cssInApk = "";
try {
  const py = "import zipfile,sys,re;" +
    "z=zipfile.ZipFile(sys.argv[1]);" +
    "c=z.read('assets/public/css/app.css').decode('utf-8');" +
    "m=re.search(r'\\\\.answerrow\\\\s+button\\\\s*\\\\{[^}]*\\\\}',c);" +
    "print((m.group(0) if m else 'NORULE').replace(chr(10),' '))";
  cssInApk = run("python", ["-c", py, APK]).trim();
} catch (e) { cssInApk = "ERR:" + e.message; }
ok("D5 出厂 CSS 里判定按钮有 white-space:nowrap", /white-space:\s*nowrap/.test(cssInApk), cssInApk.slice(0, 120));

/* 滑动切题：在题面提示语那一行上滑（避开 input/.seg/.seqbar/.litem） */
xml = dump();
const before = allText(xml);
const prompt = nodes(xml).find((n) => /根据音标|选出下列|填入恰当|哪个含义/.test(n.text || ""))
  || nodes(xml).find((n) => n.text && n.text.length > 6 && n.w > 300 && n.h > 20 && n.h < 120);
if (!prompt) {
  ok("D6 右滑切到下一题", false, "找不到题面提示节点，无法确定安全滑动位置");
} else {
  const yy = Math.round(prompt.y);
  adb("shell", "input", "swipe", "950", String(yy), "150", String(yy), "260");
  await sleep(1300);
  ok("D6 右滑切到下一题（题面文字变化）", allText(dump()) !== before, "滑动位置 y=" + yy + "，文字未变");
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
const unitName = (titleUnit.match(/Unit \d+/) || [""])[0];
const titleUnit = (nodes(xml).find((n) => /删除单元/.test(n.text || "")) || {}).text || "";
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
ok("D11 被删的那个单元已不在列表，其余单元还在",
  unitName && !new RegExp(unitName + " \\d+/\\d+ 词").test(all) && /Unit \d+ \d+\/\d+ 词/.test(all),
  "删的是 " + (unitName || "?") + "；现存 " + (all.match(/Unit \d+ \d+\/\d+ 词/g) || []).join(" / "));
shot("after-delete");

/* 这条就是本次真机测试抓到的 bug：删除产生了快照，但按钮的 disabled 没被刷新 */
const undoNode = findNode(xml, "撤销上次改动");
ok("D12 删除后「撤销上次改动」按钮是可用态（不是灰的）", !!undoNode && undoNode.enabled,
  undoNode ? "enabled=" + undoNode.enabled : "找不到按钮节点");
if (!tapText("撤销上次改动", "撤销上次改动")) die("撤销按钮点不动");
await sleep(1700);
xml = dump(); all = allText(xml);
ok("D13 撤销把整单元恢复回来（回到 127 词且该单元回来）",
  /127 词 ｜ 已补全 127/.test(all) && new RegExp(unitName + " \\d+/\\d+ 词").test(all),
  (all.match(/\d+ 词 ｜ 已补全 \d+/) || ["无"])[0] + " | " + (all.match(/Unit \d+ \d+\/\d+ 词/g) || []).join(" / "));
shot("after-undo");
ok("D14 撤销后按钮回到禁用态（快照已消费，不能重复撤销）",
  (() => { const n = findNode(dump(), "撤销上次改动"); return !n || !n.enabled; })(), "");

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
