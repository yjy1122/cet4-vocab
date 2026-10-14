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
for v in 1.2.0 1.1.0 1.0.0; do
  n=$(extract "$v" | grep -c '^- \|^尚未\|^\*\*' || true)
  head=$(extract "$v" | grep -m1 '^- ' || echo '（空）')
  if [ "$n" -ge 1 ]; then
    echo "  ✅ [$v] 抽到 $n 条要点，首条：${head#- }"
  else
    echo "  ❌ [$v] 什么都没抽到 —— CHANGELOG 标题形状和 awk 假设不一致"
    fail=1
  fi
done

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

if [ "$fail" = "0" ]; then echo "CHANGELOG 抽取检查通过"; else echo "CHANGELOG 抽取检查失败"; exit 1; fi
