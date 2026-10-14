# 打包成 Android APK

## 先说结论：这台机器现在出不了 APK

我查过了，缺的不是磁盘（C 剩 15.5 GB、D 剩 24.8 GB，够用），而是**工具链**：

| 需要的东西 | 现状 |
|---|---|
| Node.js | ✅ v24.20 |
| JDK 17+（要 `javac`） | ❌ 只有 JRE 8（`java.exe`，无编译器） |
| Android SDK（platform-tools / build-tools;34 / platforms;android-34） | ❌ 无，`ANDROID_HOME` 未设置 |
| Gradle | ❌ 无（Capacitor 的 wrapper 会自己下，但需要 JDK+SDK） |
| git | ❌ 无 |

工程侧我已经全部铺好：`www/` 是唯一 web 根、`capacitor.config.json`、`package.json`、`assets/icon.png`+`splash.png`、云构建 workflow、本机一键脚本。**只差工具链这一步**。下面三条路任选。

---

## 路线 A：云构建（推荐，本机零安装）

不需要 JDK / Android SDK / git，只要一个 GitHub 账号。

1. 在 GitHub 新建一个空仓库（**公开/私有都行**：仓库里只有代码和种子词表，你的学习记录与词库都在设备本地，不会被公开；勾选 "Add a README" 会让首次推送冲突，别勾）。
   推送用的 token 需要 **Contents: Read and write** 和 **Workflows: Read and write** 两项——少后者会被 GitHub 服务端 `remote rejected`，而且 `push --dry-run` 抓不到这个错。详见 README 的"连接 GitHub"。
2. 把本目录整体上传，**必须包含**这些：
   ```
   www/                     应用本体（含图标 PNG）
   assets/icon.png          1024×1024 图标源图
   assets/splash.png        开屏图源图
   capacitor.config.json
   package.json
   .github/workflows/android.yml
   .gitignore
   ```
   不要上传 `node_modules/`、`android/`（由 CI 现场生成）。没有 git 就用网页的 **Add file → Upload files**，或装个 GitHub Desktop。
3. 仓库页 → **Actions** → 选「构建 Android APK」→ **Run workflow**（push 也会自动触发；打 `v*` 标签会额外出一个正式版本 Release）。
4. 约 **1–2 分钟**后 Job 结束，APK 会**自动发布到仓库的 Releases**：
   - `latest-debug`（预发布）＝ 每次 push 自动覆盖的最新包，日常装这个；
   - 你打的 `v*` 标签 ＝ 冻结版本；
   - Actions 里的 Artifacts `noadic-debug-apk` 仍然保留，作为每次 run 的原始留档。
5. 直接下载：`https://github.com/你的用户名/noadic/releases/download/latest-debug/app-debug.apk`（公开库不用登录）→ 传到手机 → 点击安装 → 允许「安装未知来源应用」。debug 包无需签名、无需上架。

以后改完代码只要重新 push，APK 自动重新构建**并更新到 Release**。发正式版：`.\git.ps1 tag -a v1.0 -m "v1.0"` 然后 `.\git.ps1 push origin v1.0`。

## 路线 B：本机出包（便携工具链，不装进系统）

