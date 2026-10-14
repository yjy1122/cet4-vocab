# 打包成 Android APK

## 先说结论：三条路都通，日常走 A

| 路线 | 需要什么 | 出包耗时 | 产物 |
|---|---|---|---|
| **A 云构建**（推荐） | 一个 GitHub 账号，本机零安装 | 1–2 分钟 | Release 上的 `app-debug.apk` |
| **B 本机便携工具链** | 一次性下载 ~1.2 GB 到 `.tooling\` | 增量约 30 秒 | `dist\noadic-debug.apk` |
| **C 不打包** | 手机与电脑同网 | 即时 | PWA（添加到主屏幕） |

本机现在**已经具备**路线 B 的全部条件（工具链都在项目内，不写系统、不要管理员）：

| 需要的东西 | 现状 |
|---|---|
| Node.js | ✅ v24.20 |
| JDK 17+（要 `javac`） | ✅ `.tooling\jdk17`（Temurin 17） |
| Android SDK（platform-tools / build-tools;34 / platforms;android-34） | ✅ `.tooling\android-sdk` |
| Gradle | ✅ `.tooling\gradle-dist\gradle-8.2.1`（wrapper 的自动下载在这台机器上不通，脚本改为自下 `-bin` 包直调 `gradle.bat`） |
| git | ✅ `.tooling\git`（PortableGit，用 `.\git.ps1` 包一层） |

工程侧：`www/` 是唯一 web 根、`capacitor.config.json`、`package.json`、`assets/icon.png`+`splash.png`、云构建 workflow、本机一键脚本。

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
| 5 | `cap add android` + `cap sync`；写 `local.properties` 指向 .tooling；**盖写 versionName**；**核对应用身份** | — |
| 6 | 图标/开屏：`_tools\android-res.py`（Pillow）直接写 `res/mipmap-*`（避开要联网下 sharp 的 `@capacitor/assets`） | — |
| 7 | `gradle.bat assembleDebug`（Gradle 缓存放 `.tooling\gradle`，工程路径走 ASCII 联接） | ~600 MB |

产物复制到 **`dist\noadic-debug.apk`**，全程日志在 **`.tooling\build.log`**（出错先看它）。

### 本机与云构建必须出同一个包（两条真实分歧，都已加校验）

同一条 commit 走两条路，出过两个**互不相干**的 App。原因都在 Capacitor 的工程生成时机上：

| 分歧 | 为什么会不同 | 现在怎么拦 |
|---|---|---|
| `versionName` 一直是 `"1.0"` | 模板硬编码，`cap add`/`cap sync` 都**不会**用 `package.json` 覆盖它（实测：package.json 已 1.1.0，`aapt dump badging` 仍写 `versionName='1.0'`） | 两条路线都在编译前显式盖写；本机用 `[IO.File]::WriteAllText` 而非 `Set-Content -Encoding UTF8`，因为 PS 5.1 会写 BOM，Gradle 读带 BOM 的 groovy 会翻脸 |
| 包名/应用名还是改名前的 `com.cet4.vocabengine` / 「CET-4 词汇」 | `cap sync` 只同步 `www/`，**只有 `cap add` 生成工程时**才把 `appId`/`appName` 写进 `build.gradle` 与 `strings.xml`。CI 每次从零 `cap add`，所以一直是对的；本机那份 `android/` 是改名前留下的 | 脚本比对 `capacitor.config.json` 与 `applicationId`/`app_name`，不一致直接停下并给出修法（`Remove-Item -Recurse -Force android` 后重跑）——宁可停下，也不要默默产出一个人畜无害的错包 |

验证一条包到底装的是哪个 App，看这三行就够：

```powershell
.tooling\android-sdk\build-tools\34.0.0\aapt.exe dump badging dist\noadic-debug.apk | Select-String '^package:|application-label:|launchable'
# package: name='com.noadic.app' versionName='1.2.0' / application-label:'noadic'
python _tools\apk-peek.py dist\noadic-debug.apk www   # 包内资源与 www/ 逐文件 SHA 对账
```

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

脚本按 6 步走：检查工具链（缺什么直接告诉你缺什么）→ `npm install` → `cap add/sync` → 图标 → **盖写 versionName** → `gradlew assembleDebug`，产物在
`android\app\build\outputs\apk\debug\app-debug.apk`。首次约 10–25 分钟（要下 Gradle 和依赖）。

> 注意：`build-apk.ps1` 含中文，必须**以 UTF-8 with BOM 保存**，否则 Windows PowerShell 5.1 会按 GBK 解析并报"字符串缺少终止符"之类的乱码错误。
> 仓库里的编辑类工具写文件时不带 BOM，所以**改完任何 `.ps1` 都要跑一次** `powershell -ExecutionPolicy Bypass -File _tools\fix-ps1-encoding.ps1 -All`（它顺带做 `PSParser::Tokenize`，括号不配对当场报）。

`build-apk.ps1` 只查 **PATH 上的 `javac`**，不认 `.tooling\` 里那份便携 JDK。所以在这台机器上直接跑它，会看到：

```
== 1/6 检查工具链 ==
❌ 没有 javac（只有 JRE 不够，需要 JDK）
   怎么办：winget install EclipseAdoptium.Temurin.17.JDK 然后重开终端
