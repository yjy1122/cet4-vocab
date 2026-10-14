# Wrapper for the portable Git installed under .tooling\git (not added to system PATH).
# Usage:  .\git.ps1 status        .\git.ps1 add -A        .\git.ps1 commit -m "msg"
# To use plain `git` in a session:  $env:Path = "$PSScriptRoot\.tooling\git\cmd;" + $env:Path
$g = Join-Path $PSScriptRoot ".tooling\git\cmd\git.exe"
if (-not (Test-Path -LiteralPath $g)) {
  Write-Error "Portable git not found at: $g`nRun _tools\install-git.ps1 first."
  exit 1
}
& $g -C $PSScriptRoot @args
exit $LASTEXITCODE
