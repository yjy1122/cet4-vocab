# -*- coding: utf-8 -*-
"""核对 APK 里 web 资源的形状：改文件不经过 shell 转义，避免中文参数被控制台代码页吃掉。"""
import sys, zipfile, hashlib, os, re

apk = sys.argv[1]
# argv[2] 是 www 目录（与下面 SHA 对账用的是同一个参数），不传则退回脚本所在仓库的 www/
WWW_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "www")
z = zipfile.ZipFile(apk)
names = [n for n in z.namelist() if n.startswith("assets/public/")]
print("assets/public 文件数: %d" % len(names))

def read(p):
    return z.read(p).decode("utf-8")

# sw 的缓存版本号：必须从 www/sw.js 里读，不能写死。
# 写死的话每次升 APP_VERSION 这条都会假失败（这次就是这样）——
# 而假失败看多了，真失败也就没人看了。
def sw_version(text):
    m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else None

SRC_SW = None
try:
    with open(os.path.join(WWW_DIR, "sw.js"), encoding="utf-8") as fh:
        SRC_SW = sw_version(fh.read())
except OSError:
    print("  WARN   sw version 无法比对：读不到 %s" % os.path.join(WWW_DIR, "sw.js"))

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

# 包内 sw.js 的缓存版本必须与 www/sw.js 一致
try:
    APK_SW = sw_version(read("assets/public/sw.js"))     # read() 要的是完整 zip 路径
except KeyError:
    APK_SW = "<包内没有 sw.js>"
if SRC_SW is None:
    print("  FAIL  %-24s 源码侧读不到版本号，无法比对" % "sw version"); bad += 1
elif APK_SW == SRC_SW:
    print("  OK    %-24s %s" % ("sw version", APK_SW))
else:
    print("  FAIL  %-24s 包内=%s 源码=%s（打进包的资源不是当前这份）" % ("sw version", APK_SW, SRC_SW)); bad += 1

# 与本地 www/ 逐文件 SHA 对账：包内资源必须与仓库里的一字不差
local_root = WWW_DIR
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
