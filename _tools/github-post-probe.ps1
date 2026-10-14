<#
  Probe whether the local proxy carries POST/upload to github.com.
  Isolates "git bug" from "proxy policy" when `git push` hangs after a
  successful dry-run (dry-run only ever does the GET refs advertisement).
  Usage:  powershell -File _tools\github-post-probe.ps1 -Repo user/repo
#>
param(
  [string]$Repo = "yjy1122/cet4-vocab",
  [string]$Proxy = "http://127.0.0.1:10808",
  [string]$CaBundle = "D:\cet4-build\.tooling\git\ucrt64\etc\ssl\certs\ca-bundle.crt",
  [switch]$Insecure,
  [int]$TimeoutSec = 25
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

$curl = @(
  (Join-Path $root ".tooling\git\ucrt64\bin\curl.exe"),
  (Join-Path $root ".tooling\git\mingw64\bin\curl.exe"),
  (Join-Path $root ".tooling\git\usr\bin\curl.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $curl) { Write-Host "curl.exe not found under .tooling\git" -ForegroundColor Red; exit 1 }

$token = $env:GH_TOKEN
if (-not $token) {
  $credFile = Join-Path $root ".tooling\git-credentials"
  if (Test-Path -LiteralPath $credFile) {
    $raw = Get-Content -LiteralPath $credFile -Raw
    $m = [regex]::Match($raw, "//[^:]+:([^@]+)@")
    if ($m.Success) { $token = $m.Groups[1].Value }
  }
}
Write-Host ("curl   : " + $curl)
Write-Host ("proxy  : " + $Proxy)
Write-Host ("token  : " + $(if ($token) { "loaded (" + $token.Substring(0, 12) + "...)" } else { "NONE" }))
Write-Host ""

function Invoke-Probe {
  # NOTE: $Args is a reserved automatic variable in PowerShell functions -- never
  # use it as a parameter name or the URL silently disappears.
  param([string]$Name, [string[]]$CurlArgs)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $full = @("-s", "-o", "NUL", "-x", $Proxy, "--max-time", "$TimeoutSec", "--cacert", $CaBundle,
            "-w", "HTTP %{http_code} up=%{size_upload}") + $CurlArgs
  $out = & $curl @full 2>&1 | Out-String
  $sw.Stop()
  $code = $out.Trim()
  if ($LASTEXITCODE -ne 0) { $code = $code + "  (curl exit $LASTEXITCODE)" }
  Write-Host ("{0,-28} {1,5:N1}s  {2}" -f $Name, $sw.Elapsed.TotalSeconds, $code)
}

Invoke-Probe -Name "GET  api.github.com"     -CurlArgs @("https://api.github.com/")
Invoke-Probe -Name "GET  github repo page"   -CurlArgs @("https://github.com/$Repo")
Invoke-Probe -Name "GET  refs advertisement" -CurlArgs @("https://github.com/$Repo.git/info/refs?service=git-receive-pack")
Invoke-Probe -Name "POST upload-pack (junk)" -CurlArgs @("-X", "POST", "-d", "junk", "https://github.com/$Repo.git/git-upload-pack")
if ($token) {
  Invoke-Probe -Name "POST receive-pack auth" -CurlArgs @("-X", "POST", "-H", "Authorization: token $token", "-d", "junk", "https://github.com/$Repo.git/git-receive-pack")
  Invoke-Probe -Name "PUT  api contents"      -CurlArgs @("-X", "PUT", "-H", "Authorization: token $token", "-H", "Content-Type: application/json", "-d", '{"message":"probe","content":"cHJvYmU="}', "https://api.github.com/repos/$Repo/contents/_probe.tmp")
} else {
  Invoke-Probe -Name "POST receive-pack (anon)" -CurlArgs @("-X", "POST", "-d", "junk", "https://github.com/$Repo.git/git-receive-pack")
}
Write-Host ""
Write-Host "Read: a GET that answers but a POST that burns the full timeout means the"
Write-Host "proxy is stalling request bodies to github.com -- git push cannot work there."
