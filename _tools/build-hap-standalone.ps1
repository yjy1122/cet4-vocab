<#
  build-hap-standalone.ps1 — 在【普通终端】里跑，产出一个 .hap

  为什么需要它（而不是在 agent 会话里直接构建）：两条硬约束互斥
    1) hvigor 要求工程路径纯 ASCII。它用 Windows 最终路径名解析，
       subst 盘符和 junction 都会被还原成真实目录名（这里工作区目录名是中文）。
    2) agent 的文件沙箱只允许子进程写工作区内，node 在工作区外建目录直接 EPERM。
  所以把工程复制到 ASCII 目录 + 在非沙箱终端里跑，两个约束同时满足。

  用法（重要：在普通的 PowerShell 窗口里跑，不是在 agent 会话里）：
    cd D:\Users\DawnFish\Desktop\新建文件夹
    powershell -ExecutionPolicy Bypass -File _tools\build-hap-standalone.ps1

  加 -Signed 表示"用我本机 DevEco 生成的证书签名"（需要先配好 signingConfigs）。
  默认产出的是**未签名** .hap：结构真实，但装不到手机上（见结尾说明）。
#>
param([switch]$Signed, [string]$Work = 'D:\noadic-hap-build', [string]$Tools = '')
$ErrorActionPreference = 'Stop'
# 本脚本在 _tools\ 里，所以只要剥一层。上一版剥了两层，$root 变成 Desktop，
# 于是 .tooling\command-line-tools 永远找不到 —— 而且报错还是空的（见下面）。
$root = Split-Path -Parent $PSScriptRoot

function Step($n, $m) { Write-Host ("[{0}] {1}" -f $n, $m) -ForegroundColor Cyan }
function Die($m) { Write-Host "❌ $m" -ForegroundColor Red; exit 1 }

# ---------- 1. 工具链 ----------
Step 1 "定位 HarmonyOS 工具链"
# 候选列表要先存成变量再打印。上一版在消息里写 $tc（此时它已经是空），
# 于是用户只看到"已试过："后面什么都没有 —— 一个查不出原因的报错等于没有报错。
$cands = @()
if ($Tools) { $cands += $Tools }
$cands += @($env:COMMANDLINE_TOOLS_HOME, $env:DEVECO_HOME,
            (Join-Path $root '.tooling\command-line-tools'),
            'D:\noadic-hap-build\command-line-tools',
            'C:\command-line-tools', 'D:\command-line-tools',
            'C:\Program Files\Huawei\DevEco Studio\tools',
            'D:\Program Files\Huawei\DevEco Studio\tools')
# 再扫两个盘的根目录，找名字里带 command-line-tools / DevEco 的
foreach ($drv in @('C:\', 'D:\')) {
  Get-ChildItem $drv -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'command-line-tools|DevEco' } |
    ForEach-Object { $cands += $_.FullName }
}
$cands = $cands | Where-Object { $_ } | Select-Object -Unique
$tc = $cands | Where-Object { Test-Path (Join-Path $_ 'bin\hvigorw.bat') } | Select-Object -First 1
if (-not $tc) {
  Write-Host "找不到 command-line-tools（判据：bin\hvigorw.bat 存在）。已试过这些位置：" -ForegroundColor Red
  foreach ($c in $cands) {
    $has = Test-Path (Join-Path $c 'bin\hvigorw.bat')
    $tag = if ($has) { '有 hvigorw' } else { '无' }
    Write-Host ("    {0}  [{1}]" -f $c, $tag)
  }
  Die "把工具链目录用参数传进来即可：-Tools D:\path\to\command-line-tools`n     （解压 zip 后的顶层目录名是 command-line-tools，要指到它，不是指到 bin）"
}
$hvigor = Join-Path $tc 'bin\hvigorw.bat'
$ohpm = Join-Path $tc 'bin\ohpm.bat'
$nodeDir = Join-Path $tc 'tool\node'
Write-Host "     工具链: $tc"

# ---------- 2. 复制到纯 ASCII 工作目录 ----------
Step 2 "复制工程到纯 ASCII 目录 $Work"
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Work | Out-Null
Copy-Item (Join-Path $root 'harmony') (Join-Path $Work 'harmony') -Recurse -Force
Copy-Item (Join-Path $root 'www') (Join-Path $Work 'www') -Recurse -Force
Copy-Item (Join-Path $root 'package.json'), (Join-Path $root 'capacitor.config.json') $Work -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Work '_tools') | Out-Null
Copy-Item (Join-Path $root '_tools\sync-www.mjs') (Join-Path $Work '_tools') -Force

