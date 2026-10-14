<#
  One-shot project rename: CET-4 词汇引擎 (cet4-vocab) -> noadic.

  The ordered map below is the whole point: PowerShell's String.Replace is literal and
  case-sensitive, so a shorter key placed first would eat the tail of a longer one
  ("cet4-vocab" would shred "cet4-vocab-debug-apk" into "noadic-debug-apk" only by luck).
  Longest-first makes it deterministic.

  Deliberately NOT touched:
    www/js/store.js   -> keeps the literal "cet4-engine" so old backup files still import
    www/js/seed-words.js / dict-extra.js -> those are CET-4 *content*, not the brand
    android/, node_modules/, dist/, .tooling/ -> generated or ignored

  Usage: powershell -ExecutionPolicy Bypass -File _tools\rename-sweep.ps1 [-DryRun]
#>
param([switch]$DryRun)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

$MAP = @(
  @{ from = "com.cet4.vocabengine"; to = "com.noadic.app" },
  @{ from = "cet4-vocab-engine"; to = "noadic" },
  @{ from = "cet4-vocab-debug-apk"; to = "noadic-debug-apk" },
  @{ from = "cet4-vocab-debug.apk"; to = "noadic-debug.apk" },
  @{ from = "cet4-vocab"; to = "noadic" },                      # 仓库名：必须排在上面两条之后
  @{ from = "cet4-app"; to = "noadic-app" },
  @{ from = "cet4-mini"; to = "noadic-mini" },
  @{ from = "cet4.keystore"; to = "noadic.keystore" },
  @{ from = "cet4.engine.v1"; to = "noadic.v1" },
  @{ from = "cet4.engine.undo"; to = "noadic.undo" },
  @{ from = "D:\cet4-build"; to = "D:\noadic-build" },
  @{ from = "D:/cet4-build"; to = "D:/noadic-build" },
  @{ from = "CET-4 词汇引擎"; to = "noadic" },
  @{ from = "CET-4 词汇"; to = "noadic" }
)

$git = Join-Path $root ".tooling\git\cmd\git.exe"
$tracked = @(& $git -C $root ls-files 2>&1 | ForEach-Object { "$_" })
$skip = @("www/js/store.js", "www/js/seed-words.js", "www/js/dict-extra.js")
$exts = @(".js", ".json", ".md", ".ps1", ".yml", ".mjs", ".py", ".html", ".webmanifest", ".gitignore", ".gitattributes")

$touched = 0; $totalHits = 0
foreach ($f in $tracked) {
  if ($f -match '^(android|dist|node_modules|www/js/seed-words|www/js/dict-extra)') { continue }
  $ext = [System.IO.Path]::GetExtension($f).ToLower()
  if ($exts -notcontains $ext) { continue }
  if ($skip -contains ($f -replace '\\', '/')) { Write-Host "  跳过(保留兼容字符串) $f" -ForegroundColor DarkGray; continue }
  $p = Join-Path $root $f
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $txt = [System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false)))
  $orig = $txt
  $hits = 0
  foreach ($m in $MAP) {
    $c = ([regex]::Matches($txt, [regex]::Escape($m.from))).Count
    if ($c) { $txt = $txt.Replace($m.from, $m.to); $hits += $c }
  }
  if ($hits) {
    $touched++
    Write-Host ("  {0,-42} {1} 处" -f $f, $hits)
    $totalHits += $hits
    if (-not $DryRun) {
      # 中文内容一律按 UTF-8 读写；.ps1 必须带 BOM，否则 PS 5.1 按 GBK 误读
      $enc = New-Object System.Text.UTF8Encoding($ext -eq ".ps1")
      [System.IO.File]::WriteAllText($p, $txt, $enc)
      if ($orig.Replace("`r`n", "`n") -eq $txt.Replace("`r`n", "`n")) { Write-Host "     ⚠ 文本没变（替换未落地？）" -ForegroundColor Yellow }
    }
  }
}
Write-Host ""
Write-Host ("{0} 个文件，{1} 处替换{2}" -f $touched, $totalHits, $(if ($DryRun) { "（DRY RUN，未写盘）" } else { "" }))
