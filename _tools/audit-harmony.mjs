/* audit-harmony.mjs — 鸿蒙工程的静态体检。
 *
 * 为什么需要：HAP 只能在装了 DevEco + 华为账号的机器上编译，一轮反馈是几十分钟，
 * 而且报错经常指向 SDK/签名而不是真正的原因。这里把不需要编译器就能查的部分全查掉。
 *
 * 用法：node _tools/audit-harmony.mjs [--net]     --net 额外验证依赖锁的 URL 可达
 * 退出码非 0 = 有问题；每条失败都给出「怎么改」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const H = path.join(ROOT, 'harmony');
const WWW = path.join(ROOT, 'www');
const RAWFILE = path.join(H, 'entry', 'src', 'main', 'resources', 'rawfile');
const WANT_NET = process.argv.includes('--net');

let bad = 0, warn = 0, ok = 0;
const fail = (m, fix) => { bad++; console.log('  ❌ ' + m + (fix ? '\n     → ' + fix : '')); };
const note = (m, fix) => { warn++; console.log('  ⚠  ' + m + (fix ? '\n     → ' + fix : '')); };
const pass = (m) => { ok++; console.log('  ✅ ' + m); };

/* json5 里允许注释与尾逗号，这里用最朴素的容错：去注释 + 去尾逗号后按 JSON 解析 */
function readJson5(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try { return { json: JSON.parse(stripped), raw }; }
  catch (e) { return { error: e.message, raw }; }
}

/* ---------- 1. 打进包里的 web 资源必须与 www/ 逐字节一致 ---------- */
console.log('\n[1] rawfile 与 www/ 的一致性（等价于安卓那条 www↔APK 校验）');
if (!fs.existsSync(RAWFILE)) {
  fail('rawfile 目录不存在：打出来的 HAP 里没有任何页面，Web 组件会白屏',
    '先跑 powershell -File sync-www.ps1（rawfile 被 .gitignore 排除，不入库）');
} else {
  const walk = (dir, base) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileSizes: false, encoding: 'utf8' })) {
      const f = path.join(dir, e), st = fs.statSync(f);
      if (st.isDirectory()) out.push(...walk(f, base));
      else out.push(path.relative(base, f).split(path.sep).join('/'));
    }
    return out;
  };
  const a = walk(WWW, WWW).sort();
  const b = walk(RAWFILE, RAWFILE).sort();
  const missing = a.filter((f) => !b.includes(f));
  const extra = b.filter((f) => !a.includes(f));
  const differ = [];
  for (const f of a) {
    if (!b.includes(f)) continue;
    const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (h(path.join(WWW, f)) !== h(path.join(RAWFILE, f))) differ.push(f);
  }
  if (!a.length) fail('www/ 是空的，检查仓库是否完整');
  else if (missing.length || extra.length || differ.length) {
    fail(`rawfile 与 www/ 不一致：缺 ${missing.length}、多 ${extra.length}、内容不同 ${differ.length}`,
      '跑 powershell -File sync-www.ps1 重新同步。缺的文件举例：'
      + [missing[0], extra[0], differ[0]].filter(Boolean).join('、'));
  } else pass(`${a.length} 个文件逐字节一致（index.html / css / js 全在内）`);
  if (!b.includes('index.html')) fail('rawfile/index.html 不存在，但 Index.ets 用 $rawfile(\'index.html\') 加载它');
}

