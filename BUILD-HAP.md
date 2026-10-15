# 鸿蒙（HarmonyOS）打包说明

分支：`harmony`。工程在 `harmony/`，是 ArkWeb 套壳：`entry/src/main/ets/pages/Index.ets`
用一个 `Web` 组件加载 `$rawfile('index.html')`，`domStorageAccess(true)` 打开 localStorage。
也就是说 **App 的全部逻辑仍是 `www/` 里那套网页**，鸿蒙侧只有一层壳。

---

## 1. 一句话结论：这台机器出不了包，而且不是配置问题

三条独立探测，每条都可复现：

| 需要 | 实测 | 结论 |
| --- | --- | --- |
| DevEco / command-line-tools | `developer.huawei.com/consumer/cn/download/` → **403**（匿名） | 下载要华为开发者账号登录 |
| `@ohos/hvigor`、`@ohos/hvigor-ohos-plugin` | npmjs / npmmirror / ohpm 公共源 → **404** | hvigor 不公开分发，只随 IDE 走 |
| 签名材料 | `build-profile.json5` 里写死 `C:\Users\HeHao\.ohos\config\*.p12/.cer/.p7b` | 在适配者自己机器上，且口令是 DevEco 按机器加密的 |

顺带排除一条看似可行的路：OpenHarmony 的 `ohos-sdk` 确实能匿名下载（约 2.1 GB），
但本工程 `runtimeOS: "HarmonyOS"`、`compatibleSdkVersion: "6.1.1(24)"`，
OpenHarmony SDK 满足不了；而且拿它编出来的包**装不到华为手机**上——只是把坑换个姿势埋起来。

所以：**打包必须在装了 DevEco + 登录过华为账号的机器上做**。下面两条路线二选一。

---

## 分支协作流程（谁改哪儿、怎么合）

鸿蒙工程已经并进 `main`，但 `harmony` 分支**不退役**，它是鸿蒙侧的修复分支。约定两条：

1. **通用改动一律在 `main` 上做**（网页逻辑、安卓、测试、CI 都在这儿）。
   如果这期间 `harmony` 上有了新提交，在 main 上 `git merge origin/harmony` 一次，然后继续改 main。
2. **如果 main 的新改动让鸿蒙实机出现预期之外的行为**，由 He Haoyang 在 `harmony` 上
   `git merge origin/main`、在鸿蒙侧修好并推 `harmony`；然后我重复第 1 条把它带回 main。

方向是固定的：**新东西只进 main，鸿蒙侧的问题只在 harmony 修**，两边靠"合并"同步，而不是各留一套实现。
这条约定的由来很实在 —— 最近几个提交（页内弹层、AI 超时、探测验生成通道、渲染预算、明文许可）
全是平台无关的改动；而本轮已经踩过三次同一类坑：明文许可和版本盖章**只写进了本机脚本、
没写进 CI**，于是发布包和本机包行为不一样。两份实现迟早分叉，分叉了还不报错。

判断一次改动该落在哪：

| 改动内容 | 落在 |
| --- | --- |
| `www/` 里的任何逻辑（App 的全部功能都在这儿） | `main` |
| 安卓构建、测试脚本、CI | `main` |
| `harmony/` 下的 ArkTS / 清单 / 图标 / 签名 | `harmony` |
| 只有鸿蒙实机才暴露的问题（如 `resource://` 下 localStorage 是否持久） | `harmony` 修，再合回 `main` |

## 2. 路线 A（最快）：由适配者出包

他机器上工具链和证书都是现成的，只需要三步：

```powershell
git pull
powershell -ExecutionPolicy Bypass -File _tools\build-hap.ps1
```

这个脚本按顺序做：同步 `www/` → 把 `package.json` 的版本盖到 `app.json5` → 静态审计 → 找 hvigorw → 构建 → 报告产物。
任何一步不满足都会停下并说清楚缺什么，不会抛 Gradle 式天书。

## 3. 路线 B：自己装工具链

1. 注册华为开发者账号，装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)。
2. 用 IDE 打开 `harmony/` 目录，等它把 SDK / ohpm 依赖装完。
3. `File ▸ Project Structure ▸ Project ▸ Signing Configs` 勾 **Automatically sign in**，登录一次。
   DevEco 会在本机 `~/.ohos/config/` 下生成 `.p12/.cer/.p7b` 并把路径写进 `harmony/build-profile.json5`。
4. 跑 `_tools\build-hap.ps1`（或直接 IDE 里 Build ▸ Build Hap(s)）。

### 关于签名，两条硬约束

- **debug profile 绑定设备 UDID**。别人给你签好的包，装到你的手机上会因"设备不在 profile 里"失败。
  所以要么你的手机 UDID 加进他的 profile，要么你自己按上面第 3 步签一次。
  取 UDID：`hdc shell bm get --udid`（或 `hdc list targets` 后执行）。
