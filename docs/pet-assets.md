# 桌宠素材规格（人形少女 · A 版短发定稿 v3）

> **这些素材不进仓库。** 57 张姿态 PNG 单张 300–500 KB、重画一次就 20 MB，塞进 git 会让历史迅速膨胀（实测占过 57 MB / 189 个版本）。仓库只留这份规格文档，图本身放在本地素材目录（默认 `assets/pet-dafeiyu/`，已 `.gitignore`）。
>
> 影响：新克隆的仓库**没有这些图**，`npm run build` 会在 `@pet/poses/alpha/*.png` 上失败（`src/renderer/desk/pet-assets.ts` 静态 import 它们）。要么从素材归档拷回 `assets/pet-dafeiyu/`，要么自己按下面的规格重画。

## 目录与文件

| 文件 / 目录 | 用途 |
|---|---|
| `poses/alpha/` | 透明 PNG（1080 高），19 姿态 × 正/侧/背 = 57 张，**运行时唯一依赖** |
| `anim-walk.webp` / `anim-blink.webp` | 循环动画（75 KB / 91 KB） |
| `pose-front-base.png` / `pose-side-base.png` / `pose-back-base.png` | image-to-image 锚点，生成新姿态拿它当参考 |
| `turnaround-girl-a-v3-short.png` | 三视图定稿（正/侧/背，等高同地面线） |
| `contact-alpha.png` | 19 姿态总览（浅底） |
| `poses/final/` | 白底统一画布（1080 高），改图从这里改 |
| `poses/export@1x` / `export@2x` | 高 240 / 480 的导出中间版（运行时用 `alpha`，不用它们） |
| `_gen/` | AI 生成原图堆 |
| `_diag/` | 抠图诊断图 |
| `_rejected/` | 弃用稿（各种 turnaround 试验） |
| `_old-long-hair/` | 上一版长发素材，反例备份，不要用它生成新图 |

## 角色规格

齐颈 short bob（深棕）、空气刘海、纤瘦长腿、白色打结短袖 T（腰前小扭结）、白色牛仔短裤、白球鞋、赛璐璐平涂 + 干净线稿。

生成 prompt 里必须固定 `SHORT dark brown chin-length bob hair`；**禁止** plump / chubby / round figure（会出小胖妹），也不要写 long hair。

## 19 个姿态

画布统一 `614×1080`，站立姿态脚底下沿对齐 y=1050，**同一缩放系数 1.0298**（体型不因姿势被拉伸）。
`sleep` 是唯一例外：原生成图被画成近景特写、头比别人大 1.5 倍，已单独缩到 `×0.67` 使头部尺寸与其余姿态一致。

| key | 中文 | 用途 |
|---|---|---|
| `idle` | 待机 | 默认状态，配 CSS 呼吸 |
| `blink` | 眨眼 | 随机 3–6s 插播 100ms |
| `happy` | 开心 | 任务完成、夸奖 |
| `wave` | 挥手 | 打招呼、唤醒 |
| `talk` | 说话 | 有气泡对话时 |
| `think` | 思考 | 推理中、等待中 |
| `sing` | 唱歌 | 音乐场景 |
| `heart` | 比心 | 用户表扬、好感度 |
| `sad` | 难过 | 失败、被打回 |
| `angry` | 生气 | 用户连续戳、被忽略 |
| `surprise` | 惊讶 | 新消息、被点名 |
| `tired` | 困倦 | 长时间无操作 |
| `poke` | 被戳 | 点击反馈（0.6s 后回 idle） |
| `sleep` | 睡觉 | 挂机 > 10min（抱膝坐，不是躺平） |
| `walk1/2/3` | 走路三帧 | contact-pass-contact 循环，脚底实测 1050/1049/1050 |
| `drag` | 被拎起 | 双臂上举合十、无奈表情，配合 CSS 上移 + 倾斜表示悬空 |
| `jump` | 跳 | 欢呼、强调 |

## 动效口径（重要：不要为这些做序列帧）

| 效果 | 做法 |
|---|---|
| 呼吸 | **CSS** `transform: scaleY(1.012)` + 上下浮动 1.5px，3.2s 循环 |
| 眨眼 | 两张图切换，间隔随机 3–6s，闭眼只留 100ms |
| 走路 | `walk1→walk2→walk3→walk2` 四拍循环，130/120/130/120ms |
| 走路位移 | **速度 = 步频 × 步幅**，否则会滑步 |
| 落地 | squash & stretch：`scaleY(0.92) scaleX(1.06)` → 150ms 回弹 |
| 拖拽 | 朝指针方向倾斜 ≤12°，松手按重力下落 |
| 呼吸/眨眼以外的小动作 | 一律 CSS，不生成新图 |

## 抠图口径（踩过坑，别改）

`cv2.floodFill` 四角 + 容差 10 → 只在 `gray>=220` 处受控蔓延（遇线稿自动停）→ 高斯羽化。**不要填洞**：`findContours + drawContours` 会把两腿之间的缝补成白竖条；**不要行扫描补夹缝**：会把白 T 恤的褶皱白条一起吃掉，角色变斑马；容差调到 32 会直接穿透淡线稿。角色完整优先。

## 已知瑕疵

- `sleep` 周围在深色背景下有一点淡白边，浅色桌面不可见。
- `drag` 是静态「被举起」姿势，悬空感靠 CSS 上移实现，图本身没有画手。

## 打包

`electron-builder.yml` 打包 `assets/**/*`，用的是**本地**素材目录，所以安装包里照样有形象。仓库不含图只影响别人克隆后的构建，不影响本机打包。
