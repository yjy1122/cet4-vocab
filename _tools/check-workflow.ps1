<#
  Validate .github/workflows/android.yml without pushing:
    1) YAML parses and the shape we rely on is there (push trigger, tags filter,
       contents permission, release step + the env vars it reads)
    2) every `run:` block is valid POSIX shell (bash -n from the portable git)

  Why: a YAML or shell typo here only surfaces as a failed Actions run minutes
  later, and each probe costs a whole build. This costs about a second.

  Usage: powershell -ExecutionPolicy Bypass -File _tools\check-workflow.ps1
#>
param(
  [string]$Yml = "",
  [switch]$SelfTest
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Yml) { $Yml = Join-Path $root ".github\workflows\android.yml" }

if ($SelfTest) {
  # 一个永远不会失败的检查比没有检查更糟。这里故意把 workflow 改坏，
  # 要求本脚本必须报警；再确认正常文件必须放行。
  # 每条变异都先断言"文本真的变了"，否则变异是空操作、测试自动通过 = 假绿。
  $src = [System.IO.File]::ReadAllText($Yml, (New-Object System.Text.UTF8Encoding($false)))
  $dir = Join-Path $root ".tooling\wf-check"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $cases = @(
    @{ n = "shell 少一个引号"; find = 'if [ "$REF_TYPE" = "tag" ]; then'; repl = 'if [ "$REF_TYPE" = "tag ; then'; want = 3 },
    @{ n = "if 结构不闭合";   find = 'set -euo pipefail';                repl = "set -euo pipefail`n          fi";           want = 3 },
    @{ n = "删掉 push.tags";  find = "    tags: ['v*']";                 repl = "";                                  want = 2 },
    @{ n = "contents 只读";   find = "  contents: write";                repl = "  contents: read";                want = 2 },
    @{ n = "删掉发布步骤名";   find = "发布到 GitHub Release";             repl = "打个包";                            want = 2 }
  )
  $bad = 0
  foreach ($c in $cases) {
    if (-not $src.Contains($c.find)) {
      Write-Host ("  ?? 变异目标不存在，测试无效: " + $c.n) -ForegroundColor Red; $bad++; continue
    }
    $mut = $src.Replace($c.find, $c.repl)
    if ($mut -eq $src) { Write-Host ("  ?? 变异没改动文件，测试无效: " + $c.n) -ForegroundColor Red; $bad++; continue }
    $f = Join-Path $dir ("mut-" + ([Math]::Abs($c.n.GetHashCode())) + ".yml")
    [System.IO.File]::WriteAllText($f, $mut, (New-Object System.Text.UTF8Encoding($false)))
    & $PSCommandPath -Yml $f | Out-Null
    $got = $LASTEXITCODE
    Remove-Item $f -EA SilentlyContinue
    if ($got -eq $c.want) { Write-Host ("  OK   抓到 " + $c.n + " (exit $got)") }
    else { Write-Host ("  MISS 漏掉 " + $c.n + " (exit $got, 期望 " + $c.want + ")") -ForegroundColor Red; $bad++ }
  }
  & $PSCommandPath -Yml $Yml | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host ("  MISS 正常文件被误判 (exit $LASTEXITCODE)") -ForegroundColor Red; $bad++ }
  else { Write-Host "  OK   正常文件放行" }
  if ($bad) { Write-Host ("self-test 失败：" + $bad + " 项") -ForegroundColor Red; exit 1 }
  Write-Host "self-test 全部通过：检查确实有牙" -ForegroundColor Green
  exit 0
}

$py = (Get-Command python -EA SilentlyContinue).Source
if (-not $py) { Write-Host "python not found (needed to parse YAML)" -ForegroundColor Red; exit 1 }

$scratchWin = Join-Path $root ".tooling\wf-check"
New-Item -ItemType Directory -Force -Path $scratchWin | Out-Null