# 把工具链接过去（同盘用 junction 省 7.5GB；跨盘会自动退回复制）
try { New-Item -ItemType Junction -Path (Join-Path $Work 'clt') -Target $tc -ErrorAction Stop | Out-Null; $tcUse = Join-Path $Work 'clt' }
catch { Write-Host "     junction 失败，直接用原工具链路径"; $tcUse = $tc }

# ---------- 3. 同步网页资源（rawfile 不入库，不同步就是空壳） ----------
Step 3 "同步 www/ -> rawfile/"
& (Join-Path $nodeDir 'node.exe') (Join-Path $Work '_tools\sync-www.mjs')
if ($LASTEXITCODE -ne 0) { Die "sync-www 失败" }
Test-Path (Join-Path $Work 'harmony\entry\src\main\resources\rawfile\index.html') |
  Where-Object { -not $_ } | ForEach-Object { Die "同步后仍没有 rawfile/index.html" }

# ---------- 4. 缓存重定向到 ASCII 目录 ----------
foreach ($kv in @(@('HVIGOR_USER_HOME', 'hvigor-home'), @('OHPM_HOME', 'ohpm-home'),
                  @('PNPM_HOME', 'pnpm-home'), @('npm_config_cache', 'npm-cache'))) {
  $p = Join-Path $Work $kv[1]; New-Item -ItemType Directory -Force -Path $p | Out-Null
  Set-Item "Env:\$($kv[0])" $p
}
$env:Path = "$nodeDir;$env:Path"
$env:TEMP = Join-Path $Work 'tmp'; New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

# ---------- 5. ohpm 装依赖 ----------
Step 4 "ohpm install"
Push-Location (Join-Path $Work 'harmony')
try {
  & $ohpm install --all 2>&1 | Select-Object -Last 6
  if ($LASTEXITCODE -ne 0) { Die "ohpm install 失败" }
} finally { Pop-Location }

# ---------- 6. 签名处理 ----------
$prof = Join-Path $Work 'harmony\build-profile.json5'
$txt = Get-Content $prof -Raw
if (-not $Signed) {
  Step 5 "去掉 signingConfigs 以产出未签名包（证书在别人机器上，本机没有）"
  # 只改副本，不动仓库里那份
  $new = $txt -replace '"signingConfigs":\s*\[[\s\S]*?\n    \]', '"signingConfigs": []'
  $new = $new -replace '"signingConfig":\s*"default",\s*', ''
  if ($new -eq $txt) { Write-Host "     没匹配到 signingConfigs 块，保持原样" -ForegroundColor Yellow }
  [IO.File]::WriteAllText($prof, $new, (New-Object Text.UTF8Encoding($false)))
} else {
  Step 5 "使用现有 signingConfigs（须是本机 DevEco 生成的证书）"
  if ($txt -match 'C:\\Users\\HeHao') { Die "build-profile.json5 里还是别人机器的绝对路径，先在 DevEco 里重新勾选 Automatically sign in" }
}

# ---------- 7. 构建 ----------
Step 6 "hvigorw assembleHap"
Push-Location (Join-Path $Work 'harmony')
try {
  & $hvigor --mode module -p product=default -p buildMode=debug assembleHap --no-daemon 2>&1 |
    Select-Object -Last 25
  $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -ne 0) { Die "hvigorw 退出码 $code（上面有原始报错）" }

# ---------- 8. 取回产物 ----------
$hap = Get-ChildItem (Join-Path $Work 'harmony\entry\build') -Recurse -Filter '*.hap' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $hap) { Die "构建说成功了但找不到 .hap —— 不要相信这种'成功'" }
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$dst = Join-Path $out ("noadic-" + (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version + $(if ($Signed) { '' } else { '-unsigned' }) + ".hap")
Copy-Item $hap.FullName $dst -Force
Write-Host ""
Write-Host ("✅ 产物: {0}  ({1:N1} MB)" -f $dst, ($hap.Length / 1MB)) -ForegroundColor Green
if (-not $Signed) {
  Write-Host @"

这是【未签名】包：结构是真的 .hap，但 HarmonyOS 不会允许安装。
要能装，必须二选一：
  A. 在 DevEco 里 File > Project Structure > Signing Configs 勾 Automatically sign in
     （登录华为开发者账号，且这台手机的 UDID 已注册进 debug profile），
     然后重跑本脚本并加 -Signed。
  B. 让 He Haoyang 用他的证书签（他的 profile 只含他注册过的设备）。
"@ -ForegroundColor Yellow
}
Write-Host "上传到 Release：gh release upload <tag> $dst --clobber"
