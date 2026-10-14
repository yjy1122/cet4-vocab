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

# ---------- 3.5 推送前权限预检（--dry-run 会走完鉴权，但不改远端） ----------
# 血泪教训：Fine-grained token 即使能 ls-remote，也可能没有 Contents 写权限；
# 公开仓库的"读得到"完全不能证明 token 有权。dry-run 是唯一无副作用的判定。
Write-Host "预检：push --dry-run（只鉴权，不写入）…" -ForegroundColor Cyan
$dry = (& $g -C $root push --dry-run --porcelain origin $Branch 2>&1 | Out-String)
if ($dry -match '(?i)denied|403') {
  Write-Host "❌ 鉴权通过但没有写权限 —— token 的 Contents 范围不够，与网络无关。" -ForegroundColor Red
  Write-Host "   去 GitHub 改 token（不用重建仓库）：" -ForegroundColor Yellow
  Write-Host "   Settings → Developer settings → Fine-grained tokens → 这个 token → Edit"
  Write-Host "     1) Repository access 选 'Only select repositories'，把 $Repo 加进去"
  Write-Host "        （或者直接改成 'All repositories'，最省事）"
  Write-Host "     2) Repository permissions → Contents → 选 'Read and write'"
  Write-Host "     3) 保存后重新跑本脚本（token 会被新值覆盖）"
  Write-Host "   嫌 Fine-grained 麻烦就用经典 token：Personal access tokens → Tokens (classic)，勾 repo 范围即可。" -ForegroundColor Yellow
  exit 2
}
if ($dry -match '(?i)404|not found|Repository not found') {
  Write-Host "❌ 远端找不到仓库 $Repo：确认名字拼对、确实已创建，且 token 被授权访问它。" -ForegroundColor Red
  exit 2
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "⚠ 预检未通过（不一定是权限问题），完整输出：" -ForegroundColor Yellow
  Write-Host $dry
  $ans = Read-Host "仍要继续真实推送？(y/N)"
  if ($ans -ne "y") { exit 2 }
} else {
  Write-Host "✅ 预检通过，远端可写" -ForegroundColor Green
}

Write-Host "推送 $Branch …" -ForegroundColor Cyan
$pushLog = (& $g -C $root push -u origin $Branch 2>&1 | Out-String) -replace 'github_pat_[A-Za-z0-9_]+', '<TOKEN>'
Write-Host $pushLog
if ($LASTEXITCODE -eq 0) {
  Write-Host "✅ 推送成功" -ForegroundColor Green
  Write-Host "   仓库：  $url"
  Write-Host "   自动构建：$url/actions        （Actions 跑完在 Artifacts 下载 app-debug.apk）"
  exit 0
}

# ---------- 5. 失败分类 ----------
# dry-run 过不了 = 权限或网络；dry-run 过了但正式推送被 remote rejected，
# 基本是 GitHub 服务端推送策略（workflow 范围、邮箱校验、分支保护）。
if ($pushLog -match '(?i)without .workflow. scope|refusing to allow a Personal Access Token') {
  Write-Host "❌ 缺 workflow 范围：仓库里有 .github/workflows/*.yml，GitHub 要求 token 明确授权才能写。" -ForegroundColor Red
  Write-Host "   Fine-grained token → Edit → Repository permissions → 搜 'Workflows' → 选 'Read and write' → Save。" -ForegroundColor Yellow
  Write-Host "   （Tokens (classic) 就勾 'workflow' 那个复选框。）" -ForegroundColor Yellow
  Write-Host "   保存后重跑本脚本即可，不用重建仓库。" -ForegroundColor Yellow
  exit 3
}
Write-Host "❌ 推送失败（退出码 $LASTEXITCODE）。常见原因：" -ForegroundColor Red
  Write-Host "   1) 仓库还没在 GitHub 网页上创建（git 不能替你建空仓库）"
  Write-Host "   2) token 权限不够或已过期（Fine-grained 要选中这个仓库 + Contents: Write）"
  Write-Host "   3) 代理掉线：先确认 127.0.0.1:10808 在监听"
  Write-Host "   4) 远端已有提交历史：先 .\git.ps1 pull origin main --rebase 或改用 --force（会覆盖远端，慎用）"
  Write-Host "   5) 缺 workflow 范围（本仓库有 .github/workflows/android.yml，见上面专门提示）"
  Write-Host "   6) 提交邮箱不是 GitHub 已验证邮箱：.\git.ps1 config user.email <你的邮箱>"