```

这不是坏了，是它按设计拦你 —— 想要本机出包，走路线 B 的 `toolchain-and-build.ps1`（它自己导出 `JAVA_HOME`/`ANDROID_HOME` 再编译）；或者手动把便携工具链挂到当前会话：

```powershell
$env:JAVA_HOME = "$PWD\.tooling\jdk17"; $env:ANDROID_HOME = "$PWD\.tooling\android-sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1 -SkipInstall
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

## 在模拟器/真机上跑端到端测试

仓库带了一个设备冒烟测试（MuMu 实测，Android 15 / x86_64 / 1080×1920）：

```powershell
node _tools\device-smoke.mjs --shots        # 21 条断言，全程真实点击
node _tools\device-smoke.mjs --selftest     # 负向对照：确认这套检查真的会失败
```

它不依赖 WebView 调试通道（MuMu 的系统 WebView 即使 `webContentsDebuggingEnabled=true` 也不建 devtools socket，`/proc/net/unix` 里 0 个条目），而是用 `uiautomator` 无障碍树**按文字与 resource-id 定位**，每次点击前重新 dump，因此对旋转和分辨率免疫。

六个实测踩到的坑，记在这里免得下次重找：

1. **`pm clear` 不清 `app_webview`**：装了新 APK，WebView 仍在跑上一版的 JS/CSS，症状是"代码明明改了、行为没变"，能把人引到完全错误的结论上。脚本现在先 `adb uninstall` 再 install。
2. **`uiautomator dump` 写完文件后以 139（SIGSEGV）退出**：按退出码判失败就会永远拿到空树，于是所有断言一起假红。脚本不看退出码，只看拉回来的文件是否可用。
3. **adb 的 Windows 构建处理含中文的路径会静默失败**：`install` / `pull` 的路径一律走 ASCII 联接 `D:\noadic-build`。
4. **无障碍树的 `enabled` 会给过期值**：所以断言只查**行为**（点得动、词数回来、再点不破坏数据），不查状态位。
5. **`adb kill-server` 会连模拟器自己起的 server 一起杀**，而重启时 adb 要写 `%TEMP%\adb.log` —— 受限环境下报 `Permission denied` 且再也起不来。把 `TEMP`/`TMP` 指到工作区内即可：`$env:TEMP="$PWD\.tooling\tmp"`。
6. **一段带 `<b>` 的文案在无障碍树里会被拆成多个文本节点**：`标了不熟 <b>0</b> 个` 不是整串 `"标了不熟 0 个"`，正则直接匹配必然空手。脚本用 `numAfterLabel()`：先按标签找到节点，再往后几格取数字。

> 模拟器没开时可以先用它的管理命令行拉起，不必去点界面：`"...\nx_main\MuMuManager.exe" control -v 0 launch`，再 `info -v 0` 看状态（注意 `is_android_started` 可能仍报 false，以 `adb devices` 里出现设备为准）。

> 顺带一条真机才暴露的产品缺陷（已修）：`撤销上次改动` 原先用 `disabled` 表达"没得撤销"，删完一整单元后快照明明躺在 localStorage 里（`run-as` 读到 `noadic.undo`，总量仅 312 KB，远未达配额），按钮却仍是禁用态——**最需要撤销的时刻点不动**。现在按钮恒可点，无事时由 toast 明确说明。


## 想上正式签名包

```powershell
keytool -genkey -v -keystore noadic.keystore -alias cet4 -keyalg RSA -keysize 2048 -validity 10000
```
然后在 `android/` 里配置签名（Capacitor 生成工程后可用 Android Studio 一键 Sign APK），再 `.\build-apk.ps1 -Release`。个人自用不需要这一步。