- **HarmonyOS NEXT 不开放像安卓那样点文件安装**。个人自用走"开发者模式 + `hdc install`"；
  要给很多人用得走 AGC 的内部测试/上架。

---

## 4. 每次打包前必做的一步

`harmony/entry/src/main/resources/rawfile/` 被 `.gitignore` 排除（不入库），
**不跑 `sync-www.ps1` 就直接构建，会打出一个没有任何页面的空壳。**
`_tools/build-hap.ps1` 已经把这一步放在最前面，并会用 `_tools/audit-harmony.mjs`
逐字节比对 `rawfile/` 与 `www/`（等价于安卓那条 www↔APK 一致性校验）。

手动版：

```powershell
powershell -ExecutionPolicy Bypass -File sync-www.ps1
node _tools\audit-harmony.mjs --net
```

## 5. 审计器查什么（以及它为什么存在）

HAP 一轮编译几十分钟，而报错经常指向 SDK/签名而不是真正的原因。
`_tools/audit-harmony.mjs` 把不需要编译器就能查的部分先查干净：

- `rawfile/` 与 `www/` 是否逐字节一致（缺文件/内容漂移/多余文件分别报数）
- `$string:` / `$media:` / `$color:` / `$profile:` 引用是否都能在资源表里找到（编译期 resource not found 的提前版）
- `bundleName` 是否等于安卓 `appId`、`versionName` 是否等于 `package.json`、应用名是否为 `noadic`
- 签名材料在不在（不在算提示不算失败——换机器必然缺，但不能不吭声）
- `www/js` 里有没有裸用 `confirm/prompt/alert`（见下一节）
- `--net`：`oh-package-lock.json5` 里的 `.har` 地址能否匿名取到

它自己被变异测试验证过：删掉 `rawfile/js/quiz.js` → 报"缺 1"；把 `versionName` 改回 `1.2.1` → 报版本漂移。两条都能抓。

---

## 6. 已经替他修掉的两个坑（在 `www/` 里，随 main 合并进来）

这两条不修，包能编出来但**功能是坏的**，而且坏得没有报错：

1. **ArkWeb 不提供默认 JS 弹框**，且应用侧不接 `onConfirm` 时 `confirm()` **恒返回 `false`**
   （OpenHarmony 文档 `web-dialog.md` 原文）。原来的删除确认、新建单元/课次的输入全走原生弹框，
   打进鸿蒙包后：每一次删除被静默拒绝、每一次新建退回原选项，界面一句错误都不说。
   → 现在改成页内弹层 `#qbox`，两端都成立。安卓真机 26 条断言里的 D20–D24 覆盖它，
   而鸿蒙包里的 `www/` 与安卓包逐字节相同，等于替鸿蒙验过。
2. **`<a download>` 的产物落进应用私有目录**（文档原话"用户无法查看"）
   → 导出备份在鸿蒙下额外把 JSON 摊开在弹窗里给一键复制。

刻意**没有**改他写的 ArkTS：我在这台机器上一行都编译不了，写进去只会把
"功能有缺陷"升级成"构建失败"。如果更想要系统弹框而不是页内弹层，
正确做法是在 `Index.ets` 上补 `.onAlert/.onConfirm/.onPrompt`，样例见
`web-dialog.md`（用 `uiContext.showAlertDialog` 与 `CustomContentDialog`），谁改谁在 DevEco 里编译验证。

## 7. 仍需真机确认（我没有鸿蒙设备，这些查不了）

| 事项 | 为什么要盯 | 怎么验 |
| --- | --- | --- |
| **localStorage 是否跨启动持久** | 学习进度、错题、"背不熟"标记全在这儿。`$rawfile` 的 origin 是 `resource://`，与安卓的 `https://localhost` 不同 | 杀掉 App 重开，看词数与进度是否还在 |
| AI 直连的 CORS | 页在 `resource://` 下发起 fetch，origin 与安卓不同；端点没开 `Access-Control-Allow-Origin` 就会被拦 | 设置里点「测试连接」；不行就用复制粘贴桥 |
| 朗读（`speechSynthesis`） | ArkWeb 未必有 TTS 实现 | 已做能力检测，不支持会提示"可只看音标"，不会报错 |
| `<input type=file>` 导入 | 文档说应用侧不处理时 ArkWeb 有默认行为，但版本差异大 | 点导入选一份 JSON |
| 返回键 / 手势 | 壳里没实现 `onBackPressed` 之类，行为由系统决定 | 按返回看是否直接退出 |
| 状态栏与深色模式 | `EntryAbility` 写死白底黑字，`setColorMode(NOT_SET)` 跟随系统 | 系统开深色后看顶栏是否仍然可读 |

## 8. 版本对应

`harmony/AppScope/app.json5` 的 `versionName` 由 `_tools/build-hap.ps1` 从 `package.json` 盖章，
不要手改（改了一定漂）。`harmony/CHANGELOG.md` 是适配者自己的记录，
项目统一的更新日志在仓库根的 [`CHANGELOG.md`](CHANGELOG.md)。
