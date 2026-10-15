/* update.js — 检查 GitHub Releases 是否有新版本。
 *
 * 为什么只到"去下载"而不做应用内自动安装：
 * 安卓侧静默安装需要 REQUEST_INSTALL_PACKAGES 权限 + FileProvider + 原生下载回调，
 * 而 android/ 工程由 cap add 生成、不入库，把原生代码写在那儿下次重新生成就没了。
 * 所以这里做的是：查版本 → 展示更新内容 → 交给系统浏览器下载 APK，用户自己点安装。
 *
 * 前提已实测（不是猜的）：api.github.com 在 Capacitor WebView 里可跨域访问，
 * GET /releases/latest 返回 200 且正确排除预发布版 latest-debug。
 */
const Update = (() => {
  const REPO = "yjy1122/noadic";
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;

  /* 当前版本从 www/version.js 注入（构建时由 prepare-android.mjs 从 package.json 盖写）。
     读不到时必须明说，绝不能拿 undefined 去比较 —— 那会稳定地误报"有新版本"。 */
  const current = () => (typeof window.APP_VERSION === "string" && /^\d+\.\d+\.\d+$/.test(window.APP_VERSION)) ? window.APP_VERSION : "";
  const tagToVer = (t) => { const m = /^v?(\d+\.\d+\.\d+)/.exec(String(t || "").trim()); return m ? m[1] : ""; };

  /** 语义化版本比较：a > b 返回 1。只比数字段，预发布后缀忽略（本仓库 tag 不带）。 */
  function cmp(a, b) {
    const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    if (pa.length < 3 || pb.length < 3 || pa.some(isNaN) || pb.some(isNaN)) return 0;
    for (let i = 0; i < 3; i++) { if ((pa[i] | 0) > (pb[i] | 0)) return 1; if ((pa[i] | 0) < (pb[i] | 0)) return -1; }
    return 0;
  }

  function apkAsset(assets) {
    const list = Array.isArray(assets) ? assets : [];
    const hit = list.find((a) => /\.apk$/i.test(a && a.name || "")) || list.find((a) => (a && a.content_type || "").includes("android"));
    return hit && hit.browser_download_url ? hit.browser_download_url : "";
  }

  /** 检查更新。永不抛错：返回 {state, msg, ...}，让 UI 决定怎么显示。 */
  async function check() {
    const cur = current();
    if (!cur) return { state: "unknown", msg: "本机版本号没注入（缺少 www/version.js）。构建流程漏了盖章这一步，此时无法判断是否要更新。" };
    let res;
    try {
      res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    } catch (e) {
      return { state: "offline", msg: "连不上 GitHub（" + ((e && e.message) || e) + "）。检查网络，或直接在浏览器打开 github.com/" + REPO + "/releases" };
    }
    if (res.status === 403 || res.status === 429) {
      return { state: "limited", msg: "GitHub API 匿名调用有速率限制（约 60 次/小时/IP），这次被限流了。稍后再试，或直接看 Releases 页。" };
    }
    if (!res.ok) return { state: "error", msg: `GitHub 返回 HTTP ${res.status}` };
    let j;
    try { j = await res.json(); } catch (e) { return { state: "error", msg: "GitHub 返回的不是合法 JSON（可能被网络中间件改写）" }; }
    const latest = tagToVer(j.tag_name);
    if (!latest) return { state: "error", msg: `响应里没有可用的版本号（tag_name=${JSON.stringify(j.tag_name)}）` };
    const url = (j.html_url || ("https://github.com/" + REPO + "/releases")) + "";
    const dl = apkAsset(j.assets) || url;
    if (cmp(latest, cur) > 0) {
      return { state: "update", current: cur, latest, name: j.name || latest, notes: String(j.body || "").trim(), url, dl, published: (j.published_at || "").slice(0, 10) };
    }
    return { state: "latest", current: cur, latest, url };
  }

  /** Release 正文是 Markdown，直接塞进 <pre> 会露出 ### ** ` 这些记号（实测截图里就是这样）。
   *  这里只做最小转换：先转义再还原粗体/行内代码/标题记号，绝不引入 HTML 白名单外的东西。
   *  做成纯函数是为了能被回归测试覆盖——UI 里的字符串处理没人测就等于没有。 */
  function mdLite(src) {
    let s = String(src == null ? "" : src);
    s = s.replace(/\r\n/g, "\n");
    s = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));   // 先转义
    s = s.replace(/^#{1,6}\s*(.+)$/gm, "$1");                       // 标题记号去掉，行本身保留
    s = s.replace(/^\s*[-*]\s+/gm, "· ");                            // 列表符号统一
    s = s.replace(/`([^`\n]+)`/g, "$1");                             // 行内代码：去掉反引号
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");                // 粗体
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。；;:：]|$)/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）');  // 链接展开成文字+URL，不塞 <a>
    return s.trim();
  }

  return { API, REPO, check, cmp, tagToVer, current, apkAsset, mdLite };
})();

/* 与其余模块一致的暴露方式：xref 对账就是读 window 上的导出键，
   少了这一行它会报"Update 0 个成员"，跨模块引用等于没人查。 */
if (typeof window !== "undefined") window.Update = Update;
