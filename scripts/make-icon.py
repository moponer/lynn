#!/usr/bin/env python3
"""生成正式应用图标（B · Wordmark 方案）——真 PNG / 真 ICO，不是 SVG。

设计：深墨圆角方 + 衬线全词 "Lynn" + 黄铜细线与菱形 + tagline
"A LYNN OF YOUR OWN"。小尺寸（≤64px）自动切到单独的 "L" 字标，
因为 16px 放不下四个字母 —— 这是手写多帧 ICO 的原因（Pillow 的
save(ICO, sizes=...) 只能把同一张图缩放，做不到逐帧换图案）。

输出：
    assets/icon-1024.png  透明圆角源图
    assets/icon.png       512×512（BrowserWindow / Linux）
    build/icon.png        512×512
    build/icon.ico        16/24/32/48/64/128/256 七帧 Windows 图标

依赖：Pillow + Windows 自带字体（Georgia Bold / Calibri Bold）。
只在重做图标时手动跑，不进构建链。
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import io
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
ASSETS = os.path.join(ROOT, "assets")
FONT_DIR = r"C:\Windows\Fonts"
S = 1024

NAVY = (16, 24, 32)
BRASS = (200, 162, 74)
CREAM = (242, 231, 207)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def base():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=232, fill=NAVY + (255,))
    return im, d


def spaced(d, cx, y, text, f, fill, gap):
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + gap * (len(text) - 1)
    x = cx - total / 2
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=f, fill=fill, anchor="lm")
        x += w + gap


def wordmark():
    """B 方案全设计"""
    im, d = base()
    spaced(d, S / 2, 470, "Lynn", font("georgiab.ttf", 250), CREAM + (255,), 26)
    d.line((190, 640, 400, 640), fill=BRASS + (255,), width=5)
    d.polygon([(512, 628), (528, 640), (512, 652), (496, 640)], fill=BRASS + (255,))
    d.line((624, 640, 834, 640), fill=BRASS + (255,), width=5)
    spaced(d, S / 2, 742, "A LYNN OF YOUR OWN", font("calibrib.ttf", 44), BRASS + (255,), 12)
    return im


def monogram():
    """小尺寸简版：只留一个粗 L（16/24/32/48/64 用）"""
    im, d = base()
    d.text((S / 2, 500), "L", font=font("georgiab.ttf", 620), fill=BRASS + (255,), anchor="mm")
    return im


def scaled(im, n):
    out = im.resize((n, n), Image.LANCZOS)
    if n <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=110, threshold=2))
    return out


def write_ico(frames, path):
    """手写 ICONDIR + ICONDIRENTRY + 逐帧 PNG（Vista+ 的 PNG-in-ICO，支持 alpha）"""
    header = struct.pack("<HHH", 0, 1, len(frames))
    entries = b""
    blobs = b""
    offset = 6 + 16 * len(frames)
    for n, im in frames:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blob = buf.getvalue()
        dim = 0 if n >= 256 else n  # ICO 规范：0 表示 256
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + entries + blobs)


def main():
    os.makedirs(BUILD, exist_ok=True)
    full = wordmark()
    mini = monogram()

    full.save(os.path.join(ASSETS, "icon-1024.png"))
    big = scaled(full, 512)
    big.save(os.path.join(ASSETS, "icon.png"))
    big.save(os.path.join(BUILD, "icon.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [(n, scaled(mini if n <= 64 else full, n)) for n in sizes]
    ico_path = os.path.join(BUILD, "icon.ico")
    write_ico(frames, ico_path)

    # 自检：能被 Pillow 读回、帧齐全
    check = Image.open(ico_path)
    print("ICO 帧：", sorted(check.ico.sizes()))
    print("小尺寸用 L 字标：", [n for n, _ in frames if n <= 64])
    print("输出：assets/icon-1024.png / assets/icon.png / build/icon.png / build/icon.ico")


if __name__ == "__main__":
    main()
