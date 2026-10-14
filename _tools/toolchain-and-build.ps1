<#
  本机 APK 构建：JDK 17 + Android SDK 全部装进工作区 .tooling\，不写系统目录、不要管理员。
  可重复执行（已装好的步骤会自动跳过）。日志：.tooling\build.log
#>
$ErrorActionPreference = "Continue"
$root = "D:\Users\DawnFish\Desktop\新建文件夹"
$t = Join-Path $root ".tooling"
$sdk = Join-Path $t "android-sdk"
$jdk = Join-Path $t "jdk17"
$gradleHome = Join-Path $t "gradle"
$py = "C:\Users\DawnFish\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
New-Item -ItemType Directory -Force -Path $t, $gradleHome | Out-Null
$log = Join-Path $t "build.log"

# 关键：把所有"写到家目录"的缓存都拽进工作区。
# sdkmanager 下载成功但写不进 %USERPROFILE%\.android\cache 时，会伪装成
# "IO exception while downloading manifest / Failed to download any source lists"，极易被误判成网络问题。
$env:ANDROID_USER_HOME = Join-Path $t ".android"
$env:GRADLE_USER_HOME = $gradleHome
$env:npm_config_cache = Join-Path $t "npm-cache"
New-Item -ItemType Directory -Force -Path $env:ANDROID_USER_HOME, $env:npm_config_cache | Out-Null

function Log($m) {
  $line = "{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Host $line
}
function Die($m) { Log "❌ $m"; exit 1 }

Log "===== 开始：本机 APK 构建 ====="

# ---------- 1. JDK 17 ----------
if (-not (Test-Path -LiteralPath (Join-Path $jdk "bin\javac.exe"))) {
  Log "[1/7] 下载 Temurin JDK 17（约 182 MB）"
  $zip = Join-Path $t "jdk.zip"
  try {
    Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk" `
      -OutFile $zip -UseBasicParsing -MaximumRedirection 10 -TimeoutSec 1800
  } catch { Die "JDK 下载失败：$($_.Exception.Message)" }
  Log "      解压 JDK"
  $tmp = Join-Path $t "jdkx"
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  Remove-Item -LiteralPath $jdk -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $inner.FullName -Destination $jdk
  Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
} else { Log "[1/7] JDK 已就绪，跳过" }
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
Log "      $((& javac -version 2>&1) -join ' ')"

# ---------- 2. Android command-line tools ----------
$clt = Join-Path $sdk "cmdline-tools\latest"
if (-not (Test-Path -LiteralPath (Join-Path $clt "bin\sdkmanager.bat"))) {
  Log "[2/7] 下载 Android command-line tools（约 147 MB）"
  $z2 = Join-Path $t "clt.zip"
  try {
    Invoke-WebRequest -Uri "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" `
      -OutFile $z2 -UseBasicParsing -TimeoutSec 1800
  } catch { Die "cmdline-tools 下载失败：$($_.Exception.Message)" }
  $tmp2 = Join-Path $t "cltx"
  Remove-Item -LiteralPath $tmp2 -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $z2 -DestinationPath $tmp2 -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk "cmdline-tools") | Out-Null
  Remove-Item -LiteralPath $clt -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath (Join-Path $tmp2 "cmdline-tools") -Destination $clt -Force
  Remove-Item -LiteralPath $z2, $tmp2 -Recurse -Force -ErrorAction SilentlyContinue
} else { Log "[2/7] cmdline-tools 已就绪，跳过" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# ---------- 3. SDK 组件 ----------
$sdkmgr = Join-Path $clt "bin\sdkmanager.bat"
Log "[3/7] 接受 SDK 许可协议"
("y`n" * 80) | & $sdkmgr --licenses --sdk_root=$sdk 2>&1 | Out-Null
Log "      安装 platform-tools / platforms;android-34 / build-tools;34.0.0（约 700 MB，静默）"
& $sdkmgr --sdk_root=$sdk "platform-tools" "platforms;android-34" "build-tools;34.0.0" 2>&1 |
  ForEach-Object { if ("$_" -match "^\[|=|Warning|Error|failed") { "$_" | Add-Content -LiteralPath $log -Encoding UTF8 } }
if (-not (Test-Path -LiteralPath (Join-Path $sdk "platforms\android-34\android.jar"))) { Die "android-34 平台未装上，见 $log" }
Log "      ✔ SDK 组件就位"

# ---------- 4. npm 依赖 ----------
Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath "node_modules\@capacitor\cli")) {
  Log "[4/7] npm install（Capacitor CLI/Android）"
  npm install --no-audit --no-fund --loglevel=error 2>&1 | ForEach-Object { "$_" | Add-Content -LiteralPath $log -Encoding UTF8 }
  if (-not (Test-Path -LiteralPath "node_modules\@capacitor\cli")) { Die "npm install 失败，见 $log" }
} else { Log "[4/7] node_modules 已存在，跳过" }

# ---------- 5. Capacitor 工程 ----------
if (-not (Test-Path -LiteralPath "android")) {
  Log "[5/7] npx cap add android"
  npx --yes cap add android 2>&1 | ForEach-Object { "$_" | Add-Content -LiteralPath $log -Encoding UTF8; Write-Host "      $_" }
  if (-not (Test-Path -LiteralPath "android")) { Die "cap add android 失败，见 $log" }
} else { Log "[5/7] android/ 已存在" }
"sdk.dir=$($sdk -replace '\\','/')" | Set-Content -LiteralPath (Join-Path $root "android\local.properties") -Encoding ASCII
Log "      npx cap sync android"
npx --yes cap sync android 2>&1 | ForEach-Object { "$_" | Add-Content -LiteralPath $log -Encoding UTF8 }

