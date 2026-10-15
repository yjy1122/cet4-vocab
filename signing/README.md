# Android 构建签名

`android-home/debug.keystore` 是**本仓库共用的 debug 签名密钥**，被提交进版本库。

## 为什么必须共用

GitHub Actions 每次都是全新 runner。Gradle 在 `~/.android/debug.keystore` 不存在时会
**静默现生成一个**，然后照常构建成功。后果是：

- 每一个发布出去的 APK 签名都互不相同；
- Android 拒绝跨签名覆盖安装（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）；
- 用户只能**卸载重装**，而词库、学习进度、错题本全在应用本地存储里 —— **数据直接没了**。

实测过三个包的证书指纹：本机构建 `530aec0d…`、CI v1.3.0 `55ef0b26…`、CI v1.3.1 `1edc8e7a…`，
三个全不一样。所以两条构建路线都把 `ANDROID_USER_HOME` 指到这个目录，
Gradle 就会用同一把 key；CI 还在构建后用 `apksigner` 比对指纹，不一致就直接失败
（只配环境变量不够 —— 指错了 Gradle 不会报错，只会换一把 key）。

## 这是 debug 密钥，不是发布密钥

拿到这个文件的人可以构建出能覆盖你 `com.noadic.app` debug 安装的 APK。
本项目只发 debug 包自用，不上传应用商店，所以风险与"任何人都能自己构建一份"是同一量级。
**将来要正式上架时，必须换一把不进版本库的 release 密钥**，并同步改掉 CI 的签名配置。

## 密码

Android SDK 的 debug 密钥约定：store 与 key 密码都是 `android`，别名 `androiddebugkey`。
这是公开的标准值，不是秘密。

## 本目录其余内容不入库

`signing/android-home/` 下还有 sdkmanager 的 `.cache/` 等，那些是构建产物，已在
`.gitignore` 里排除，只提交 `debug.keystore` 本身。
