# 保留这个入口是为了本机的肌肉记忆（package.json 的 npm run sync:harmony 也调它），
# 但实现只有一份：_tools/sync-www.mjs。
# 之所以不再是 PowerShell 本体：鸿蒙工程进了 main 之后，CI（Ubuntu）也要跑同步 + 审计，
# 两处各写一遍早晚分叉——这个坑我们已经踩过一次（明文许可只写进了本机脚本）。
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "找不到 node，无法调用 _tools/sync-www.mjs"; exit 1 }
& node (Join-Path $PSScriptRoot '_tools\sync-www.mjs')
exit $LASTEXITCODE
