# 图标生成数学推导（public/icon/MATH.md）

本文档对应 `tools/gen_icon.py` 的全部数学内容：CIELCh 色彩空间、
tonal ramp 生成、色度衰减曲线、超 gamut 压缩、亮度归一化与投票渲染。
实现均为 numpy 向量化，无第三方图像算法库依赖。

## 1. sRGB 与 CIELCh 互转

### 1.1 sRGB → 线性 RGB

sRGB 编码值先做 gamma 解码（IEC 61966-2-1 分段函数）：

```
c_lin = c / 12.92                          , c ≤ 0.04045
c_lin = ((c + 0.055) / 1.055)^2.4          , c > 0.04045
```

### 1.2 线性 RGB → CIEXYZ

矩阵乘法（D65 白点归一）：

```
[ X ]   [ 0.4124  0.3576  0.1805 ] [ R ]
[ Y ] = [ 0.2126  0.7152  0.0722 ] [ G ]
[ Z ]   [ 0.0193  0.1192  0.9505 ] [ B ]

X /= 0.95047,  Y /= 1.0,  Z /= 1.08883   （D65 白点）
```

### 1.3 CIEXYZ → CIELAB

对每分量施加 f 变换，三分段处理低亮度线性段：

```
f(q) = q^(1/3)                    , q > 0.008856
f(q) = 7.787·q + 16/116           , q ≤ 0.008856

L = 116·f(Y) − 16
a = 500·(f(X) − f(Y))
b = 200·(f(Y) − f(Z))
```

### 1.4 CIELAB → CIELCh（极坐标）

```
C = √(a² + b²)
H = atan2(b, a)                   （弧度，本文所有色相运算在 H 上进行）
```

逆向（LCh → XYZ）即上述步骤严格逆变换：由 L 反解 f(Y)，由 a、b 反解
f(X)、f(Z)，再做 f 逆变换回 XYZ，最后乘白点并左乘 RGB←XYZ 逆矩阵，
线性值按 sRGB 编码分段函数回编码值。

## 2. Tonal ramp 生成（Monet 阶梯）

Material You 的 Monet 取色可近似为 HCT（Hue-Chroma-Tone）：固定色相
H，沿明度轴 T 取色，色度随明度向两端衰减。

给定种子色 (r, g, b)，先转 LCh 取 (L₀, C₀, H₀)。对目标 tone t
（0=黑，100=白）：

```
L(t) = t
C(t) = C₀ · chroma_factor(t)
color(t) = LCh→sRGB(L(t), C(t), H₀)
```

### 色度衰减曲线

```
chroma_factor(t) = max(0.15, 1 − |t − 55| / 65)
```

峰值在 tone≈55，向明暗两端线性衰减，下限 0.15 保证近白/近黑档仍带
可辨识的色相偏移（Monet 容器的特征）。

## 3. 超 gamut 色度压缩

CIELCh 坐标直接转回 sRGB 可能越界（RGB 分量超出 [0,1]）。处理：
固定 L 与 H，在 C ∈ [0, C₀] 上二分 12 次——若中点 C 转换后全部分量
落在 [0,1]，下界上移，否则上界下移。收敛后取可行最大色度。该近似
误差 < 2⁻¹² 量级，对图标色块不可感知。

## 4. 亮度归一化与 tonal 量化

源图身体（lum≈0.10）与皇冠（lum≈0.65）亮度双峰分布。对实体像素：

```
lo, hi  = percentile(lum[S], 2), percentile(lum[S], 98)   （p2/p98 抗离群）
t(x)    = clip((lum(x) − lo) / (hi − lo), 0, 1)           （归一化到 [0,1]）
crown   = { x : t(x) > 0.5 }        → tone 70
body    = { x : t(x) ≤ 0.5 }        → tone 40
pupil   = { x ∈ eye_zone : lum < 0.35 }  → tone 30（暗档，非明度轴端点：
                                          避免与纯白眼白直接相邻形成硬描线）
eye     = { x : lum > 0.70, sat < 0.40 } → 纯白（仅保留最大 2 连通域）
```

p2/p98 分位数裁剪可吞掉个别高光/阴影离群像素，避免归一化区间被极端
值拉宽导致主体两档对比度不足。

## 5. 众数滤波（轮廓清理）

对标签图施加 ModeFilter(size=5/7)：每像素取其邻域窗口内出现次数
最多的标签。等效于形态学开/闭组合（先去小毛刺再填小孔洞），平滑
分区轮廓而不引入新标签。

## 6. 标签投票渲染（抗振铃）

多色平涂图直接 LANCZOS 重采样，会在高明度差硬边界产生 Gibbs 现象
（过冲/欠冲），表现为黑/白色细缝。改用投票渲染：

设超采样母版边长 N=1024，输出边长 s ∈ {16, 32, 48, 128}，每输出
像素对应 f = N/s 的 f×f 采样块。

```
counts[c]   = #{ 块内标签 = c },  c ∈ {0..4}
solid       = Σ counts[c],  c ≥ 1
dominant    = argmax counts[c],  c ≥ 1
alpha       = solid / f² · 255          （覆盖率进 alpha，边缘自然抗锯齿）
rgb         = palette[dominant]         （纯色调色板，无插值）
```

每输出像素只取主导分区的纯色，块内不存在跨色插值，振铃失去产生
条件；alpha 由覆盖率给出，轮廓平滑。

## 7. Squircle 容器

Material You 容器为圆角矩形（squircle 近似），圆角半径取边长的
28%：

```
mask = rounded_rect([0,0,s−1,s−1], r = 0.28·s)
```

容器底色取 ramp 最高档 tone 90，主体贴入后整体乘以 mask alpha。

## 8. 参数索引

| 参数 | 值 | 位置 |
| --- | --- | --- |
| MASTER | 1024 | 超采样母版边长 |
| 圆角比 | 0.28 | squircle_mask |
| 底板判据 | b−r > 0.30 且 lum > 0.25 | segment |
| 眼白判据 | lum > 0.70 且 sat < 0.40，keep_largest(k=2) | segment |
| 瞳孔判据 | eye_zone 内 lum < 0.35 | segment |
| 归一化分位 | p2 / p98 | segment |
| 身体/皇冠阈值 | t = 0.5 | segment |
| ramp 档位 | 30 / 40 / 70 / 90 | tonal_ramp / render |
| 众数滤波窗口 | 5 | mode_cleanup |
| 内容占比 | 0.56 | main |