/* ---------- 2. 资源引用必须都能解析 ---------- */
console.log('\n[2] $string / $media / $color / $profile 引用');
const RES_KIND = { string: 'element/string.json', color: 'element/color.json', float: 'element/float.json' };
function resNames(kind) {
  const names = new Set();
  const dirs = [path.join(H, 'AppScope', 'resources'), path.join(H, 'entry', 'src', 'main', 'resources')];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const qual of fs.readdirSync(d)) {                 // base / dark / zh_CN ...
      const el = path.join(d, qual, 'element');
      if (!fs.existsSync(el)) continue;
      for (const f of fs.readdirSync(el)) {
        if (!f.endsWith('.json')) continue;
        const j = readJson5(path.join(el, f));
        if (j.error) { fail(`${qual}/element/${f} 解析失败：${j.error}`); continue; }
        const arr = j.json[kind];
        if (Array.isArray(arr)) arr.forEach((x) => x && x.name && names.add(x.name));
      }
      const media = path.join(d, qual, 'media');
      if (kind === 'media' && fs.existsSync(media)) fs.readdirSync(media).forEach((f) => names.add(f.replace(/\.[^.]+$/, '')));
      const profile = path.join(d, qual, 'profile');
      if (kind === 'profile' && fs.existsSync(profile)) fs.readdirSync(profile).forEach((f) => names.add(f.replace(/\.[^.]+$/, '')));
    }
  }
  return names;
}
const have = {
  string: resNames('string'), color: resNames('color'), float: resNames('float'),
  media: resNames('media'), profile: resNames('profile'),
};
const srcFiles = [];
(function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e);
    if (fs.statSync(dir).isDirectory() && fs.statSync(f).isDirectory()) collect(f);
    else if (/\.(json5|json|ets|ts)$/.test(e)) srcFiles.push(f);
  }
})(H);
const refs = [];
for (const f of srcFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/\$(string|media|color|float|profile):([A-Za-z0-9_]+)/g)) {
    refs.push({ kind: m[1], name: m[2], file: path.relative(ROOT, f) });
  }
}
if (!refs.length) fail('一处 $ 资源引用都没提取到——审计脚本本身失效，结论不可用');
else {
  const dangling = refs.filter((r) => !have[r.kind].has(r.name));
  const uniq = [...new Map(dangling.map((r) => [r.kind + r.name, r])).values()];
  if (uniq.length) uniq.forEach((r) => fail(`${r.file} 引用 $${r.kind}:${r.name}，但资源表里没有这个名字`,
    '编译期会直接报 resource not found；补进 element/*.json 或改掉引用'));
  else pass(`${refs.length} 处资源引用全部可解析（${[...new Set(refs.map((r) => r.kind))].join('/')}）`);
}

/* ---------- 3. 身份与版本要和仓库其余部分对齐 ---------- */
console.log('\n[3] bundleName / 版本 / 品牌');
const appJ = readJson5(path.join(H, 'AppScope', 'app.json5'));
if (appJ.error) fail('AppScope/app.json5 解析失败：' + appJ.error);
else {
  const app = appJ.json.app;
  const cap = readJson5(path.join(ROOT, 'capacitor.config.json'));
  if (!cap.error && cap.json.appId !== app.bundleName)
    fail(`bundleName=${app.bundleName} 与 capacitor appId=${cap.json.appId} 不一致`, '两端应当是同一个应用身份');
  else pass('bundleName 与安卓 appId 一致：' + app.bundleName);
  const pkg = readJson5(path.join(ROOT, 'package.json'));
  if (!pkg.error && pkg.json.version !== app.versionName)
    fail(`app.json5 versionName=${app.versionName} 与 package.json ${pkg.json.version} 不一致`,
      '版本号漂移会让发布说明和包内版本对不上');
  else pass('versionName 与 package.json 一致：' + app.versionName);
  const s = readJson5(path.join(H, 'AppScope', 'resources', 'base', 'element', 'string.json'));
  const name = s.json && (s.json.string || []).find((x) => x.name === 'app_name');
  if (!name || name.value !== 'noadic') fail(`应用名不是 noadic（当前 "${name ? name.value : '?'}"）`);
  else pass('应用名 = noadic');
}

