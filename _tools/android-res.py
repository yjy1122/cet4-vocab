"""备用方案：直接把图标/开屏写进 Capacitor 生成的 android/app/src/main/res（不依赖 @capacitor/assets）。"""
import os
import sys
from PIL import Image

ROOT = r"D:\Users\DawnFish\Desktop\新建文件夹"
SRC_ICON = os.path.join(ROOT, "assets", "icon.png")
SRC_SPLASH = os.path.join(ROOT, "assets", "splash.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

MIPMAP = {           # 密度 → 启动器图标尺寸
    "mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192,
}
SPLASH = {         # 密度 → 开屏尺寸（正方形源图居中缩放）
    "drawable-mdpi": 320, "drawable-hdpi": 480, "drawable-xhdpi": 720,
    "drawable-xxhdpi": 960, "drawable-xxxhdpi": 1440, "drawable": 480,
    "drawable-land-mdpi": 800, "drawable-land-hdpi": 1280, "drawable-land-xhdpi": 1600,
    "drawable-land-xxhdpi": 2000, "drawable-land-xxxhdpi": 2400, "drawable-land": 1280,
}

if not os.path.isdir(RES):
    sys.exit(f"找不到 res 目录：{RES}（请先执行 cap add android）")

icon = Image.open(SRC_ICON).convert("RGB")
splash = Image.open(SRC_SPLASH).convert("RGB")
done = 0

for d, size in MIPMAP.items():
    p = os.path.join(RES, d)
    if not os.path.isdir(p):
        os.makedirs(p, exist_ok=True)
    im = icon.resize((size, size), Image.LANCZOS)
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        im.save(os.path.join(p, name))
        done += 1

for d, edge in SPLASH.items():
    p = os.path.join(RES, d)
    if not os.path.isdir(p):
        continue
    # 方形源图 → 按短边缩放后居中贴到白底画布，避免拉伸变形
    s = min(splash.size)
    crop = splash.crop(((splash.width - s) // 2, (splash.height - s) // 2,
                        (splash.width + s) // 2, (splash.height + s) // 2))
    canvas_h = max(640, int(edge * 0.6))
    canvas = Image.new("RGB", (edge, canvas_h), (255, 255, 255))
    inner = crop.resize((int(canvas_h * 0.55), int(canvas_h * 0.55)), Image.LANCZOS)
    canvas.paste(inner, ((edge - inner.width) // 2, (canvas_h - inner.height) // 2))
    canvas.save(os.path.join(p, "splash.png"))
    done += 1

print(f"已写入 {done} 个资源文件到 {RES}")
