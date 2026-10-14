$ErrorActionPreference = 'Stop'

$wwwDir   = Join-Path $PSScriptRoot 'www'
$rawfileDir = Join-Path $PSScriptRoot 'harmony\entry\src\main\resources\rawfile'

if (-not (Test-Path $wwwDir)) {
  Write-Error "www/ directory not found at $wwwDir"
  exit 1
}

if (Test-Path $rawfileDir) {
  Remove-Item $rawfileDir -Recurse -Force
}

New-Item -ItemType Directory -Path $rawfileDir -Force | Out-Null
Copy-Item -Path "$wwwDir\*" -Destination $rawfileDir -Recurse -Force

Write-Host "Synced www/ -> harmony/entry/src/main/resources/rawfile/ ($((Get-ChildItem $rawfileDir -Recurse -File).Count) files)"