/* ---------- 4. 签名材料：这台机器上大概率没有，要说清楚 ---------- */
console.log('\n[4] 签名配置');
const bp = readJson5(path.join(H, 'build-profile.json5'));
if (bp.error) fail('build-profile.json5 解析失败：' + bp.error);
else {
  const cfgs = (bp.json.app && bp.json.app.signingConfigs) || [];
  if (!cfgs.length) note('没有 signingConfigs：能编译出未签名包，但装不到手机上');
  for (const c of cfgs) {
    const mat = c.material || {};
    for (const k of ['storeFile', 'profile', 'certpath']) {
      const v = mat[k];
      if (!v) continue;
      if (!fs.existsSync(v)) {
        // 换一台机器必然缺：这不该算硬失败，否则会把"工具链也没装"这第二个坎藏起来。
        // 但也不能一声不吭——build 会在签名那步炸，报错完全指不到这里。
        note(`${c.name}.${k} 不存在：${v}`,
          '这是别人机器上的绝对路径（DevEco 生成 debug 证书时写死的）。换机器请在 DevEco 里 '
          + 'File ▸ Project Structure  Signing Configs 勾选 Automatically sign 重新登录生成；'
          + 'debug profile 还绑定设备 UDID，换手机要重新申请。');
      } else pass(`${c.name}.${k} 可访问`);
    }
  }
}

/* ---------- 5. 鸿蒙容器的已知前提（网页侧） ---------- */
console.log('\n[5] ArkWeb 适配前提');
const uiJs = fs.readFileSync(path.join(WWW, 'js', 'ui.js'), 'utf8');
const appJs = fs.readFileSync(path.join(WWW, 'js', 'app.js'), 'utf8');
if (!/function askConfirm/.test(uiJs)) fail('ui.js 里没有 askConfirm：删除/新建仍依赖原生弹框',
  'ArkWeb 不提供默认 JS 弹框，不接 onConfirm 时 confirm() 恒为 false → 鸿蒙上删除会静默失效');
else pass('页内确认/输入弹层已就位（不依赖容器实现 JS 弹框）');

const bareDialog = [];
for (const f of fs.readdirSync(path.join(WWW, 'js'))) {
  const txt = fs.readFileSync(path.join(WWW, 'js', f), 'utf8');
  txt.split('\n').forEach((line, i) => {
    if (/^\s*(if\s*\(\s*!?\s*)?(window\.)?(confirm|prompt|alert)\s*\(/.test(line.trim())
      && !/askConfirm|askPrompt/.test(line)) bareDialog.push(`${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
  });
}
if (bareDialog.length) fail('仍有裸用原生弹框的地方，在鸿蒙上会静默失败：\n        ' + bareDialog.join('\n        '));
else pass('www/js 里没有裸用 confirm/prompt/alert');

if (!/isArkWeb/.test(appJs)) note('app.js 未做鸿蒙容器识别：导出备份在鸿蒙里会落进私有目录（用户拿不到）');
else pass('导出备份与 SW 注册都按容器区分处理');

const mod = readJson5(path.join(H, 'entry', 'src', 'main', 'module.json5'));
if (!mod.error) {
  const perms = ((mod.json.module || {}).requestPermissions || []).map((p) => p.name);
  if (!perms.includes('ohos.permission.INTERNET')) fail('module.json5 缺 ohos.permission.INTERNET：AI 端点探测与直连都发不出去');
  else pass('已声明 INTERNET 权限');
}

/* ---------- 6. 可选：依赖锁可达性 ---------- */
if (WANT_NET) {
  console.log('\n[6] ohpm 依赖锁可达性（公共源）');
  const lock = fs.readFileSync(path.join(H, 'oh-package-lock.json5'), 'utf8');
  for (const u of [...lock.matchAll(/"resolved":\s*"([^"]+)"/g)].map((m) => m[1])) {
    try {
      const r = await fetch(u, { redirect: 'follow', headers: { 'user-agent': 'curl/8' } });
      const n = (await r.arrayBuffer()).byteLength;
      if (r.status === 200 && n > 100) pass(`${u.split('/').pop()} ${n} 字节`);
      else fail(`依赖取不到：${r.status} ${u}`);
    } catch (e) { fail(`依赖请求失败：${u} → ${e.message}`); }
  }
} else console.log('\n[6] 跳过依赖可达性检查（加 --net 开启）');

console.log(`\n结论：${ok} 项通过，${warn} 项提示，${bad} 项失败`);
process.exit(bad ? 1 : 0);
