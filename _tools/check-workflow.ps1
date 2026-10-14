# Validate the Actions workflow: YAML parses, triggers/permissions right, and the
# release step's bash is syntactically valid (bash -n) with the env vars it needs.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$py = (Get-Command python -EA SilentlyContinue).Source
if (-not $py) { Write-Host "python not found" -ForegroundColor Red; exit 1 }
$yml = Join-Path $root ".github\workflows\android.yml"

$code = @"
import yaml, json, sys
d = yaml.safe_load(open(r'$yml', encoding='utf-8'))
on = d.get('on', d.get(True))
print('triggers      :', json.dumps(on, ensure_ascii=False))
print('permissions   :', d.get('permissions'))
steps = d['jobs']['apk']['steps']
print('steps         :', len(steps))
rel = [s for s in steps if 'Release' in str(s.get('name', ''))]
assert rel, 'no release step'
rel = rel[0]
print('release env   :', sorted(rel.get('env', {}).keys()))
open(r'$env:TEMP\rel.sh', 'w', encoding='utf-8', newline='\n').write(rel['run'])
print('run written   : ok')
try:
    import bashcheck  # noqa
except Exception:
    pass
"@
& $py -c $code
if ($LASTEXITCODE -ne 0) { Write-Host "YAML 解析失败" -ForegroundColor Red; exit 1 }

$sh = Join-Path $env:TEMP "rel.sh"
$bush = Join-Path $root ".tooling\git\usr\bin\bash.exe"
if (Test-Path $bush) {
  Write-Host "`n--- bash -n 语法检查（PortableGit 的 bash） ---"
  & $bush -n $sh 2>&1 | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -eq 0) { Write-Host "  ✅ shell 语法通过" -ForegroundColor Green }
  else { Write-Host "  ❌ shell 语法错误 exit=$LASTEXITCODE" -ForegroundColor Red; exit 1 }
  Write-Host "`n--- set -u 下的未定义变量静态扫描（\$\{VAR\} 未在 env/前置赋值里出现的） ---"
  $txt = Get-Content $sh -Raw
  $vars = [regex]::Matches($txt, '\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  $defined = @($vars | Where-Object { $txt -match "(?m)^\s*$_=" })
  Write-Host ("  引用变量: " + ($vars -join ', '))
  Write-Host ("  脚本内赋值: " + ($defined -join ', '))
} else { Write-Host "bash 不存在，跳过 shell 校验" -ForegroundColor Yellow }
