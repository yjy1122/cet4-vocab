<#
  Check every link in README.md: relative paths must exist on disk, absolute URLs must
  answer. Shields badges are checked for their rendered text, because a badge can return
  HTTP 200 while displaying "repo or workflow not found" -- a green request with a red lie.
#>
param([string]$File = "README.md")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$full = if ([System.IO.Path]::IsPathRooted($File)) { $File } else { Join-Path $root $File }
if (-not (Test-Path -LiteralPath $full)) { Write-Host "no such file: $full" -ForegroundColor Red; exit 1 }
$proxy = $env:HTTPS_PROXY
if (-not $proxy) { $proxy = "http://127.0.0.1:10808" }

$txt = [System.IO.File]::ReadAllText($full, (New-Object System.Text.UTF8Encoding($false)))
$dir = Split-Path -Parent $full

# [text](target)  -- ignore image-only links' targets separately, both are covered here
$links = [regex]::Matches($txt, '\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
$targets = @()
foreach ($m in $links) { $targets += $m.Groups[1].Value }
$targets = $targets | Where-Object { $_ } | Sort-Object -Unique

$bad = 0
foreach ($t in $targets) {
  if ($t -match '^#') { continue }                       # in-page anchor
  if ($t -match '^https?://') {
    if ($t -match 'img\.shields\.io') {
      try {
        $r = Invoke-WebRequest -Uri $t -Proxy $proxy -TimeoutSec 30 -UseBasicParsing
        $body = if ($r.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
        $mm = [regex]::Match($body, 'aria-label="([^"]*)"')
        $label = if ($mm.Success) { $mm.Groups[1].Value } else { "(no label)" }
        $badNow = $label -match 'not found|invalid|unknown|no releases|cannot'
        Write-Host ("  {0} {1,-14} {2}" -f $(if ($badNow) { "FAIL" } else { "ok  " }), "badge", $label) -ForegroundColor $(if ($badNow) { "Red" } else { "Gray" })
        if ($badNow) { $script:bad++ }
      } catch { Write-Host "  FAIL badge fetch: $t -> $($_.Exception.Message)" -ForegroundColor Red; $script:bad++ }
      continue
    }
    try {
      $r = Invoke-WebRequest -Uri $t -Method Head -Proxy $proxy -TimeoutSec 30 -UseBasicParsing
      Write-Host ("  ok   {0}  HTTP {1}" -f $r.StatusCode, ($t -replace '^https?://', '' )) -ForegroundColor Gray
    } catch {
      Write-Host ("  FAIL {0}  {1}" -f ($t -replace '^https?://', ''), $_.Exception.Message) -ForegroundColor Red
      $script:bad++
    }
  }
  else {
    $p = Join-Path $dir ($t -replace '/', '\')
    if (Test-Path -LiteralPath $p) { Write-Host ("  ok   本地 $t") -ForegroundColor Gray }
    else { Write-Host ("  FAIL 本地缺失 $t") -ForegroundColor Red; $script:bad++ }
  }
}
Write-Host ""
if ($bad) { Write-Host "$bad 个链接有问题" -ForegroundColor Red; exit 1 }
Write-Host "全部链接可用" -ForegroundColor Green
