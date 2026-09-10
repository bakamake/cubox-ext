#!/usr/bin/env python3
"""由 Cubox 官方 logo 生成 Material You 风格扩展图标。

管线：底板剔除（边缘 flood fill）→ 亮度归一化 tonal 量化（单 Monet
色相 ramp 的不同明度档，色相由色彩系统统一保证）→ 众数滤波轮廓清理
→ 标签投票渲染（消除高明度差振铃缝隙）→ squircle 容器。
用法：python3 tools/gen_icon.py
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "assets", "cubox_logo_src.png")
OUT = os.path.join(HERE, "..", "public", "icon")
MASTER = 1024  # 超采样母版尺寸（决定覆盖率量化精度：1024/128 = 每轴 8 档）

# Monet tonal palette（HCT 的 LCh 近似实现）：
# 由任意种子色生成单色相 tone 阶梯——固定色相 H，色度 C 随 tone 向两端衰减，
# 明度 L 取 tone 值（0=黑，100=白），超 gamut 时按比例压缩 C 回 sRGB。
EYE_WHITE = (0xFF, 0xFF, 0xFF)  # 明度轴白端点

_XYZ_WHITE = np.array([0.95047, 1.0, 1.08883])
_M_RGB_XYZ = np.array([
    [0.4124, 0.3576, 0.1805],
    [0.2126, 0.7152, 0.0722],
    [0.0193, 0.1192, 0.9505],
])


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 0) ** (1 / 2.4) - 0.055)


def rgb_to_lch(rgb01: np.ndarray) -> tuple[float, float, float]:
    """sRGB(0~1) → CIELCh：返回 L(0~100)、C、H(弧度)。"""
    xyz = _srgb_to_linear(np.asarray(rgb01)) @ _M_RGB_XYZ.T / _XYZ_WHITE
    f = np.where(xyz > 0.008856, xyz ** (1 / 3), 7.787 * xyz + 16 / 116)
    L = 116 * f[1] - 16
    a = 500 * (f[0] - f[1])
    b = 200 * (f[1] - f[2])
    return float(L), float(np.hypot(a, b)), float(np.arctan2(b, a))


def _lch_to_rgb_uncapped(L: float, C: float, H: float) -> np.ndarray:
    a, b = C * np.cos(H), C * np.sin(H)
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200

    def finv(f: np.ndarray) -> np.ndarray:
        return np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787)

    xyz = np.array([finv(fx), finv(fy), finv(fz)]) * _XYZ_WHITE
    return _linear_to_srgb(xyz @ np.linalg.inv(_M_RGB_XYZ).T)


def lch_to_rgb(L: float, C: float, H: float) -> tuple[int, int, int]:
    """CIELCh → sRGB(0~255)，超 gamut 时二分压缩 C。"""
    lo, hi = 0.0, C
    for _ in range(12):
        mid = (lo + hi) / 2
        rgb = _lch_to_rgb_uncapped(L, mid, H)
        if np.all((rgb >= -1e-6) & (rgb <= 1 + 1e-6)):
            lo = mid  # mid 可行，尝试更大色度
        else:
            hi = mid
    rgb = np.clip(_lch_to_rgb_uncapped(L, lo, H), 0, 1)
    return tuple(int(round(v * 255)) for v in rgb)


def chroma_factor(tone: int) -> float:
    """色度曲线：峰值在 tone≈55，向明暗两端衰减（近白/近黑档低彩度）。"""
    return max(0.15, 1 - abs(tone - 55) / 65)


def tonal_ramp(seed_rgb: tuple[int, int, int], tones=(30, 40, 70, 90)) -> dict[int, tuple[int, int, int]]:
    """由种子色生成单色相 tone 阶梯。"""
    _, C0, H = rgb_to_lch(np.array(seed_rgb) / 255.0)
    return {t: lch_to_rgb(t, C0 * chroma_factor(t), H) for t in tones}


def keep_largest(mask: np.ndarray, k: int = 2) -> np.ndarray:
    """保留面积最大的 k 个连通域（BFS 标记，剔除表面高光等孤立小斑点）。"""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    sizes: list[tuple[int, list[tuple[int, int]]]] = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        stack, comp = [(int(y), int(x))], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            comp.append((cy, cx))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        sizes.append((len(comp), comp))
    out = np.zeros_like(mask)
    for _, comp in sorted(sizes, key=lambda t: -t[0])[:k]:
        for y, x in comp:
            out[y, x] = True
    return out


def segment(src: Image.Image) -> np.ndarray:
    """语义分区：0 背景 / 1 瞳孔 / 2 身体 / 3 皇冠 / 4 眼白。

    源图色度分布（实测）：底板为亮蓝圆角方板（lum 0.33~0.60、偏蓝），
    身体为深藏青（lum≈0.10），皇冠为亮黄（lum≈0.65），眼白高亮低饱和，
    瞳孔位于眼白内部。底板按色度判据剔除（几何判据不适用：身体横向
    延伸与画布左右边缘相接）。单色相 tonal 量化：身体/皇冠不分色相，
    按亮度归一化映射到同一 ramp 的低/高明度档，源图渐变边缘自然落到
    相邻档。
    """
    a = np.asarray(src).astype(np.float64) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    alpha = a[..., 3]
    mx = a[..., :3].max(-1)
    mn = a[..., :3].min(-1)
    sat = (mx - mn) / (mx + 1e-9)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

    solid = alpha > 0.5
    plate = solid & (b - r > 0.30) & (lum > 0.25)  # 亮蓝底板 → 背景

    mascot = solid & ~plate
    eye = keep_largest(mascot & (lum > 0.70) & (sat < 0.40), k=2)
    # 瞳孔：仅认眼白核心（先腐蚀排除黑色描线边）内部的暗像素，
    # 原图的眼边/描线暗像素一律归身体色，避免残留黑色线条
    eye_core = np.asarray(
        Image.fromarray((eye * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))
    ) > 0
    eye_zone = np.asarray(
        Image.fromarray((eye_core * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
    ) > 0
    pupil = mascot & eye_zone & (lum < 0.35) & ~eye

    # 亮度归一化到 [0,1]（p2/p98 抗离群），中位阈值二分身体/皇冠两档
    rest = mascot & ~eye & ~pupil
    lo, hi = np.percentile(lum[rest], 2), np.percentile(lum[rest], 98)
    t = np.clip((lum - lo) / (hi - lo + 1e-9), 0, 1)
    crown = rest & (t > 0.5)

    label = np.zeros(src.size[::-1], dtype=np.uint8)
    label[rest & ~crown] = 2
    label[crown] = 3
    label[eye] = 4
    label[pupil] = 1
    return label


def mode_cleanup(label_img: Image.Image, size: int = 7) -> Image.Image:
    """众数滤波：等效形态学开/闭组合，去毛刺填孔洞，平滑分区轮廓。"""
    return label_img.filter(ImageFilter.ModeFilter(size=size))


def squircle_mask(size: int, radius_ratio: float = 0.28) -> Image.Image:
    """Material You 容器：圆角矩（squircle 近似）。"""
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return m


def render(
    label: np.ndarray,
    ramp: dict[int, tuple[int, int, int]],
    size: int,
) -> Image.Image:
    """按输出尺寸逐像素投票渲染：每像素取覆盖采样的主导分区纯色，
    覆盖率进 alpha。避免对多色平涂图直接重采样产生的高明度差振铃缝隙。"""
    palette = np.array([
        (0, 0, 0),
        ramp[30],       # 瞳孔（暗档，色值匹配第二遍：不上明度轴端点，
                        # 避免眼白与近黑直接相邻形成硬描线）
        ramp[40],       # 身体
        ramp[70],       # 皇冠（同 ramp 高明度档）
        EYE_WHITE,      # 眼白
    ], dtype=np.uint8)
    src_n = label.shape[0]
    f = src_n // size  # 每输出像素对应的超采样边长
    blocks = label[: size * f, : size * f].reshape(size, f, size, f)
    counts = np.stack([(blocks == c).sum(axis=(1, 3)) for c in range(5)], axis=-1)
    solid = counts[..., 1:].sum(-1)
    dominant = counts[..., 1:].argmax(-1) + 1
    rgb = palette[dominant]
    alpha = np.where(solid > 0, np.clip(solid / (f * f) * 255, 0, 255), 0).astype(np.uint8)
    icon = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
    bg = Image.new("RGBA", (size, size), (*ramp[90], 255))
    bg.paste(icon, (0, 0), icon)
    bg.putalpha(squircle_mask(size))
    return bg


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    src = src.crop(src.getbbox())

    # 种子色取底板亮蓝的中位色（高彩度保证 ramp 全档可辨识）；
    # 身体/皇冠/容器共用同一色相，仅由色彩系统分配明度档
    a = np.asarray(src).astype(np.float64) / 255.0
    r, b = a[..., 0], a[..., 2]
    lum = 0.2126 * r + 0.7152 * a[..., 1] + 0.0722 * b
    solid = a[..., 3] > 0.5
    vivid = solid & (b - r > 0.30) & (lum > 0.30) & (lum < 0.70)
    seed = tuple(int(v) for v in np.median(a[vivid][:, :3] * 255, axis=0).astype(int)) if vivid.any() else (0x4C, 0x6F, 0xE7)
    ramp = tonal_ramp(seed)
    print("ramp ->", {t: "#%02X%02X%02X" % c for t, c in ramp.items()})

    # 分区在放大后的标签图上进行（超采样），保证小尺寸轮廓质量
    label = Image.fromarray(segment(src)).resize((MASTER, MASTER), Image.NEAREST)
    label = mode_cleanup(label, size=5)

    # 内容在标签层面居中缩放（保持分区纯度，不做彩色重采样）
    bbox = label.point(lambda v: 255 if v else 0).getbbox()
    if bbox:
        label = label.crop(bbox)
    inner = int(MASTER * 0.56)
    scale = min(inner / label.width, inner / label.height)
    label = label.resize(
        (max(1, int(label.width * scale)), max(1, int(label.height * scale))), Image.NEAREST)
    placed = Image.new("L", (MASTER, MASTER), 0)
    placed.paste(label, ((MASTER - label.width) // 2, (MASTER - label.height) // 2))
    label = placed

    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128):
        render(np.asarray(label), ramp, s).save(os.path.join(OUT, f"{s}.png"))
        print("saved", s)


if __name__ == "__main__":
    main()
