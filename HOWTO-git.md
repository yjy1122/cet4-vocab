# Git 与 GitHub 接入指南（本机实测记录）

这台机器的网络与路径有两个非显然的坑（直连被拒、工作区路径含中文），下面每条都是**实测过**的结论，不是通用建议。项目门面文档见 [`README.md`](README.md)，打包见 [`BUILD-APK.md`](BUILD-APK.md)。

---

## 1. 便携版 Git

装在 `.tooling\git`，**不写系统 PATH、不要管理员权限**。根目录有包装脚本：

```powershell
.\git.ps1 status
.\git.ps1 log --oneline -5
.\git.ps1 diff
.\git.ps1 add -A ; .\git.ps1 commit -m "改了啥"
.\git.ps1 push
```

想在当前会话里直接用 `git`：

```powershell
$env:Path = "$PWD\.tooling\git\cmd;" + $env:Path
```

提交身份写在本仓库（`--local`），当前是 `yjy1122 <97331005+yjy1122@users.noreply.github.com>`（GitHub 隐私中继地址，不外泄真实邮箱）。改法：`.\git.ps1 config user.email "you@example.com"`。

`.gitignore` 排除了 `.tooling/`（1.3 GB 工具链）、`node_modules/`、`android/`（Capacitor 生成物）、`dist/`（APK 与快照）；`.gitattributes` 把 PNG/APK/ZIP 声明为二进制，防止被换行处理破坏。

> **为什么需要版本控制**：开发过程中出现过 `www/index.html` 与 `www/js/ui.js` 被**静默清零**（内容全变 `0x00`，工具不报错）。当时靠 APK 内的同步副本恢复。现在一条命令就能救回来：`.\git.ps1 checkout -- www/js/ui.js`。

---

## 2. 连上 GitHub：三个必踩的坑

### 坑 1：git 不读 Windows 系统代理

这台机器直连 `github.com:443` 被拒，必须走本地代理（`127.0.0.1:10808`）。但 git **不看注册表里那个 IE 代理设置**，得显式配：

```powershell
.\git.ps1 config --local http.proxy http://127.0.0.1:10808
```

**前提是代理客户端在线**，否则表现为连接超时。

### 坑 2：CA 证书包路径含中文会被毁码

工作区目录叫 `新建文件夹`，openssl 后端读它会报：

```
error adding trust anchors from file: D:/.../??½??ļ???/...ca-bundle.crt
```

解法：把路径指到 **ASCII 目录联接** `D:\noadic-build`（它指向同一个工作区）：

```powershell
cmd /c mklink /J D:\noadic-build "D:\Users\DawnFish\Desktop\新建文件夹"
.\git.ps1 config --local http.sslBackend openssl
.\git.ps1 config --local http.sslCAInfo D:/noadic-build/.tooling/git/ucrt64/etc/ssl/certs/ca-bundle.crt
```

同一个原因，Android 构建（AGP 拒绝非 ASCII 工程路径）和 `aapt` 也必须走这个联接。

### 坑 3：`credential-helper-selector` 弹窗把 push 变成"假死"

便携版 git 的**系统级** gitconfig 里有：

```ini
[credential]
    helper = helper-selector
```

`credential.helper` 是**多值继承键**：git 按 系统 → 全局 → 本仓库 顺序收集所有值，第一个能应答的生效，而 `helper-selector` 会**弹一个 GUI 窗口等你点**。`git config --local --replace-all credential.helper ...` 只清本层，清不掉它 —— 表现就是 push 卡住几分钟不动。

唯一正确写法：在本层先写一条**空值**截断继承列表，再挂 store：

```ini
[credential]
    helper =                                   ← 空值，丢弃此前所有 helper
    helper = store --file=D:/noadic-build/.tooling/git-credentials
```

实测：截断前 `git credential fill` 超时 10 秒（弹窗），截断后 **0.1 秒**返回。

> 用 PowerShell 写这条空值有个坑：**PS 5.1 会把空串参数整个丢掉**，git 只收到两个参数就报 `wrong number of arguments`；`git config key=` 这种写法该版本也不认。可行写法是传两个字符的 `'""'`，git 的写入器会落成 `helper = `（空值）。`connect-github.ps1` 里已经这么做了，并带自检断言。

同理，**不要**用 `$line | git credential approve`：PowerShell 往原生程序 stdin 写行时会带 `\r`，git 报 `invalid credential line` 后**静默失败**，脚本却照样打印"已保存"。改成按 LF 直接写 store 文件。

---

## 3. 一次性接入：`connect-github.ps1`

```powershell
.\connect-github.ps1 -Repo 你的用户名/noadic
```

它做四件事：探测代理是否在线 → 配 `http.proxy` / `sslBackend` / `sslCAInfo` / helper 截断 → 提示粘 token（**不回显**，只写进 `.tooling\git-credentials`，已被 `.gitignore` 排除）→ **`push --dry-run` 预检** → 真推送。

### token 需要什么权限

Fine-grained token（Settings → Developer settings → Fine-grained tokens）：

| 权限 | 为什么 |
| --- | --- |
| Repository access → 选中这个仓库（或 All repositories） | 只读得到公开仓库 ≠ token 有权 |
| **Contents: Read and write** | 推代码 |
| **Workflows: Read and write** | 仓库里有 `.github/workflows/*.yml`。缺它会 `remote rejected`：`refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`。**这个限制只在真推送时触发，`push --dry-run` 照样通过**，别被误导（脚本为此专门加了失败分类） |
| Actions: Read-only | 想读构建日志 |
| **Administration: Read and write** | 只有要**改仓库名**时才需要；没有这项就 403，改在网页上点 |

