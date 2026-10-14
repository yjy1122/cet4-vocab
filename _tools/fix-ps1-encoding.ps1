<#
  Normalize a PowerShell script to the encoding PowerShell 5.1 actually needs:
  UTF-8 WITH BOM (so Chinese literals are not read as GBK) + LF line endings
  (so git diffs stay readable and match the repo's other .ps1 files).

  The edit tool drops the BOM, which silently corrupts every Chinese string in
  the file -- run this after any edit to a .ps1 that contains non-ASCII text.

  Usage:
    powershell -ExecutionPolicy Bypass -File _tools\fix-ps1-encoding.ps1 -Path connect-github.ps1
    powershell -ExecutionPolicy Bypass -File _tools\fix-ps1-encoding.ps1 -All
#>
param(
  [string]$Path,
  [switch]$All
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$targets = @()
if ($All) {
  $targets = @(Get-ChildItem -LiteralPath $root -Recurse -Filter *.ps1 -File |
    Where-Object { $_.FullName -notmatch '\\(\.tooling|node_modules|android|dist)\\' } |
    ForEach-Object { $_.FullName })
}
elseif ($Path) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $root $Path }
  $targets = @($Path)
}
else { Write-Host "give -Path <file> or -All" -ForegroundColor Red; exit 1 }

foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t)) { Write-Host "skip (missing): $t" -ForegroundColor Yellow; continue }
  $bytes = [System.IO.File]::ReadAllBytes($t)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $body = $bytes
  if ($hasBom) {
    $body = New-Object byte[] ($bytes.Length - 3)
    [Array]::Copy($bytes, 3, $body, 0, $bytes.Length - 3)
  }
  $text = [System.Text.Encoding]::UTF8.GetString($body)
  $crlf = ([regex]::Matches($text, "`r`n")).Count
  $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")

  $out = New-Object byte[] ($text.Length * 3 + 3)
  $enc = New-Object System.Text.UTF8Encoding($false)
  $payload = $enc.GetBytes($text)
  $out = New-Object byte[] ($payload.Length + 3)
  $out[0] = 0xEF; $out[1] = 0xBB; $out[2] = 0xBF
  [Array]::Copy($payload, 0, $out, 3, $payload.Length)
  [System.IO.File]::WriteAllBytes($t, $out)

  # Parse without executing: catches an unbalanced brace right here.
  $errs = $null
  [void][System.Management.Automation.PSParser]::Tokenize($text, [ref]$errs)
  $status = if ($errs -and $errs.Count) { "PARSE ERRORS: " + ($errs | ForEach-Object { "line $($_.Token.StartLine): $($_.Message)" }) -join '; ' } else { "parse ok" }
  $name = $t.Substring($root.Length + 1)
  # 打印的是"处理前"的状态，容易读反（bom:False 其实是"这次给它补上了 BOM"）。说成人话。
  $bomState = if ($hasBom) { "已有" } else { "本次补上" }
  Write-Host ("{0,-38} BOM:{1,-8} 去掉 CRLF:{2,-4} {3}" -f $name, $bomState, $crlf, $status)
  if ($errs -and $errs.Count) { exit 2 }
}
