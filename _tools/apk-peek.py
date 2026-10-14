# -*- coding: utf-8 -*-
"""核对 APK 里 web 资源的形状：改文件不经过 shell 转义，避免中文参数被控制台代码页吃掉。"""
import sys, zipfile, hashlib, os

apk = sys.argv[1]
z = zipfile.ZipFile(apk)
names = [n for n in z.namelist() if n.startswith("assets/public/")]
print("assets/public 文件数: %d" % len(names))

def read(p):
    return z.read(p).decode("utf-8")

checks = [
    ("index.html", "data-view=\"recite\"", True,  "recite tab"),
    ("index.html", "id=\"rc-list\"", True,        "recite table"),
    ("index.html", "id=\"rc-mask-seg\"", True,    "mask seg"),
    ("index.html", "weak", True,                  "weak filter"),
    ("index.html", "com.cet4", False,             "old pkg id"),
    ("js/ui.js", "function renderRecite", True,   "renderRecite"),
    ("js/ui.js", "function rcCell", True,         "rcCell"),
    ("js/ui.js", "syncReciteMeta", True,          "syncReciteMeta"),
    ("js/store.js", "bookWords,", True,           "bookWords exported"),
    ("js/store.js", "function toggleWeak", True,  "toggleWeak"),
    ("js/quiz.js", "\"weak\"", True,              "weak scope"),
    ("css/app.css", ".rc-cell.masked", True,      "mask css"),
    ("sw.js", "noadic-v4", True,                  "sw version"),
]
bad = 0
for f, needle, want, label in checks:
    try:
        body = read("assets/public/" + f)
    except KeyError:
        print("  MISSING  %-22s (包内没有 %s)" % (label, f)); bad += 1; continue
    got = needle in body
    mark = "OK  " if got == want else "FAIL"
    if got != want:
        bad += 1
    print("  %s  %-24s %s  %s" % (mark, label, "有" if got else "无", "" if got == want else "（期望%s）" % ("有" if want else "无")))

# 与本地 www/ 逐文件 SHA 对账：包内资源必须与仓库里的一字不差
local_root = sys.argv[2] if len(sys.argv) > 2 else None
if local_root:
    # cap sync 注入的两个文件本来就不在 www/ 里，不该算差异
    injected = {"cordova.js", "cordova_plugins.js"}
    diff = 0
    for n in names:
        rel = n[len("assets/public/"):]
        if rel in injected:
            continue
        lp = os.path.join(local_root, rel.replace("/", os.sep))
        if not os.path.exists(lp):
            print("  ONLY-IN-APK  " + rel); diff += 1; continue
        a = hashlib.sha256(z.read(n)).hexdigest()
        b = hashlib.sha256(open(lp, "rb").read()).hexdigest()
        if a != b:
            print("  DIFFERS      " + rel); diff += 1
    for dirpath, _, fns in os.walk(local_root):
        for fn in fns:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, local_root).replace(os.sep, "/")
            if ("assets/public/" + rel) not in names:
                print("  ONLY-LOCAL   " + rel); diff += 1
    print("  www/ vs APK: %s" % ("identical" if diff == 0 else "%d mismatched" % diff))
    bad += diff

sys.exit(1 if bad else 0)
