/* sw.js — 手机/离线挂载点（仅在 http(s) 下生效；file:// 打开时不注册）
 * 更新版本改 APP_VERSION，老缓存会被清掉。 */
const APP_VERSION = "noadic-v9";   // v2=三级批量删除，v3=判定按钮换行修复+撤销按钮恒可点，v4=背诵页（遮罩 + 背不熟标记），v5=音标在 Android 上吐方框，v6=删除/新建改走页内弹层（鸿蒙无默认 JS 弹框），v7=探测真验生成通道+本地http端点明文许可，v8=安卓导出改走可复制文本+共用 debug keystore，v9=修复导入备份被截断成 4000 字符
const SHELL = [
  "./", "./index.html", "./css/app.css", "./manifest.webmanifest", "./icon.svg",
  "./js/seed-words.js", "./js/lexicon.js", "./js/dict-extra.js", "./js/store.js",
  "./js/parse.js", "./js/distractors.js", "./js/quiz.js", "./js/ai.js", "./js/ui.js", "./js/app.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                      // AI 请求一律不走缓存
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // 跨域（API）直接放行
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(APP_VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => hit))
  );
});
