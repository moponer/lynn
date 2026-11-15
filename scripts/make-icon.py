#!/usr/bin/env python3
"""生成正式应用图标：干净的 Lynn 字标（项目 Archivo 字体 + 项目 token 色）。

设计纪律（2026-11-15 重做）：
  * 只用 dispatch.css 的真实 token：底 --desk #0a0d0f、字 --ink #e6ebee、
    小尺寸首字母 --blue #6fa892（结构色）。不再自编暖色，不把预算色 --brass 当品牌色。
  * 字体用项目 --f-display 指定的 Archivo（wght=700，由 woff2 实例化而来），
    不再用系统 Georgia 冒充字标设计。
  * 不做变形 L、不加细线/菱形/tagline —— 画面上只有字标与底色。
  * 小尺寸（≤64px）只留首字母 L，保证 16px 任务栏可读。

输出：
    assets/icon-1024.png / assets/icon.png / build/icon.png
    build/icon.ico          16/24/32/48/64/128/256 七帧（手写多帧，逐帧换图案）
    assets/tray.png         16×16 托盘图
    src/main/tray-icon.ts   同步内嵌 base64 兜底（否则运行时回退旧图）

依赖：Pillow + fontTools(+brotli)。首次运行需先生成 assets/fonts/archivo-700.ttf，
     见 README / 脚本内 ensure_font()。不进构建链，只在重做图标时手动跑。
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import base64
import io
import os
import re
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
ASSETS = os.path.join(ROOT, "assets")
FONT_TTF = os.path.join(ASSETS, "fonts", "archivo-700.ttf")
FONT_WOFF2 = os.path.join(ROOT, "node_modules", "@fontsource-variable", "archivo", "files", "archivo-latin-wght-normal.woff2")
TRAY_ICON_TS = os.path.join(ROOT, "src", "main", "tray-icon.ts")
S = 1024

DESK = (10, 13, 15)      # --desk
INK = (230, 235, 238)    # --ink
BLUE = (111, 168, 146)   # --blue


def ensure_font():
    if os.path.exists(FONT_TTF):
        return
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    if not os.path.exists(FONT_WOFF2):
        raise SystemExit(f"缺 Archivo 字体：{FONT_WOFF2}")
    f = TTFont(FONT_WOFF2)
    g = instantiateVariableFont(f, {"wght": 700}, inplace=False)
    os.makedirs(os.path.dirname(FONT_TTF), exist_ok=True)
    g.save(FONT_TTF)


def font(size):
    return ImageFont.truetype(FONT_TTF, size)


def base():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, S - 1, S - 1), radius=232, fill=DESK + (255,))
    return im


def wordmark():
    im = base()
    d = ImageDraw.Draw(im)
    f = font(300)
    # Archivo 的 mm 锚点按字体中线算，墨迹视觉重心略偏上；下移一点才是真的居中
    d.text((S / 2, S / 2 + 16), "Lynn", font=f, fill=INK + (255,), anchor="mm")
    return im


def monogram():
    im = base()
    d = ImageDraw.Draw(im)
    d.text((S / 2 + 14, S / 2 + 18), "L", font=font(620), fill=BLUE + (255,), anchor="mm")
    return im


def scaled(im, n):
    out = im.resize((n, n), Image.LANCZOS)
    if n <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=110, threshold=2))
    return out


def write_ico(frames, path):
    header = struct.pack("<HHH", 0, 1, len(frames))
    entries = b""
    blobs = b""
    offset = 6 + 16 * len(frames)
    for n, im in frames:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blob = buf.getvalue()
        dim = 0 if n >= 256 else n
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + entries + blobs)


def tray_png():
    """16×16 托盘图：先在 64 画布画好再缩小，避免直接画 16px 糊掉"""
    n = 64
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=14, fill=DESK + (255,))
    d.text((n / 2, n / 2), "L", font=font(48), fill=BLUE + (255,), anchor="mm")
    return im.resize((16, 16), Image.LANCZOS)


def sync_tray_fallback(png_path):
    """同步 tray-icon.ts 的内嵌 base64 兜底 —— 不同步就会在运行时回退到旧图"""
    data = base64.b64encode(open(png_path, "rb").read()).decode("ascii")
    src = open(TRAY_ICON_TS, "r", encoding="utf-8").read()
    new, n = re.subn(
        r'(export const TRAY_PNG_BASE64\s*=\s*\n?\s*")[^"]+(")',
        lambda m: m.group(1) + data + m.group(2),
        src,
        count=1,
    )
    if n != 1:
        raise SystemExit("tray-icon.ts 里没找到 TRAY_PNG_BASE64，兜底没同步")
    open(TRAY_ICON_TS, "w", encoding="utf-8", newline="\n").write(new)


def main():
    ensure_font()
    os.makedirs(BUILD, exist_ok=True)
    full, mini = wordmark(), monogram()

    full.save(os.path.join(ASSETS, "icon-1024.png"))
    big = scaled(full, 512)
    big.save(os.path.join(ASSETS, "icon.png"))
    big.save(os.path.join(BUILD, "icon.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    write_ico([(n, scaled(mini if n <= 64 else full, n)) for n in sizes], os.path.join(BUILD, "icon.ico"))

    tray_path = os.path.join(ASSETS, "tray.png")
    tray_png().save(tray_path)
    sync_tray_fallback(tray_path)

    print("ICO 帧：", sorted(Image.open(os.path.join(BUILD, "icon.ico")).ico.sizes()))
    src = open(TRAY_ICON_TS, "r", encoding="utf-8").read()
    embedded = re.search(r'TRAY_PNG_BASE64\s*=\s*\n?\s*"([^"]+)"', src)
    expected = base64.b64encode(open(tray_path, "rb").read()).decode("ascii")
    print("托盘 16×16 与 base64 兜底一致：", bool(embedded) and embedded.group(1) == expected)
    print("色：", "底 #0a0d0f / 字 #e6ebee / 小尺寸 #6fa892；字体 Archivo 700")


if __name__ == "__main__":
    main()
