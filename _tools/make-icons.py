"""生成 APK/PWA 图标与开屏图资源（无网络、纯 Pillow 绘制）"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = r"D:\Users\DawnFish\Desktop\新建文件夹"
ACCENT = (37, 99, 235)        # #2563EB
ACCENT_D = (30, 64, 175)
WHITE = (255, 255, 255)
GREEN = (22, 163, 74)
INK = (15, 23, 42)


def font(size, prefer_cn=True):
    cands = []
    if prefer_cn:
        cands += [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]
    cands += [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf"]
    for p in cands:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def rounded(draw, box, r, fill):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill)


def icon(size=1024, mark=False):
    """mark=True：只画字母标 "n"。16–48px 的 favicon 上，缩小的字标会糊成一团
    （实测 32px 完全不可读），单字母在那个尺寸才站得住。"""
    img = Image.new("RGB", (size, size), ACCENT)
    d = ImageDraw.Draw(img)
    # 纵向渐变底（干净、无条纹）
    for y in range(size):
        t = y / size
        col = tuple(int(ACCENT[k] + (ACCENT_D[k] - ACCENT[k]) * t) for k in range(3))
        d.line([(0, y), (size, y)], fill=col)
    d = ImageDraw.Draw(img)

    m = size * 0.17 if not mark else size * 0.13   # 安全边距（自适应图标会被裁切）
    card = (m, m * 1.02, size - m, size - m * 1.02)
    rounded(d, card, int(size * 0.06), WHITE)

    if mark:
        d.text(((card[0] + card[2]) / 2, (card[1] + card[3]) / 2 - size * 0.01), "n",
               font=font(int(size * 0.52)), fill=ACCENT, anchor="mm")
    else:
        # 卡片上的字标：noadic（大字）+ 不止词典（小字）
        d.text(((card[0] + card[2]) / 2, card[1] + (card[3] - card[1]) * 0.34), "noadic",
               font=font(int(size * 0.142)), fill=ACCENT, anchor="mm")
        d.text(((card[0] + card[2]) / 2, card[1] + (card[3] - card[1]) * 0.68), "不止词典",
               font=font(int(size * 0.098)), fill=INK, anchor="mm")
    # 右下角绿色完成标记
    r = size * (0.095 if mark else 0.075)
    cx, cy = size - m - r * 0.35, card[3] - r * 0.35
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN, outline=WHITE, width=int(size * 0.012))
    d.line([(cx - r * 0.42, cy), (cx - r * 0.08, cy + r * 0.36), (cx + r * 0.45, cy - r * 0.34)],
           fill=WHITE, width=int(size * 0.02), joint="curve")
    return img


def splash(size=2732):
    img = Image.new("RGB", (size, size), (248, 250, 253))
    d = ImageDraw.Draw(img)
    small = icon(1024).resize((int(size * 0.30), int(size * 0.30)), Image.LANCZOS)
    img.paste(small, ((size - small.width) // 2, (size - small.height) // 2))
    return img


os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
os.makedirs(os.path.join(ROOT, "www"), exist_ok=True)

big = icon(1024)
big.save(os.path.join(ROOT, "assets", "icon.png"))          # APK 图标源图（CI 由它生成 mipmap）
splash(2732).save(os.path.join(ROOT, "assets", "splash.png"))
# 每个尺寸单独绘制，而不是从 1024 缩：缩放会把字边糊掉
for s, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
    icon(s).save(os.path.join(ROOT, "www", name))
icon(32, mark=True).save(os.path.join(ROOT, "www", "favicon-32.png"))   # 小尺寸用字母标

# maskable 版：内容缩到 60%，四周留安全区
mask = Image.new("RGB", (1024, 1024), ACCENT)
inner = big.resize((640, 640), Image.LANCZOS)
mask.paste(inner, (192, 192))
mask.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "www", "icon-maskable-512.png"))
mask.resize((192, 192), Image.LANCZOS).save(os.path.join(ROOT, "www", "icon-maskable-192.png"))
# （旧版这里还有一行从 1024 缩放写 icon-512.png 的残留，已被上面的逐尺寸绘制取代）

print("assets:", sorted(os.listdir(os.path.join(ROOT, "assets"))))
print("www pngs:", sorted(f for f in os.listdir(os.path.join(ROOT, "www")) if f.endswith(".png")))