用 Tokens (classic) 更省事：勾 `repo` + `workflow`。

### 读得到 ≠ 写得进

`git ls-remote` 成功只证明读通。仓库是公开的话，**匿名也能读**，所以它连"token 有效"都证明不了。要判权限就：

```powershell
.\git.ps1 push --dry-run origin main     # 走完鉴权，不改远端
curl -X PUT .../contents/_probe.tmp      # 可撤销的写探测
```

---

## 4. 改仓库名 + 填仓库信息（这三件事都要 Administration）

实测：Contents + Workflows 的 fine-grained token 对下面三个操作**全部 403**，
只能在本机改不了、得去网页上点（或给 token 补 `Administration: Read and write`）：

| 操作 | 端点 | 需要的权限 |
|---|---|---|
| 改仓库名 | `PATCH /repos/{o}/{r}` `{"name":"noadic"}` | Administration: write（实测 403） |
| 填简介 | 同上 `{"description":"…"}` | Administration: write |
| 打 topics | `PUT /repos/{o}/{r}/topics` | 实测同样 403（别指望它是 Contents 范围） |

**改名**：仓库 → Settings → General → Repository name → `noadic` → Rename。
改完同步本地：

```powershell
.\git.ps1 remote set-url origin https://github.com/你的用户名/noadic.git
```

**About（网页右上 ⚙）直接粘这些**：

- Description（中英各一，二选一或都用）：
  - `纯本地离线的四级词汇引擎：录入去重 · 按单元顺序学 · 遮罩背诵 · 五题型考核 · 错题闭环 · 写作阅读联动。零构建零服务器，Capacitor 封 APK。`
  - `Local-first CET-4 vocabulary engine: dedup ingestion, unit-sequenced drills, masked recitation, 5 question types, wrong-answer loop. No build step, no server, ships as an APK.`
- Topics：`english` `vocabulary` `cet-4` `spaced-repetition` `offline-first` `pwa` `capacitor` `android` `localStorage` `flashcards` `language-learning` `no-build`

`README.md` 里的徽标与下载直链已按新名字写好；**没改名之前那三处会显示红标**（构建状态、版本号、`/releases` 链接），
`_tools\check-readme-links.ps1` 会把它们精确报成 3 项失败 —— 改完名再跑一次应当归零。
若最终决定不改名，就把 URL 里的 `noadic` 换回旧名即可。

---

## 5. 版本与发布

```powershell
.\git.ps1 tag -a v1.2 -m "改了啥"
.\git.ps1 push origin v1.2      # 标签必须 v 开头（on.push.tags: ['v*']）
```

CI 会自动出正式 Release；日常 push 则覆盖 `latest-debug` 这个滚动预发布版。撤回一个版本：`.\git.ps1 tag -d v1.2` + 网页删对应 Release（或 API 删 `git/refs/tags/v1.2`）。

> **发版前先在 `CHANGELOG.md` 里写好这一段**：Release 正文是从 `CHANGELOG.md` 抽 `## [<版本>]` 到下一个 `## ` 之间的内容，
> 抽不到就只会剩下构建来源那几行。版本号取自 `package.json`（标签 `v1.2.0` ↔ `## [1.2.0]`）。
> 本地先验：`bash _tools/notes-extract.sh`（含"不存在的版本必须抽不到"的负向对照）。
> 别忘了 `node _tools/bump-lock-version.mjs 1.2.0` —— 锁文件只能动根版本那两处。

---

## 6. 提交前自检（本机跑，不用等 CI）

```powershell
node _tools/test-logic.mjs                                   # 244 项逻辑测试
node _tools/audit-wiring.mjs                                 # JS 语法 + #id 选择器对账
node _tools/xref.mjs                                         # 跨模块引用对账（536 处）
bash _tools/notes-extract.sh                                 # 发布说明抽取（正/负两组）
powershell -ExecutionPolicy Bypass -File _tools\check-workflow.ps1 -SelfTest
                                                             # workflow 结构 + 每个 run 块 bash -n + 6 种破坏必须全被抓
powershell -ExecutionPolicy Bypass -File _tools\check-readme-links.ps1
                                                             # README 链接；徽标读的是 shields 渲染出的 aria-label，不是 HTTP 200
node _tools/device-smoke.mjs --shots                         # 有模拟器/真机时：26 条真实点击断言
node _tools/device-smoke.mjs --selftest                      # 负向对照：假断言必须被判失败
python _tools\apk-peek.py dist\noadic-debug.apk www          # 包内资源与 www/ 逐文件 SHA 对账
```

> 改过任何 `.ps1` 之后先跑 `powershell -ExecutionPolicy Bypass -File _tools\fix-ps1-encoding.ps1 -All`：
> 编辑类工具写文件不带 BOM，Windows PowerShell 5.1 会把中文按 GBK 读成乱码并报"字符串缺少终止符"。
含中文的 `.ps1` **必须 UTF-8 with BOM**，否则 PS 5.1 按 GBK 解析会报"字符串缺少终止符"这类乱码错。编辑脚本后跑一次：

```powershell
powershell -ExecutionPolicy Bypass -File _tools\fix-ps1-encoding.ps1 -All
```

---

## 7. 备选：Gitee

同一代理下 Gitee 也通（`git ls-remote https://gitee.com/mirrors/git.git` 实测成功），国内速度更稳，适合纯备份：

```powershell
.\git.ps1 remote add gitee https://gitee.com/你的用户名/noadic.git
.\git.ps1 push -u gitee main
```

但 Gitee 没有 GitHub Actions，**自动出 APK 这条只在 GitHub 上成立**。
