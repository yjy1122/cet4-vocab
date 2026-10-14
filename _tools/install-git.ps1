<#
  免管理员安装便携版 Git 到 .tooling\git，并给本项目建第一个提交。
  可重复执行：已装则跳过下载。
#>
$ErrorActionPreference = "Continue"
$root = "D:\Users\DawnFish\Desktop\新建文件夹"
$t = Join-Path $root ".tooling"
$gitDir = Join-Path $t "git"
$gitExe = Join-Path $gitDir "cmd\git.exe"
$log = Join-Path $t "git-install.log"
function Log($m) { $line = "{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -LiteralPath $log -Value $line -Encoding UTF8; Write-Host $line }

$ver = "2.56.0.windows.2"
$file = "PortableGit-2.56.0.2-64-bit.7z.exe"
$url = "https://registry.npmmirror.com/-/binary/git-for-windows/v$ver/$file"

if (-not (Test-Path -LiteralPath $gitExe)) {
  Log "下载便携版 Git（57 MB）：$url"
  $pkg = Join-Path $t $file
  try {
    Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing -TimeoutSec 1800
  } catch { Log "❌ 下载失败：$($_.Exception.Message)"; exit 1 }
  Log "解压到 $gitDir"
  if (Test-Path -LiteralPath $gitDir) { Remove-Item -LiteralPath $gitDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $gitDir | Out-Null
  # 7z SFX：-y 全部覆盖，-o 指定目录（无空格写法更稳）
  $p = Start-Process -FilePath $pkg -ArgumentList @("-y", "-o$gitDir") -Wait -PassThru -NoNewWindow
  Log "解压进程退出码 $($p.ExitCode)"
  Remove-Item -LiteralPath $pkg -Force -ErrorAction SilentlyContinue
} else { Log "Git 已存在，跳过下载" }

if (-not (Test-Path -LiteralPath $gitExe)) { Log "❌ 解压后找不到 $gitExe"; exit 1 }
Log ("版本：" + ((& $gitExe --version) -join " "))

# 身份：只写进本仓库（--local），不动全局配置；用户名取系统账户名
$user = $env:USERNAME
if (-not (Test-Path -LiteralPath (Join-Path $root ".git"))) {
  Log "git init"
  & $gitExe -C $root init --initial-branch=main 2>&1 | ForEach-Object { Log "  $_" }
}
& $gitExe -C $root config user.name  $user
& $gitExe -C $root config user.email "$user@local.machine"
& $gitExe -C $root config core.autocrlf false
& $gitExe -C $root config commit.gpgsign false
Log "身份：$user <$user@local.machine>（仅本仓库；建议你自己换成真实邮箱）"

Log "暂存文件…"
& $gitExe -C $root add -A 2>&1 | Select-Object -First 6 | ForEach-Object { Log "  $_" }
$cnt = (& $gitExe -C $root diff --cached --name-only | Measure-Object).Count
Log "已暂存 $cnt 个文件"
$leak = & $gitExe -C $root ls-files | Where-Object { $_ -match '^(\.tooling|node_modules|android|dist)/' } | Select-Object -First 5
if ($leak) { Log "⚠ 有不该入库的路径被暂存：$($leak -join ', ')（请检查 .gitignore）" } else { Log "✅ 确认 .tooling / node_modules / android / dist 均未入库" }

& $gitExe -C $root commit -m "noadic：两级词库、顺序闯关、题型专项、滑动切词、APK 打包工程" -m "含 www 应用本体、Capacitor 打包配置、便携工具链脚本与 185 项回归测试。" 2>&1 | ForEach-Object { Log "  $_" }
Log "最近提交：$((& $gitExe -C $root log --oneline -1) -join ' ')"
Log "工作区状态：$((& $gitExe -C $root status --short | Measure-Object).Count) 个未提交变更"

$hint = @'
便携版 Git 已装在 .tooling\git，未加入系统 PATH。用法：
  D:\Users\DawnFish\Desktop\新建文件夹\.tooling\git\cmd\git.exe status
或临时加进当前会话：
  $env:Path = "D:\Users\DawnFish\Desktop\新建文件夹\.tooling\git\cmd;" + $env:Path
'@
Set-Content -LiteralPath (Join-Path $root "HOWTO-git.md") -Value $hint -Encoding UTF8
Log "用法写在 HOWTO-git.md"
