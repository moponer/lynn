#!/usr/bin/env python3
"""图标方案预览（临时）：4 种都带 "Lynn" 英文字标，生成真 PNG 供挑选。

不写正式产物（build/、assets/icon*），只出 shots/icon-option-*.png 与对比图。
设计依据：桌面图标常见的四条路子 —— 单色几何字标 / 编辑感全词字标 /
深度玻璃层 / 印章式徽记。全部先在 2× 画布绘制再 LANCZOS 缩小，保证边缘干净。
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")
FONT_DIR = r"C:\Windows\Fonts"
S = 1024  # 2× 画布

NAVY = (16, 24, 32)
NAVY2 = (27, 42, 58)
BRASS = (200, 162, 74)
CREAM = (242, 231, 207)
INK = (16, 24, 32)
PAPER = (242, 231, 207)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def canvas(bg):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=232, fill=bg)
    return im, d


def soften(im):
    im = im.resize((512, 512), Image.LANCZOS)
    return im


def spaced_text(d, xy, text, f, fill, spacing=0, anchor_center=True):
    """逐字排版，手动字距；anchor_center=True 时以 xy 为整体中心"""
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = xy[0] - total / 2 if anchor_center else xy[0]
    for ch, w in zip(text, widths):
        d.text((x, xy[1]), ch, font=f, fill=fill, anchor="lm")
        x += w + spacing
    return total


def rounded_base(im):
    """把画好的内容裁进圆角（用于渐变/光斑这类铺满的图层）"""
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=232, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


# ---------- A · Monogram：字母 L 与风铃管合体 ----------
def option_a():
    im, d = canvas(NAVY + (255,))
    f = font("georgiab.ttf", 540)
    d.text((400, 480), "L", font=f, fill=BRASS + (255,), anchor="mm")
    # 概念：L 的横笔延伸成挂风铃的横杆，两根管从杆上垂下来（不与字母挤在一起）
    d.rounded_rectangle((500, 676, 830, 700), radius=12, fill=BRASS + (255,))
    for x in (596, 716):
        d.rounded_rectangle((x, 700, x + 32, 838), radius=10, fill=BRASS + (255,))
    d.line((660, 838, 660, 872), fill=CREAM + (255,), width=8)
    d.polygon([(660, 892), (626, 946), (694, 946)], fill=BRASS + (255,))
    return soften(im)


# ---------- B · Wordmark：全词 + 细线 ----------
def option_b():
    im, d = canvas(NAVY + (255,))
    f = font("georgiab.ttf", 250)
    spaced_text(d, (S / 2, 470), "Lynn", f, CREAM + (255,), spacing=26)
    d.line((190, 640, 400, 640), fill=BRASS + (255,), width=5)
    d.polygon([(512, 628), (528, 640), (512, 652), (496, 640)], fill=BRASS + (255,))
    d.line((624, 640, 834, 640), fill=BRASS + (255,), width=5)
    fs = font("calibrib.ttf", 44)
    spaced_text(d, (S / 2, 742), "A LYNN OF YOUR OWN", fs, BRASS + (255,), spacing=12)
    return soften(im)


# ---------- C · Glass：渐变 + 高光 + 光斑 ----------
def option_c():
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = base.load()
    for y in range(S):
        t = y / S
        r = int(NAVY2[0] * (1 - t) + 8 * t)
        g = int(NAVY2[1] * (1 - t) + 14 * t)
        b = int(NAVY2[2] * (1 - t) + 22 * t)
        for x in range(S):
            px[x, y] = (r, g, b, 255)
    # 右下黄铜光斑
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(18, 0, -1):
        a = int(4 * (19 - i))
        rr = i * 34
        gd.ellipse((S - 150 - rr, S - 120 - rr, S - 150 + rr, S - 120 + rr), fill=BRASS + (a,))
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    base = Image.alpha_composite(base, glow)
    # 顶部柔和高光（逐行渐隐，不用粗白弧）—— 参考 Big Sur 那类「深度层」而非描边
    hd = ImageDraw.Draw(base)
    for y in range(0, 300):
        a = int(34 * (1 - y / 300))
        hd.line((0, y, S, y), fill=(255, 255, 255, a))
    f = font("calibril.ttf", 280)
    hd.text((S / 2 + 4, 504), "Lynn", font=f, fill=(0, 0, 0, 90), anchor="mm")
    hd.text((S / 2, 498), "Lynn", font=f, fill=(246, 244, 238, 255), anchor="mm")
    hd.line((412, 690, 612, 690), fill=BRASS + (190,), width=6)
    return soften(rounded_base(base))


# ---------- D · Seal：印章徽记 ----------
def option_d():
    im, d = canvas(PAPER + (255,))
    # 双环
    d.ellipse((176, 176, 848, 848), outline=INK + (255,), width=12)
    d.ellipse((204, 204, 820, 820), outline=BRASS + (255,), width=4)
    f = font("georgiab.ttf", 430)
    d.text((S / 2, 520), "L", font=f, fill=INK + (255,), anchor="mm")
    fs = font("calibrib.ttf", 52)
    spaced_text(d, (S / 2, 280), "LYNN", fs, INK + (255,), spacing=20)
    for x in (462, 512, 562):
        d.ellipse((x - 8, 752, x + 8, 768), fill=BRASS + (255,))
    return soften(im)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    opts = [("A", "MONOGRAM", option_a()), ("B", "WORDMARK", option_b()), ("C", "GLASS", option_c()), ("D", "SEAL", option_d())]
    for key, _, im in opts:
        im.save(os.path.join(SHOTS, f"icon-option-{key}.png"))

    cell, pad, label = 340, 36, 46
    W = pad + cell * 2 + pad * 2 + pad
    H = pad + (cell + label) * 2 + pad
    board = Image.new("RGB", (W, H), (238, 239, 241))
    bd = ImageDraw.Draw(board)
    f = font("calibrib.ttf", 26)
    for i, (key, name, im) in enumerate(opts):
        col, row = i % 2, i // 2
        x = pad + col * (cell + pad * 2)
        y = pad + row * (cell + label + pad)
        thumb = im.resize((cell, cell), Image.LANCZOS)
        board.paste(thumb, (x, y), thumb)
        bd.text((x + 4, y + cell + 8), f"{key}  ·  {name}", font=f, fill=(45, 48, 52))
    board.save(os.path.join(SHOTS, "icon-options.png"))
    print("已生成 4 个方案 → shots/icon-option-{A,B,C,D}.png，对比图 shots/icon-options.png")


if __name__ == "__main__":
    main()
