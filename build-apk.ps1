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

Write-Host "== 1/5 检查工具链 ==" -ForegroundColor Cyan
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
  Write-Host "`n== 2/5 安装 npm 依赖 ==" -ForegroundColor Cyan
  npm install --no-audit --no-fund
} else {
  Write-Host "`n== 2/5 跳过 npm install ==" -ForegroundColor DarkGray
}

Write-Host "`n== 3/5 生成 / 同步 Android 工程 ==" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $root "android"))) {
  npx --yes cap add android
}
npx --yes cap sync android

if (Test-Path -LiteralPath (Join-Path $root "assets\icon.png")) {
  Write-Host "`n== 4/5 生成图标与开屏图 ==" -ForegroundColor Cyan
  npx --yes capacitor-assets generate --android --iconPath assets/icon.png --splashPath assets/splash.png
}

Write-Host "`n== 5/5 Gradle 编译 ==" -ForegroundColor Cyan
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
