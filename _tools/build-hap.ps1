<#
  build-hap.ps1 — 鸿蒙 HAP 打包（本机路线）

  和安卓那条路线一样的分工：先把"能不能构建"的前置条件查干净，再交给 hvigor。
  HAP 只能在装了 DevEco Studio / 命令行工具 + 华为开发者账号的机器上出，
  所以这个脚本的失败信息一律写成「缺什么、去哪儿拿、谁去点」，不留天书。

  用法:
    powershell -ExecutionPolicy Bypass -File _tools\build-hap.ps1
    powershell -ExecutionPolicy Bypass -File _tools\build-hap.ps1 -SkipAudit
#>
param([switch]$SkipAudit)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($n, $m) { Write-Host ("[{0}/6] {1}" -f $n, $m) -ForegroundColor Cyan }
function Die($m) { Write-Host "❌ $m" -ForegroundColor Red; exit 1 }

# ---------- 1. 同步 web 资源 ----------
Step 1 "同步 www/ → harmony/entry/src/main/resources/rawfile/"
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'sync-www.ps1')
if ($LASTEXITCODE -ne 0) { Die "sync-www.ps1 失败" }
$rawfile = Join-Path $root 'harmony\entry\src\main\resources\rawfile'
if (-not (Test-Path (Join-Path $rawfile 'index.html'))) { Die "同步后仍没有 rawfile/index.html" }

# ---------- 2. 版本盖章（app.json5 必须跟 package.json 一致） ----------
Step 2 "把 package.json 的版本盖到 AppScope/app.json5"
$ver = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($ver -notmatch '^\d+\.\d+\.\d+$') { Die "package.json 版本号不合法: $ver" }
$p, $mi, $pa = $ver.Split('.')
$code = ([int]$p * 1000000) + ([int]$mi * 1000) + [int]$pa
$appJson = Join-Path $root 'harmony\AppScope\app.json5'
$txt = Get-Content $appJson -Raw -Encoding UTF8
$txt = $txt -replace '"versionName"\s*:\s*"[^"]*"', ('"versionName": "' + $ver + '"')
$txt = $txt -replace '"versionCode"\s*:\s*\d+', ('"versionCode": ' + $code)
# 必须无 BOM：DevEco 读带 BOM 的 json5 会直接解析失败
[IO.File]::WriteAllText($appJson, $txt, (New-Object Text.UTF8Encoding($false)))
Write-Host "     versionName=$ver  versionCode=$code"

# ---------- 3. 静态体检 ----------
if ($SkipAudit) {
  Step 3 "跳过审计（-SkipAudit）"
} else {
  Step 3 "审计鸿蒙工程（rawfile 一致性 / 资源引用 / 身份版本 / 签名材料 / ArkWeb 前提）"
  & node (Join-Path $root '_tools\audit-harmony.mjs') --net
  if ($LASTEXITCODE -ne 0) {
    Die "审计未通过。上面每条失败都写了改法；签名材料那几条属于「换机器必然缺」，见 BUILD-HAP.md 的「关于签名，两条硬约束」一节（按标题引用，不写第几节——加一节就会错位）。"
  }
}

# ---------- 4. 找工具链 ----------
Step 4 "定位 hvigorw"
# 工具链默认往家目录写（~\.hvigor、~\.ohpm、pnpm store）。受限环境下这会 EPERM，
# 而且把几百 MB 缓存留在系统盘也没道理 —— 全部收进工作区 .tooling\。
$t = Join-Path $root '.tooling'
foreach ($kv in @(@('HVIGOR_USER_HOME', 'hvigor-home'), @('OHPM_HOME', 'ohpm-home'),
                  @('PNPM_HOME', 'pnpm-home'), @('npm_config_cache', 'npm-cache'))) {
  $p = Join-Path $t $kv[1]
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  Set-Item -Path "Env:\$($kv[0])" -Value $p
}
Write-Host "     缓存/家目录重定向进 $t（不写 %USERPROFILE%）"
# 真实入口是 command-line-tools\bin\hvigorw.bat（不是 hvigor\bin\hvigorw.js ——
# 上一版按那个找永远找不到，等于这条发现逻辑从来没成立过）。
$sub = @('bin\hvigorw.bat', 'hvigor\bin\hvigorw.js')
$roots = @($env:DEVECO_HOME, $env:COMMANDLINE_TOOLS_HOME,
           (Join-Path $root '.tooling\command-line-tools'),
           'C:\Program Files\Huawei\DevEco Studio\tools', 'D:\Program Files\Huawei\DevEco Studio\tools')
$cands = @((Join-Path $root 'harmony\hvigorw.bat'))
foreach ($r2 in $roots) { if ($r2) { foreach ($s in $sub) { $cands += (Join-Path $r2 $s) } } }
# 再扫盘根与常见下载/工具目录（只找 command-line-tools / DevEco 命名的）
foreach ($drive in @('C:\', 'D:\')) {
  Get-ChildItem $drive -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'command-line-tools|DevEco' } |
    ForEach-Object { foreach ($s in $sub) { $cands += (Join-Path $_.FullName $s) } }
}
$hvigor = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $hvigor) {
  Write-Host @"

这台机器上没有 HarmonyOS 构建工具链。hvigor 只随 DevEco Studio / command-line-tools 分发，
公共 npm、npmmirror、ohpm 源上都拿不到（实测 404），且下载页要求华为开发者账号登录。

拿工具链（任选其一，都需要华为账号）:
  A. DevEco Studio:  https://developer.huawei.com/consumer/cn/deveco-studio/
  B. 命令行工具:      https://developer.huawei.com/consumer/cn/download/  -> command-line-tools
装好后在 IDE 里 File > Project Structure > Signing Configs 勾选 Automatically sign，
登录一次即可生成本机的 .p12/.cer/.p7b（debug profile 会绑定你注册过的设备 UDID）。

生成工具链后重跑本脚本即可继续。
"@ -ForegroundColor Yellow
  Die "找不到 hvigorw"
}
Write-Host "     使用 $hvigor"

# ---------- 5. 构建 ----------
Step 5 "hvigorw assembleHap（debug）"
Push-Location (Join-Path $root 'harmony')
try {
  & $hvigor --mode module -p product=default -p buildMode=debug assembleHap --parallel --incremental --no-daemon
  if ($LASTEXITCODE -ne 0) { Die "hvigorw 退出码 $LASTEXITCODE" }
} finally { Pop-Location }

# ---------- 6. 验产物 ----------
Step 6 "检查产物"
$hap = Get-ChildItem (Join-Path $root 'harmony\entry\build') -Recurse -Filter '*.hap' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $hap) { Die "构建结束但找不到 .hap，检查上面的 hvigor 输出" }
Write-Host ("✅ 产物: {0}  ({1:N1} MB)" -f $hap.FullName, ($hap.Length / 1MB))
Write-Host "   安装: hdc install -r `"$($hap.FullName)`"   （设备 UDID 必须在签名 profile 里）"
