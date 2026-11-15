#!/usr/bin/env python3
"""生成正式应用图标：方案 A「切角撑满」——把 L 当图形做，不是排版字体。

设计（2026-11-15 定稿）：
  * 所有外凸角统一 45° 切角，字母撑到版面边缘；内凹角不切（保持 L 的结构）
  * 只用项目 token：底 --desk #0a0d0f、形 --ink #e6ebee。零功能色——
    黄铜是预算语义、青瓷是结构语义，都不该拿去当品牌主色。
  * 小尺寸（≤64px）单独一版：切角比例放大到 10%、笔画加粗、留白收窄，
    否则 16px 缩下去切角会糊成直角、笔画会发虚。

输出：
    assets/icon-1024.png / assets/icon.png / build/icon.png
    build/icon.ico        16/24/32/48/64/128/256 七帧（手写多帧，逐帧换版式）
    assets/tray.png       16×16 托盘图
    src/main/tray-icon.ts 同步内嵌 base64 兜底

依赖：只要 Pillow。不进构建链，重做图标时手动跑。
"""
from PIL import Image, ImageDraw, ImageFilter
import base64
import io
import os
import re
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
ASSETS = os.path.join(ROOT, "assets")
TRAY_ICON_TS = os.path.join(ROOT, "src", "main", "tray-icon.ts")

S = 2048          # 4× 超采样
R = 464           # 圆角（与旧版同比例）
DESK = (10, 13, 15)
INK = (230, 235, 238)


def canvas(radius=R):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, S - 1, S - 1), radius=radius, fill=DESK + (255,))
    return im


def glyph(d, L, T, Rt, B, stem, foot, c, fill=INK):
    """切角 L：外凸角切 45°，内凹角（stem, foot）不切"""
    d.polygon(
        [
            (L + c, T),          # 顶边（左上切角之后）
            (stem, T),           # 竖笔右侧、顶
            (stem, foot - c),    # 内凹角之上
            (stem + c, foot),    # 内凹角：直接斜过去，不切
            (Rt, foot),          # 横笔上沿、右
            (Rt, foot + c),      # 右下切角起点
            (Rt - c, B),         # 右下切角
            (L + c, B),          # 底边
            (L, B - c),          # 左下切角
            (L, T + c),          # 左上切角
        ],
        fill=fill + (255,),
    )


def full():
    """大尺寸：撑满但留一圈呼吸（约 14%），切角 110/2048 ≈ 5.4%"""
    im = canvas()
    glyph(ImageDraw.Draw(im), L=300, T=280, Rt=1830, B=1770, stem=640, foot=1440, c=110)
    return im


def mini():
    """小尺寸：切角放大到 200/2048 ≈ 10%，笔画加粗、留白收窄，16px 才认得出"""
    im = canvas(radius=380)
    glyph(ImageDraw.Draw(im), L=200, T=190, Rt=1870, B=1860, stem=720, foot=1430, c=200)
    return im


def scaled(im, n):
    out = im.resize((n, n), Image.LANCZOS)
    if n <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=2))
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
    """托盘：直接用 mini 版缩到 16×16（同一套形状，不另设计）"""
    return scaled(mini(), 16)


def sync_tray_fallback(png_path):
    data = base64.b64encode(open(png_path, "rb").read()).decode("ascii")
    src = open(TRAY_ICON_TS, "r", encoding="utf-8").read()
    new, n = re.subn(
        r'(export const TRAY_PNG_BASE64\s*=\s*\n?\s*")[^"]+(")',
        lambda m: m.group(1) + data + m.group(2),
        src,
        count=1,
    )
    if n != 1:
        raise SystemExit("tray-icon.ts 里没找到 TRAY_PNG_BASE64")
    open(TRAY_ICON_TS, "w", encoding="utf-8", newline="\n").write(new)


def main():
    os.makedirs(BUILD, exist_ok=True)
    big, small = full(), mini()

    big.resize((1024, 1024), Image.LANCZOS).save(os.path.join(ASSETS, "icon-1024.png"))
    mid = scaled(big, 512)
    mid.save(os.path.join(ASSETS, "icon.png"))
    mid.save(os.path.join(BUILD, "icon.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    write_ico([(n, scaled(small if n <= 64 else big, n)) for n in sizes], os.path.join(BUILD, "icon.ico"))

    tray_path = os.path.join(ASSETS, "tray.png")
    tray_png().save(tray_path)
    sync_tray_fallback(tray_path)

    src = open(TRAY_ICON_TS, "r", encoding="utf-8").read()
    embedded = re.search(r'TRAY_PNG_BASE64\s*=\s*\n?\s*"([^"]+)"', src)
    expected = base64.b64encode(open(tray_path, "rb").read()).decode("ascii")
    print("ICO 帧：", sorted(Image.open(os.path.join(BUILD, "icon.ico")).ico.sizes()))
    print("托盘与 base64 兜底一致：", bool(embedded) and embedded.group(1) == expected)
    print("色：底 #0a0d0f / 形 #e6ebee；零功能色")


if __name__ == "__main__":
    main()
