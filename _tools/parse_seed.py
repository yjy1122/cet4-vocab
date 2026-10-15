import os, sys
import re, json, io
from docx import Document

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(_ROOT), "样例.docx")   # 桌面那份 Word 原件
OUT_JS = os.path.join(_ROOT, "www", "js", "seed-words.js")
OUT_LIST = os.path.join(_ROOT, "_tools", "wordlist.txt")

POS_MARKERS = ["n.", "v.", "adj.", "adv.", "prep.", "conj.", "pron.", "num.", "int.", "art.", "aux.", "abbr.", "a.", "ad."]
POS_RE = re.compile(r"(n|v|adj|adv|prep|conj|pron|num|int|art|aux|abbr|a|ad)\.")

doc = Document(SRC)
unit = None
words = []
for p in doc.paragraphs:
    t = p.text.strip()
    if not t:
        continue
    m = re.fullmatch(r"Unit\s*(\d+)", t, re.I)
    if m:
        unit = "Unit " + m.group(1)
        continue
    if "\t" not in t:
        continue
    left, right = t.split("\t", 1)
    left, right = left.strip(), right.strip()
    if not left or left == "英文单词" or right == "词性及中文释义":
        continue
    raw = right
    # split into POS segments
    marks = [(m.start(), m.group(0)) for m in POS_RE.finditer(raw)]
    senses = []
    for i, (pos_start, pos_label) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(raw)
        body = raw[pos_start + len(pos_label):end].strip()
        senses.append({"pos": pos_label, "meaning": body.strip(" ，,")})
    # 合并词性写法: "n. & v. 离婚；分离" / "v. & n. ..."
    merged = []
    i = 0
    while i < len(senses):
        cur = senses[i]
        if re.fullmatch(r"[&/、]", cur["meaning"]) and i + 1 < len(senses):
            nxt = senses[i + 1]
            merged.append({"pos": cur["pos"], "meaning": nxt["meaning"]})
            merged.append({"pos": nxt["pos"], "meaning": nxt["meaning"]})
            i += 2
            continue
        merged.append(cur)
        i += 1
    senses = merged
    if not senses:
        senses = [{"pos": "", "meaning": raw}]
    multi = "、".join(sorted({s["pos"] for s in senses if s["pos"]}))
    words.append({
        "word": left,
        "unit": unit,
        "senses": senses,
        "pos_summary": multi,
        "definition_raw": raw,
    })

with open(OUT_LIST, "w", encoding="utf-8") as f:
    f.write("\n".join(w["word"] for w in words))

js = "// 由 _tools/parse_seed.py 从 样例.docx 机器解析生成，释义与 Word 原文一致，请勿手改。\n"
js += "// 重新生成: python _tools/parse_seed.py\n"
js += "window.SEED_WORDS = " + json.dumps(words, ensure_ascii=False, indent=1) + ";\n"
with open(OUT_JS, "w", encoding="utf-8") as f:
    f.write(js)

print("words:", len(words))
print("units:", sorted({w["unit"] for w in words}))
print("multi-pos:", sum(1 for w in words if len(w["senses"]) > 1))
print("no-pos:", [w["word"] for w in words if not any(s["pos"] for s in w["senses"])])
