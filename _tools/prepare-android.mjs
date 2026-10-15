/* prepare-android.mjs — cap sync 之后、gradle 之前必须做的三件事。
 *
 * 为什么存在：这些修正**不属于 www/，也不属于 capacitor.config.json**，
 * cap add / cap sync 都不会替我们写。以前本机脚本和 CI 各抄一份 sed，
 * 结果 CI 那份漏了明文许可 —— 从 Releases 下的包连不上本地 http 端点，
 * 而本机包是好的。两条路线各写一遍，迟早分叉，所以收敛成这一个文件。
 *
 * CI(Ubuntu) 与本机(Windows) 都调用：node _tools/prepare-android.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rel = (...p) => path.join(root, ...p);
const die = (m) => { console.error('❌ ' + m); process.exit(1); };
const say = (m) => console.log('   ' + m);

const cap = JSON.parse(fs.readFileSync(rel('capacitor.config.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(rel('package.json'), 'utf8'));

/* ---------- 1. versionName 对齐 package.json ---------- */
const gradlePath = rel('android', 'app', 'build.gradle');
if (!fs.existsSync(gradlePath)) die('找不到 android/app/build.gradle（cap add 跑了吗？）');
let g = fs.readFileSync(gradlePath, 'utf8');
if (!/versionName\s+"/.test(g)) die('build.gradle 里没有 versionName，模板变了，对照此脚本调整');
const wantVer = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(wantVer)) die(`package.json 版本号不合法: ${wantVer}`);
g = g.replace(/versionName ".*"/, `versionName "${wantVer}"`);
fs.writeFileSync(gradlePath, g);
say(`versionName -> ${wantVer}`);

/* ---------- 2. 明文流量许可（本地 http 端点需要） ---------- */
/* Android 9+ 默认禁明文 http。这一层在 WebView 的 allowMixedContent **之下**：
   实测只开混合内容仍然 Failed to fetch，必须同时有 usesCleartextTraffic。
   代价：App 可访问任意明文地址。本 App 自己不带网络调用，唯一出口是用户填的端点。 */
const manPath = rel('android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manPath)) die('找不到 AndroidManifest.xml');
let m = fs.readFileSync(manPath, 'utf8');
if (!/<application/.test(m)) die('AndroidManifest.xml 里没有 <application>，模板变了');
if (!/usesCleartextTraffic/.test(m)) {
  m = m.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  fs.writeFileSync(manPath, m);
  say('AndroidManifest 补上 usesCleartextTraffic=true');
} else say('AndroidManifest 已有 usesCleartextTraffic，跳过');

/* ---------- 3. 应用身份必须与 capacitor.config.json 一致 ---------- */
/* cap sync 只同步 www，**不会**把改过的 appId/appName 回写进已有工程（只有 cap add 才写）。
   实测踩过：改名后本机出的包仍是旧 applicationId，与 CI 的包互不相干。 */
const appId = /applicationId\s+"([^"]+)"/.exec(fs.readFileSync(gradlePath, 'utf8'));
if (!appId) die('build.gradle 里没有 applicationId');
if (appId[1] !== cap.appId) die(`applicationId 不一致：工程里是 ${appId[1]}，capacitor.config.json 要的是 ${cap.appId}\n   → 删掉 android/ 重新 npx cap add android`);
say(`applicationId = ${appId[1]} ✅`);
const strPath = rel('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
if (fs.existsSync(strPath)) {
  const label = /<string name="app_name">([^<]*)<\/string>/.exec(fs.readFileSync(strPath, 'utf8'));
  if (label && cap.appName && label[1] !== cap.appName) {
    die(`app_name 不一致：strings.xml 里是「${label[1]}」，capacitor.config.json 要的是「${cap.appName}」\n   → 删掉 android/ 重新 npx cap add android`);
  }
  if (label) say(`app_name = ${label[1]} ✅`);
}

/* ---------- 4. 回读确认：静默没写进去的话，症状极难归因 ---------- */
const g2 = fs.readFileSync(gradlePath, 'utf8');
if (!g2.includes(`versionName "${wantVer}"`)) die('versionName 未真正写入 build.gradle');
const m2 = fs.readFileSync(manPath, 'utf8');
if (!/usesCleartextTraffic="true"/.test(m2)) die('usesCleartextTraffic 未真正写入 AndroidManifest.xml');
say('回读确认：三项都已落到磁盘 ✅');