# ---------- 6. 图标 / 开屏（Pillow 直写 res，避开需要 GitHub 下载的 sharp） ----------
Log "[6/7] 用 Pillow 写入图标与开屏图到 android/app/src/main/res"
& $py (Join-Path $root "_tools\android-res.py") 2>&1 | ForEach-Object { "$_" | Add-Content -LiteralPath $log -Encoding UTF8; Write-Host "      $_" }

# ---------- 7. Gradle（本地发行版，绕开 wrapper 的 Java 下载） ----------
# 说明：gradlew 会用 Java 去 services.gradle.org 拉 -all 包，这台机器上那条 Java 路径不通；
# 而 Invoke-WebRequest 直连同地址 200。所以自己下 -bin 包解压后直接调 gradle.bat，结果等价。
$gv = "8.2.1"
$gdir = Join-Path $t "gradle-dist\gradle-$gv"
if (-not (Test-Path -LiteralPath (Join-Path $gdir "bin\gradle.bat"))) {
  Log "[7/7] 下载 Gradle $gv 发行版（约 123 MB）"
  $gz = Join-Path $t "gradle.zip"
  try {
    Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$gv-bin.zip" -OutFile $gz -UseBasicParsing -TimeoutSec 3600
  } catch { Die "Gradle 下载失败：$($_.Exception.Message)" }
  Expand-Archive -LiteralPath $gz -DestinationPath (Join-Path $t "gradle-dist") -Force
  Remove-Item -LiteralPath $gz -Force -ErrorAction SilentlyContinue
} else { Log "[7/7] Gradle $gv 已就绪" }
if (-not (Test-Path -LiteralPath (Join-Path $gdir "bin\gradle.bat"))) { Die "Gradle 解压后找不到 gradle.bat" }

Log "      assembleDebug（首次要拉 AGP / AndroidX，耐心等）"
# AGP 拒绝含非 ASCII 的 Windows 工程路径（目录名"新建文件夹"）。
# 用目录联接换一条纯 ASCII 路径来构建：不改名、不搬文件，删掉联接即无痕。
$link = "D:\cet4-build"
if (-not (Test-Path -LiteralPath $link)) {
  Log "      创建 ASCII 目录联接 $link -> $root"
  cmd /c mklink /J "$link" "$root" | Out-Null
}
if (-not (Test-Path -LiteralPath (Join-Path $link "android"))) { Die "目录联接创建失败，无法绕开非 ASCII 路径限制" }
$gp = Join-Path $link "android\gradle.properties"
$gpc = [System.IO.File]::ReadAllText($gp)
# AGP 的资源合并会往 %TEMP% 写工作文件，本机系统临时目录被拒（AccessDeniedException），
# 因此把 TMP/TEMP 与 java.io.tmpdir 一并重定向进工作区。
# 注意：gradle.properties 由 Java 按 ISO-8859-1 读取，中文路径会被毁码，
# 所以临时目录必须走 ASCII 的联接路径（$link），而不是 $root 下的真实路径。
$tmp = Join-Path $link ".tooling\tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TMP = $tmp; $env:TEMP = $tmp
$tmpFwd = ($tmp -replace '\\', '/')
if ($gpc -match "(?m)^org\.gradle\.jvmargs=") {
  $gpc = [regex]::Replace($gpc, "(?m)^org\.gradle\.jvmargs=.*$", "org.gradle.jvmargs=-Xmx2048m -Djava.io.tmpdir=$tmpFwd")
} else {
  $gpc = $gpc + "`norg.gradle.jvmargs=-Xmx2048m -Djava.io.tmpdir=$tmpFwd`n"
}
if ($gpc -notmatch "android.overridePathCheck") { $gpc = $gpc + "`nandroid.overridePathCheck=true`n" }
[System.IO.File]::WriteAllText($gp, $gpc, [System.Text.UTF8Encoding]::new($false))
Log "      TMP/TEMP → $tmp"
Push-Location -LiteralPath (Join-Path $link "android")
& (Join-Path $gdir "bin\gradle.bat") assembleDebug --no-daemon --console=plain 2>&1 | ForEach-Object {
  "$_" | Add-Content -LiteralPath $log -Encoding UTF8
  if ("$_" -match "BUILD |FAILURE|error:|warning:|Task :app") { Write-Host "      $_" }
}
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Die "Gradle 构建失败 exit=$code，见 $log" }

$apk = Get-ChildItem -LiteralPath (Join-Path $root "android\app\build\outputs\apk\debug") -Filter *.apk | Select-Object -First 1
if (-not $apk) { Die "找不到 APK 产物" }
New-Item -ItemType Directory -Force -Path (Join-Path $root "dist") | Out-Null
$dst = Join-Path $root "dist\cet4-vocab-debug.apk"
Copy-Item -LiteralPath $apk.FullName -Destination $dst -Force
Log ("✅ 完成：{0}  （{1:N1} MB）" -f $dst, ((Get-Item $dst).Length / 1MB))
Log "   传到手机点击安装即可（debug 包，自签，无需上架）"
