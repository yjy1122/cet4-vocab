#requires -Version 5
<#
  一键构建 Android APK（本机路线）。
  缺依赖时会明确告诉你缺什么、怎么装。不想装工具链 → 用云构建，见 BUILD-APK.md。
#>
param(
  [switch]$Release,          # 出 release 未签名包
  [switch]$SkipInstall       # 跳过 npm install
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Fail($what, $fix) {
  Write-Host "`n❌ $what" -ForegroundColor Red
  Write-Host "   怎么办：$fix" -ForegroundColor Yellow
  exit 1
}

Write-Host "== 1/6 检查工具链 ==" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "没有 Node.js" "winget install OpenJS.NodeJS.LTS 然后重开终端" }

$javac = Get-Command javac -ErrorAction SilentlyContinue
if (-not $javac) { Fail "没有 javac（只有 JRE 不够，需要 JDK）" "winget install EclipseAdoptium.Temurin.17.JDK 然后重开终端" }
$jv = (& javac -version 2>&1) -join " "
if ($jv -notmatch '(1[7-9]|2[0-9])\.') { Fail "JDK 版本过低：$jv" "Capacitor + Gradle 需要 JDK 17 或 21" }

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) {
  $cand = @("$env:LOCALAPPDATA\Android\Sdk", "C:\Android\Sdk", "D:\Android\Sdk") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($cand) { $sdk = $cand }
}
if (-not $sdk) { Fail "没有 Android SDK（ANDROID_HOME 未设置）" "装 Android Studio：winget install Google.AndroidStudio ，或只装命令行 SDK，然后设置 ANDROID_HOME" }
if (-not (Test-Path -LiteralPath (Join-Path $sdk "platform-tools"))) { Fail "Android SDK 不完整" "用 sdkmanager 安装：platform-tools、platforms;android-34、build-tools;34.0.0" }

Write-Host "   ✔ Node $(node -v)"
Write-Host "   ✔ $jv"
Write-Host "   ✔ Android SDK: $sdk"

if (-not $SkipInstall) {
  Write-Host "`n== 2/6 安装 npm 依赖 ==" -ForegroundColor Cyan
  npm install --no-audit --no-fund
} else {
  Write-Host "`n== 2/6 跳过 npm install ==" -ForegroundColor DarkGray
}

Write-Host "`n== 3/6 生成 / 同步 Android 工程 ==" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $root "android"))) {
  npx --yes cap add android
}
npx --yes cap sync android

if (Test-Path -LiteralPath (Join-Path $root "assets\icon.png")) {
  Write-Host "`n== 4/6 生成图标与开屏图 ==" -ForegroundColor Cyan
  # 包名是 @capacitor/assets（不是 capacitor-assets，那个装不上），最新版 3.0.5，没有 v6。
  # 引号不能省：PowerShell 里开头的 @ 是 splatting 语法。
  # 图标生成失败不该拖垮整个出包 —— 最坏情况用 Capacitor 默认图标，与 CI 的 continue-on-error 一致。
  try { npx --yes "@capacitor/assets@3" generate --android }
  catch { Write-Host "   ⚠ 图标生成失败，本次改用 Capacitor 默认图标：$($_.Exception.Message)" -ForegroundColor Yellow }
}

Write-Host "`n== 5/6 把 package.json 的版本写进 Android versionName ==" -ForegroundColor Cyan
# Capacitor 的 android 模板把 versionName 硬编码成 "1.0"，cap add / cap sync 都不会用
# package.json 覆盖它（实测：package.json 1.1.0，aapt dump 出来仍是 versionName='1.0'）。
# 云构建里有这一步，本机原来没有 —— 于是同一条 commit 会出两个版本号不一致的包。
$grad = Join-Path $root "android\app\build.gradle"
$ver = (& node -p "require('./package.json').version")
if (-not (Test-Path -LiteralPath $grad)) { Fail "找不到 $grad" "先跑 npm install && npx cap add android" }
$g = [System.IO.File]::ReadAllText($grad)
if ($g -notmatch 'versionName "') { Fail "build.gradle 里没有 versionName，模板变了" "对照 .github/workflows/android.yml 里的同名步骤调整" }
$g2 = $g -replace 'versionName ".*"', ('versionName "' + $ver + '"')
if ($g2 -ne $g) {
  # 不用 Set-Content -Encoding UTF8：PS 5.1 会写 BOM，Gradle 读带 BOM 的 groovy 脚本会翻脸
  [System.IO.File]::WriteAllText($grad, $g2, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host "   ✔ versionName -> $ver"

Write-Host "`n== 6/6 Gradle 编译 ==" -ForegroundColor Cyan
Push-Location (Join-Path $root "android")
try {
  $task = if ($Release) { "assembleRelease" } else { "assembleDebug" }
  .\gradlew.bat $task --no-daemon
} finally { Pop-Location }

$variant = if ($Release) { "release" } else { "debug" }
$apkDir = Join-Path $root "android\app\build\outputs\apk\$variant"
$apk = Get-ChildItem -LiteralPath $apkDir -Filter *.apk -ErrorAction SilentlyContinue | Select-Object -First 1
if ($apk) {
  Write-Host "`n✅ APK 已生成" -ForegroundColor Green
  Write-Host ("   {0}  （{1:N1} MB）" -f $apk.FullName, ($apk.Length / 1MB))
  Write-Host "   传到手机装上即可（debug 包无需签名）。"
} else {
  Write-Host "`n⚠ 编译结束但没找到 APK，请看上面的 Gradle 输出" -ForegroundColor Yellow
}
