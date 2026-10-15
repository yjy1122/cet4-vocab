#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 www/js/seed-words.js 反向生成 _tools/fixtures/sample.docx。

为什么要这个：回归测试原先直接读桌面上的 样例.docx——一个仓库外的文件。
那个文件被移进回收站的那一刻，整套测试就起不来了（这不是假设，是今天发生的）。
Word 原文的结构就是「段落 + 制表符」（_tools/parse_seed.py 读的是 doc.paragraphs，
不是 tables），所以用 python-docx 造同构的段落即可，制表符会写成 <w:tab/>，
和 Word 存出来的形态一致——这正是要验的那条解析路径。

重新生成: python _tools/make-docx-fixture.py
"""
import json
import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，打印 ✅ 会 UnicodeEncodeError——不依赖调用环境，自己定编码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from docx import Document
from docx.oxml import OxmlElement

ROOT = Path(__file__).resolve().parent.parent
SEED_JS = ROOT / "www" / "js" / "seed-words.js"
OUT = ROOT / "_tools" / "fixtures" / "sample.docx"


def load_seed():
    """seed-words.js 是 `window.SEED_WORDS = [...]`，取中间那段 JSON。"""
    txt = SEED_JS.read_text(encoding="utf-8")
    m = re.search(r"window\.SEED_WORDS\s*=\s*(\[.*\])", txt, re.S)
    if not m:
        sys.exit("❌ 在 seed-words.js 里找不到 window.SEED_WORDS")
    return json.loads(m.group(1))


def add_tab_paragraph(doc, left, right):
    """写成一行的两个制表符分隔字段：run.text 里的 \t 会被 python-docx 转成 <w:tab/>。"""
    p = doc.add_paragraph()
    p.add_run(left)
    run = p.add_run()
    run._r.append(OxmlElement("w:tab"))           # 显式制表符，和 Word 表格导出一致
    p.add_run(right)
    return p


def senses_to_cell(w):
    """把 senses 拼回单元格文本。POS 标记留在原处，解析端靠它切段。"""
    parts = []
    for s in w.get("senses") or []:
        pos = (s.get("pos") or "").strip()
        meaning = (s.get("meaning") or "").strip()
        parts.append((pos + " " + meaning).strip())
    return "，".join(p for p in parts if p)


def main():
    words = load_seed()
    OUT.parent.mkdir(parents=True, exist_ok=True)

    doc = Document()
    doc.core_properties.title = "noadic 回归样例"
    doc.core_properties.comments = "由 _tools/make-docx-fixture.py 生成，勿手改"

    # 表头行：G4 断言的就是这一行不能被当成词条
    add_tab_paragraph(doc, "英文单词", "词性及中文释义")

    last_unit = None
    units_seen = []
    for w in words:
        u = w.get("unit") or "未分组"
        # 只在单元「变化」时补标题行：解析端是按最近一次标题归属的，
        # 若种子顺序不连续，用"首次出现"会把后面的词挂到错误的单元下。
        if u != last_unit:
            if u not in units_seen:
                units_seen.append(u)
            doc.add_paragraph(u)
            last_unit = u
        add_tab_paragraph(doc, w["word"], senses_to_cell(w))

    doc.save(OUT)
    n_tables = len(doc.tables)
    print(f"✅ 写出 {OUT.relative_to(ROOT)}")
    print(f"   词条 {len(words)} 条，单元标题 {len(units_seen)} 个：{'、'.join(units_seen)}")
    print(f"   表格 {n_tables} 个（原文也是纯段落，制表符写成 <w:tab/>）")
    print(f"   文件大小 {OUT.stat().st_size} 字节")


if __name__ == "__main__":
    main()