用 `_tools\toolchain-and-build.ps1`：把 **JDK 17 与 Android SDK 下载解压到项目内的 `.tooling\`**，不写 Program Files、不要管理员、不改系统环境变量；删掉 `.tooling\` 就等于没装过。

```powershell
cd "D:\Users\DawnFish\Desktop\新建文件夹"
powershell -NoProfile -ExecutionPolicy Bypass -File .\_tools\toolchain-and-build.ps1
```

按 7 步走，每步幂等（装过的自动跳过）：

| 步 | 动作 | 体量 |
|---|---|---|
| 1 | Temurin JDK 17 → `.tooling\jdk17` | ~182 MB |
| 2 | Android command-line tools → `.tooling\android-sdk\cmdline-tools\latest` | ~147 MB |
| 3 | 接受许可 + `platform-tools` / `platforms;android-34` / `build-tools;34.0.0` | ~700 MB |
| 4 | `npm install`（@capacitor/cli、@capacitor/android） | ~200 MB |
| 5 | `cap add android` + `cap sync`，并写 `android/local.properties` 指向 .tooling | — |
| 6 | 图标/开屏：先试 `@capacitor/assets`，失败则用 `_tools\android-res.py`（Pillow）直接写 `res/mipmap-*` | — |
| 7 | `gradlew assembleDebug`（Gradle 缓存放 `.tooling\gradle`） | ~600 MB |

产物复制到 **`dist\noadic-debug.apk`**，全程日志在 **`.tooling\build.log`**（出错先看它）。

> 前提：能访问 `api.adoptium.net`、`dl.google.com`、`registry.npmjs.org`。这台机器设了本地代理 `127.0.0.1:10808`，且**代理客户端离线时 TLS 会直接断**——自己开终端跑之前，先确认代理在线（必要时 `$env:HTTPS_PROXY="http://127.0.0.1:10808"`）。

### 想装到系统级（可选，长期开发/IDE 调试）

```powershell
winget install EclipseAdoptium.Temurin.17.JDK
winget install Google.AndroidStudio        # 含 Android SDK；或只装 commandline-tools
```

装完**重开终端**，确认 `javac -version` 是 17+、`ANDROID_HOME` 有值，然后：

```powershell
cd "D:\Users\DawnFish\Desktop\新建文件夹"
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
```

脚本会先检查工具链（缺什么直接告诉你缺什么），然后 `npm install → cap add android → cap sync → 生成图标 → gradlew assembleDebug`，产物在
`android\app\build\outputs\apk\debug\app-debug.apk`。首次约 10–25 分钟（要下 Gradle 和依赖）。

> 注意：`build-apk.ps1` 含中文，必须**以 UTF-8 with BOM 保存**，否则 Windows PowerShell 5.1 会按 GBK 解析并报"字符串缺少终止符"之类的乱码错误（我已验证当前文件带 BOM，能正常跑出依赖检查）。

实测本机现状（我刚跑过一次，脚本正确拦下）：

```
== 1/5 检查工具链 ==
❌ 没有 javac（只有 JRE 不够，需要 JDK）
   怎么办：winget install EclipseAdoptium.Temurin.17.JDK 然后重开终端
```

## 路线 C：不打 APK，直接用 PWA（零成本，最省事）

手机和电脑在同一网络时，电脑上起个服务：

```powershell
python -m http.server 8080 -d www
```

手机浏览器开 `http://<电脑IP>:8080` → 菜单里选**「添加到主屏幕」**。得到的是：独立图标、无地址栏全屏、白色主题、底部导航、离线可用（Service Worker 已配好）。和 APK 的差别主要是没有应用商店入口和系统推送；日常背单词够用。

---

## 装成 App 之后你需要知道的三件事

1. **数据存在 WebView 的 localStorage 里**，跟"清除应用数据/卸载"绑定。换机或清理前，务必用 **设置 → 导出 JSON** 备份；导入走同一套合并去重，进度不会被冲掉。
2. **AI 直连在 App 里同样受 CORS 限制**。Capacitor 的页面源是 `https://localhost`，云端 API 一般不放行跨域，所以「直连补全」可能仍失败——**复制粘贴桥**在 App 里照常可用。要真正在 App 内直连，需要再加 `@capacitor/http` 或自建一个转发层（说一声我就接）。
3. **拍照录入**在 App 里会调起系统相机（`<input accept="image/*">` 由 WebView 接管），但识别仍需支持视觉的模型。

## 想上正式签名包

```powershell
keytool -genkey -v -keystore noadic.keystore -alias cet4 -keyalg RSA -keysize 2048 -validity 10000
```
然后在 `android/` 里配置签名（Capacitor 生成工程后可用 Android Studio 一键 Sign APK），再 `.\build-apk.ps1 -Release`。个人自用不需要这一步。