# PortableGit's bash cannot resolve the D: drive letter at all, and the workspace
# path contains Chinese (mangled by MSYS). Both die on the junction instead, so hand
# python and bash the ASCII junction paths.
#
# Careful: the junction mapping must follow the -Yml argument, not hard-code the real
# workflow. Hard-coding it made the mutation tests pass vacuously (the checker kept
# reading the good file no matter what you handed it) -- i.e. a check that can never fail.
$hasJ = Test-Path "D:\noadic-build"
$ascr = if ($hasJ) { "D:/noadic-build/.tooling/wf-check" } else { ($scratchWin -replace '\\', '/') }
function To-AsciiPath([string]$p) {
  if (Test-Path -LiteralPath $p -PathType Container) { return ($p -replace '\\', '/') }
  if ($hasJ) {
    $rootN = (Resolve-Path -LiteralPath $root).Path.TrimEnd('\')
    if ($p -like ($rootN + "*")) {
      return ("D:/noadic-build" + $p.Substring($rootN.Length) -replace '\\', '/')
    }
  }
  return ($p -replace '\\', '/')
}
$ymlArg = To-AsciiPath $Yml
if (-not (Test-Path -LiteralPath $Yml)) { Write-Host "workflow 不存在: $Yml" -ForegroundColor Red; exit 1 }
Write-Host ("checking  : " + $ymlArg)

$code = @'
import yaml, json, sys
yml, scratch = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(yml, encoding="utf-8"))
on = d.get("on", d.get(True))            # YAML 1.1 folds a bare `on:` key to True
print("triggers    :", json.dumps(on, ensure_ascii=False))
print("permissions :", d.get("permissions"))
job = d["jobs"]["apk"]
steps = job["steps"]
print("steps       :", len(steps))

bad = []
if (not isinstance(on, dict) or "push" not in on):
    bad.append("no push trigger")
perm = (d.get("permissions") or {}).get("contents")
if perm != "write":
    # Releases 需要写权限；read 会让 gh release create 在最后一次 push 上 403
    bad.append("permissions.contents must be 'write' (got %r) -> gh release cannot publish" % (perm,))
p = (on.get("push") or {}) if isinstance(on, dict) else {}
if isinstance(p, dict) and "tags" not in p:
    bad.append("push.tags missing -> v* tag releases will never fire")
if not p.get("branches"):
    bad.append("push.branches empty -> plain pushes build nothing")

rel = [s for s in steps if "Release" in str(s.get("name", ""))]
if not rel:
    bad.append("no release step")
else:
    need = set(["GH_TOKEN", "REF_TYPE", "REF_NAME"])
    have = set((rel[0].get("env") or {}).keys())
    if not need.issubset(have):
        bad.append("release step env missing: " + ",".join(sorted(need - have)))
    txt = rel[0]["run"]
    for var in ["REF_TYPE", "REF_NAME", "APK", "TAG"]:
        if var not in txt:
            bad.append("release step never references " + var)
    if "gh release" not in txt:
        bad.append("release step does not call gh release")

up = [s for s in steps if "upload-artifact" in str(s.get("uses", ""))]
if not up:
    bad.append("no upload-artifact step (Artifacts 留档会消失)")

for i, s in enumerate(steps):
    if "run" in s:
        open(scratch + "/step-%02d.sh" % (i + 1), "w", encoding="utf-8", newline="\n").write(s["run"])
print("run blocks  :", len([s for s in steps if "run" in s]))
print(("BAD:" + "|".join(bad)) if bad else "SHAPE:ok")
'@

$codeFile = Join-Path $scratchWin "check.py"
[System.IO.File]::WriteAllText($codeFile, $code, (New-Object System.Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath $codeFile)) { Write-Host "can't write $codeFile" -ForegroundColor Red; exit 1 }

$out = & $py $codeFile $ymlArg $ascr 2>&1 | Out-String
Write-Host $out.TrimEnd()
if ($out -match "Traceback|YAMLError|SyntaxError") { Write-Host "YAML/解析失败" -ForegroundColor Red; exit 1 }
if ($out -match "BAD:") {
  $what = ($out -split "BAD:")[1].Trim() -split "\|"
  Write-Host "workflow 结构不对:" -ForegroundColor Red
  $what | ForEach-Object { Write-Host "   - $_" }
  exit 2
}

$bash = @(
  (Join-Path $root ".tooling\git\usr\bin\bash.exe"),
  "D:\noadic-build\.tooling\git\usr\bin\bash.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $bash) { Write-Host "找不到便携版 bash，跳过 shell 语法检查" -ForegroundColor Yellow; exit 0 }

Write-Host ""
Write-Host "--- 每个 run: 块做 bash -n ---"
$fail = 0
$files = @(Get-ChildItem -LiteralPath $scratchWin -Filter "step-*.sh")
if (-not $files.Count) { Write-Host "❌ 没有提取到任何 run 块，检查是空转的" -ForegroundColor Red; exit 4 }
foreach ($f in $files) {
  $arg = $ascr + "/" + $f.Name
  $err = & $bash -n $arg 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    Write-Output ("  OK    " + $f.Name)
  } else {
    Write-Output ("  FAIL  " + $f.Name)
    Write-Output ($err.TrimEnd() -replace "(?m)^", "     ")
    $fail++
  }
}
if ($fail) { Write-Host "" ; Write-Host "$fail 个 run 块语法错误" -ForegroundColor Red; exit 3 }
Write-Host ""
Write-Host "workflow 结构与 shell 语法均通过" -ForegroundColor Green
