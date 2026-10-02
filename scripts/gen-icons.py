"""btn-locker の南京錠アイコン (public/icon/*.png) を生成する。

使い方: python3 scripts/gen-icons.py   (要 Pillow)

1024px で描画してから各サイズへ縮小する。Chrome Web Store の推奨に合わせ、
128px 換算で実寸 96px 前後＋四辺 16px の透過余白に収める。
ref: https://developer.chrome.com/docs/webstore/images
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "icon"
SIZES = (16, 32, 48, 96, 128)

BASE = 1024
K = BASE / 128  # 128px 座標系 → 描画座標系

BODY = (255, 149, 0, 255)  # #ff9500 (ロック表示の枠色と統一)
SHACKLE = (184, 95, 0, 255)  # #b85f00
KEYHOLE = (255, 255, 255, 255)


def s(v: float) -> int:
    return round(v * K)


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # シャックル（つる）: 中心 (64, 46)、半径 22、線幅 13 の U 字
    cx, cy, r, w = 64, 46, 22, 13
    d.arc((s(cx - r), s(cy - r), s(cx + r), s(cy + r)), 180, 360, fill=SHACKLE, width=s(w))
    # arc は外周基準で線を内側に描くため、脚も同じ範囲 (外周 r 〜 r-w) に合わせる
    for x0 in (cx - r, cx + r - w):
        d.rectangle((s(x0), s(cy), s(x0 + w) - 1, s(62)), fill=SHACKLE)

    # 本体
    d.rounded_rectangle((s(22), s(56), s(106), s(114)), radius=s(14), fill=BODY)

    # 鍵穴
    d.ellipse((s(64 - 9), s(78 - 9), s(64 + 9), s(78 + 9)), fill=KEYHOLE)
    d.polygon([(s(59), s(80)), (s(69), s(80)), (s(67), s(99)), (s(61), s(99))], fill=KEYHOLE)
    return img


def main() -> None:
    master = draw_master()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        master.resize((size, size), Image.Resampling.LANCZOS).save(OUT_DIR / f"{size}.png")
        print(f"wrote public/icon/{size}.png")


if __name__ == "__main__":
    main()
