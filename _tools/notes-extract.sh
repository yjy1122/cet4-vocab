#!/usr/bin/env bash
# 复刻 CI 里"从 CHANGELOG.md 抽本版本发布说明"那一步，并做正/负两组对照。
# 用法：bash _tools/notes-extract.sh            （自检）
#       bash _tools/notes-extract.sh 1.2.0      （只打印该版本的段落）
set -euo pipefail
cd "$(dirname "$0")/.."

extract() {
  # 任何 "## " 标题都重置命中状态；方括号让 [1.2] 不会误命中 [1.2.0]
  awk -v want="$1" '/^## /{ p = (index($0, "[" want "]") > 0); next } p{ print }' CHANGELOG.md
}

if [ $# -ge 1 ]; then
  extract "$1"
  exit 0
fi

fail=0
# 版本清单从 CHANGELOG 自己枚举，不写死：写死的检查不会随新章节长大，
# 加了 1.2.1 却仍然只验 1.2.0，等于悄悄失去覆盖。
vers=$(grep -o '^## \[[0-9][^]]*\]' CHANGELOG.md | sed 's/^## \[//; s/\]$//')
n=$(printf '%s\n' "$vers" | grep -c . || true)
echo "  CHANGELOG 里的版本：$(echo $vers | tr '\n' ' ')"
for v in $vers; do
  c=$(extract "$v" | grep -c '^- ' || true)
  head=$(extract "$v" | grep -m1 '^- ' || echo '（空）')
  if [ "$c" -ge 1 ]; then
    echo "  ✅ [$v] 抽到 $c 条要点，首条：${head#- }"
  else
    echo "  ❌ [$v] 什么都没抽到 —— 该段没有以 \"- \" 开头的正文，Release 会是空的"
    fail=1
  fi
done
if [ "$n" -lt 1 ]; then echo "  ❌ CHANGELOG 里一个版本段都没有"; fail=1; fi

# 负向对照：不存在的版本必须抽不到东西，否则说明这段抽取其实一直在"抓到就算"
bad=$(extract 9.9.9 | wc -l | tr -d ' ')
if [ "$bad" = "0" ]; then
  echo "  ✅ [9.9.9] 抽到 0 行（负向对照：不存在的版本不会误命中）"
else
  echo "  ❌ [9.9.9] 竟然抽到 $bad 行 —— 匹配太松，会把别的版本写进发布说明"
  fail=1
fi

# Unreleased 段不能被当成某个版本的说明
un=$(extract Unreleased | grep -c '锁屏方向' || true)
echo "  ℹ️  [Unreleased] 可单独抽出（$un 处命中），不参与版本号匹配"

# CI 给滚动版抽的是 package.json 的版本号：那里没有对应段落，Release 正文就静默退化成兜底文案
cur=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
if [ -n "$cur" ]; then
  if printf '%s\n' "$vers" | grep -qx "$cur"; then
    echo "  ✅ package.json 的 $cur 在 CHANGELOG 里有对应段落"
  else
    echo "  ❌ package.json 是 $cur，但 CHANGELOG 没有 [$cur] —— 发出去的 Release 会抽不到说明"
    fail=1
  fi
fi

if [ "$fail" = "0" ]; then echo "CHANGELOG 抽取检查通过"; else echo "CHANGELOG 抽取检查失败"; exit 1; fi
