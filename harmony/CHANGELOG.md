# ChangeLog

鸿蒙侧的适配记录。项目统一的更新日志在仓库根的 [`CHANGELOG.md`](../CHANGELOG.md)——
网页功能（也就是 App 的全部逻辑）都记在那边，这里只记壳与打包相关的变化。

## HarmonyOS v1.2.0 (Noadic v1.3.1)

- 同步 main 的修复：**「测试连接」现在会真打一次生成通道**（旧版只看 `GET /models`，
  于是"连通 ✅"能骗人——DeepSeek 就是 `/models` 通、chat 被跨域拦死）；
  端点把错误塞进 200 body 时会抛出真实原因而不是"没有 message.content"。
- **词库渲染预算**：3000 词整表重建从 197ms 降到 21ms，且不再随词数增长。
  鸿蒙包里打的就是同一份 `www/`，所以安卓真机验过的优化在这里同样生效。
- `versionCode/versionName` 由 `_tools/build-hap.ps1` 从 `package.json` 盖章（1003001 / 1.3.1）。
- 新增 `_tools/audit-harmony.mjs`：rawfile 与 www/ 逐字节比对、资源引用解析、身份版本、
  签名材料、有没有裸用 `confirm/prompt/alert`。构建前先跑它。

## HarmonyOS v1.1.0 (Noadic v1.3.0)

- 修改桌面图标、启动图标为 `Noadic不止词典`（何昊阳）。
- 删除确认、新建单元/课次的输入改为页内弹层。
  **更正归属**：这条不是 v1.1.0 那次提交做的——那次只改了三个 PNG。
  页内弹层是 main 上的 `4f126e8`，随 `Merge origin/main` 一起进来的。
  改的原因见根 CHANGELOG：ArkWeb 不提供默认 JS 弹框，不接 `onConfirm` 时
  `confirm()` 恒返回 `false`，照原写法打进鸿蒙包会让每一次删除静默失败。

## HarmonyOS v1.0.0 (Noadic v1.2.1)

feat: Noadic初步适配鸿蒙系统
