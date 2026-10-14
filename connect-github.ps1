<#
  连接 GitHub：配代理与证书 → 存 token → 建 remote → 推送 main。
  用法：
      .\connect-github.ps1 -Repo 你的用户名/仓库名
  token 从环境变量 GH_TOKEN 读，或运行时提示输入（不回显）。
  token 只写进 .tooling\git-credentials（已被 .gitignore 排除），不会进仓库。
#>
param(
  [string]$Repo,
  [string]$Branch = "main",
  [switch]$SkipPush
)
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$g = Join-Path $root ".tooling\git\cmd\git.exe"
if (-not (Test-Path -LiteralPath $g)) { Write-Host "❌ 没找到便携版 git，先跑 _tools\install-git.ps1" -ForegroundColor Red; exit 1 }

function Test-Port($h, $p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { return ($c.ConnectAsync($h, $p).Wait(2000) -and $c.Connected) } catch { return $false } finally { $c.Close() }
}

# ---------- 1. 代理 ----------
$proxyPort = 10808
$proxy = "http://127.0.0.1:$proxyPort"
if (Test-Port "127.0.0.1" $proxyPort) {
  Write-Host "✅ 本地代理在线 $proxy" -ForegroundColor Green
  & $g -C $root config --local http.proxy $proxy
} else {
  Write-Host "⚠ 本地代理 127.0.0.1:$proxyPort 没在监听 —— 这台机器直连 github.com:443 是被拒的。" -ForegroundColor Yellow
  Write-Host "  请先打开你的代理客户端（Clash/V2Ray 等），或告诉我它监听在别的端口。" -ForegroundColor Yellow
  $ans = Read-Host "仍然尝试推送？(y/N)"
  if ($ans -ne "y") { exit 1 }
}

# ---------- 2. 证书（CA 路径含中文会被毁码，走 ASCII 联接路径） ----------
$ca = Join-Path $root ".tooling\git\ucrt64\etc\ssl\certs\ca-bundle.crt"
if (Test-Path -LiteralPath $ca) {
  $ascii = $ca.Replace($root, "D:\cet4-build") -replace '\\', '/'
  if (-not (Test-Path -LiteralPath $ascii)) { $ascii = $ca -replace '\\', '/' }
  & $g -C $root config --local http.sslBackend openssl
  & $g -C $root config --local http.sslCAInfo $ascii
}

# ---------- 3. 凭据 ----------
$credFile = ($root -replace '\\', '/') + "/.tooling/git-credentials"
& $g -C $root config --local credential.helper "store --file=$credFile"
& $g -C $root config --local "credential.https://github.com.helper" ""

if (-not $Repo -or $Repo -notmatch '^[\w\.-]+/[\w\.-]+$') {
  Write-Host "用法：.\connect-github.ps1 -Repo 用户名/仓库名" -ForegroundColor Yellow
  exit 1
}
$user = $Repo.Split("/")[0]
$token = $env:GH_TOKEN
if (-not $token) {
  Write-Host "粘贴 GitHub token（Fine-grained 只需 Contents:Read+Write；经典 token 勾 repo 范围）。输入不回显。" -ForegroundColor Cyan
  $secure = Read-Host "token" -AsSecureString
  $token = [System.Net.NetworkCredential]::new("", $secure).Password
}
if (-not $token) { Write-Host "❌ 没有 token" -ForegroundColor Red; exit 1 }

Write-Host "保存凭据到 .tooling\git-credentials（不入库）…" -ForegroundColor Cyan
$inp = "https://$user`:$token@github.com`n"
$inp | & $g -C $root credential approve
Start-Sleep -Milliseconds 300
if (Test-Path -LiteralPath ($credFile -replace '/', '\')) { Write-Host "✅ 已保存" -ForegroundColor Green } else { Write-Host "⚠ 凭据文件未生成，推送时会再问一次" -ForegroundColor Yellow }

# ---------- 4. remote + push ----------
$url = "https://github.com/$Repo.git"
$has = (& $g -C $root remote get-url origin) 2>$null
if ($has) { & $g -C $root remote set-url origin $url; Write-Host "remote origin 已更新 → $url" }
else { & $g -C $root remote add origin $url; Write-Host "已添加 remote origin → $url" }

if ($SkipPush) { Write-Host "已跳过推送"; exit 0 }

Write-Host "推送 $Branch …" -ForegroundColor Cyan
& $g -C $root push -u origin $Branch 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -eq 0) {
  Write-Host "✅ 推送成功" -ForegroundColor Green
  Write-Host "   仓库：  $url"
  Write-Host "   自动构建：$url/actions        （Actions 跑完在 Artifacts 下载 app-debug.apk）"
} else {
  Write-Host "❌ 推送失败（退出码 $LASTEXITCODE）。常见原因：" -ForegroundColor Red
  Write-Host "   1) 仓库还没在 GitHub 网页上创建（git 不能替你建空仓库）"
  Write-Host "   2) token 权限不够或已过期（Fine-grained 要选中这个仓库 + Contents: Write）"
  Write-Host "   3) 代理掉线：先确认 127.0.0.1:10808 在监听"
  Write-Host "   4) 远端已有提交历史：先 .\git.ps1 pull origin main --rebase 或改用 --force（会覆盖远端，慎用）"
}
