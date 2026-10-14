/* sw.js — 手机/离线挂载点（仅在 http(s) 下生效；file:// 打开时不注册）
 * 更新版本改 APP_VERSION，老缓存会被清掉。 */
const APP_VERSION = "cet4-engine-v2";   // 批量删除（整课/整单元）+ 词库工具栏改动：抬版本清老缓存
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
