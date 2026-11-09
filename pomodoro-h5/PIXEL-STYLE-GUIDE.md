# 像素风格制作方法调研（Web 前端）

> 背景：番茄钟 H5 已有独立「像素版」入口（`pixel.html` + `pixel.css` + `src/pixel/pixel.js`，
> 测试 25/25、双 Approved、已同步规范树）。本文把"像素风格在 Web 端怎么做"拆成可落地的技法，
> 并逐条对照我们像素版的真实实现，作为方法范本。

## 一、像素风的核心视觉特征
1. **硬边**：无抗锯齿、无模糊——这是和"卡通/拟物"最本质的区别。
2. **有限调色板**：8-bit 风，深色背景 + 少量高饱和强调色。
3. **方块感**：全局直角（`border-radius:0`）、实线描边、零模糊的硬投影。
4. **像素字体 / 等宽字体**：数字与文字呈现"由方格组成"的观感。

## 二、Web 端实现技法（按落地成本从低到高）

### 1. `image-rendering: pixelated` —— 位图缩放保留硬边
- 作用：把放大的位图（png/svg 栅格）按最近邻缩放，不糊成渐变边。[MDN: image-rendering](https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering)
- 我们：`body` 与 `.px-clock` 都设了 `image-rendering: pixelated`（`pixel.css:42`、`pixel.css:81`）。
- ⚠ 易误解：它**只影响位图缩放**，对 box-shadow / 纯 CSS 绘制无效；硬边感主要靠"无模糊投影 + 直角"实现。

### 2. 直角 + 硬投影（`box-shadow` 无模糊半径）
- 8-bit 的标志：投影是"偏移的实心方块"，不是柔和阴影。
- 我们：`--shadow: 4px 4px 0 0 var(--line)`（`pixel.css:30`），第 4 个值 `0` = 模糊半径 0。
- 对照卡通版：`0 8px 18px rgba(58,46,46,.16)`（柔影）——同项目两版靠这一行就拉开画风。

### 3. 像素数字：纯 CSS `box-shadow` 点阵（我们的主力技法）
- 做法：基元素透明，仅用 `box-shadow` 在 3×5 网格上"点亮"格子；每个数字（0-9 + 冒号）一套 `box-shadow`，切数字只改 `.px-cell` 的 `data-d`。
- 我们：`pixel.css:87-142`，0-9 + `:` 共 12 组，每组约 11 个阴影（`--px:12px` 为单元格尺寸）。
- 零外部字体、零图片、可离线——这是它相对其他方案的最大优势。
- 替代方案对比：
  | 方案 | 依赖 | 离线 | 可维护性 | 备注 |
  |---|---|---|---|---|
  | box-shadow 点阵（我们） | 无 | ✅ | 中（重复高，靠生成） | 最轻量 |
  | 像素 webfont（Press Start 2P 等） | CDN/授权 | ❌ | 高 | 破坏离线、有版权 |
  | canvas 逐像素绘制 | 无 | ✅ | 低（JS 重绘） | 适合复杂插画/动画 |
  | CSS Houdini Paint API | Chromium only | ✅ | 高 | 仅新版 Chromium |
  | SVG 点阵 | 无 | ✅ | 中 | 矢量可缩放 |

### 4. 系统等宽字体栈模拟像素感
- 我们：`font-family: ui-monospace, "Courier New", Consolas, monospace`（`pixel.css:38`），
  不引外链；`letter-spacing:.5px` 增强方块间距感。

### 5. 全局 `border-radius: 0`
- 我们：`pixel.css:29` 的 `--border:3px` 是描边粗细；所有面板/按钮均直角（对比卡通 24-28px 大圆角）。

### 6. 交互的"步进"动效（8-bit 按钮手感）
- 我们：`.px-btn` 用 `transition: transform .04s steps(2)`（`pixel.css:159`）做离散跳变；
  `:hover` 抬起 `translate(-2px,-2px)` + 投影变大、`:active` 按下 `translate(2px,2px)`、`:disabled` 去投影降透明（`pixel.css:163-170`）。
- 关键：位移与投影变化都是**整数像素**，保持硬边，不出现亚像素柔化。

### 7. 限定调色板 + 对比度
- 我们：`--bg #14182b` / `--panel #2b3a67` / `--primary #c0392b`(白字 5.44:1) / `--break #1e7d34`(白字 5.17:1)（`pixel.css:19-28`），满足正文对比度。

### 8. 移动端像素化适配
- 我们：`100dvh` + `safe-area-inset-*`（`pixel.css:43,52`）、`touch-action:manipulation` 去点击延迟（`pixel.css:41`）、触控 ≥ `48px`（`--tap`）、`image-rendering:pixelated`。

## 三、像素版 vs 卡通版（同项目对照，证明"画风靠少数变量决定"）
| 维度 | 像素版 | 卡通版 |
|---|---|---|
| 投影 | `4px 4px 0 0` 硬边 | `0 8px 18px` 柔影 |
| 圆角 | `0` | `24–28px` |
| 数字 | box-shadow 点阵 | 系统圆体 + 白描边 |
| 字体 | 等宽栈 | 圆体粗体栈 |
| 错误态色 | 休息绿（照 Designer 规范） | 红系 |

## 四、实现中的坑 / 已知项
- `src/pixel/pixel.js` 原有 `notifyDone()` 调 `Notification` 但**从未** `requestPermission` → 通知恒不弹（死代码）；已在本次清理移除，与卡通版口径一致（均不抄该死代码）。
- 每个数字一套 `box-shadow` 重复度高（12 组），维护靠代码生成；未来若要加字母需扩展。
- `image-rendering` 不影响 CSS 绘制（常见误解），硬边感来自无模糊投影 + 直角。

## 五、从零做像素风的方法选型建议
- **纯展示 + 零依赖 + 离线** → box-shadow 点阵 + 系统等宽栈（我们的方案，推荐起步）。
- **要真实像素字体** → 引 Press Start 2P（牺牲离线与授权）。
- **复杂像素插画 / 游戏动画** → canvas 或 SVG sprite + `image-rendering:pixelated`。
- **主题可换色** → 用 CSS 变量（我们已用 `--digit/--line/--primary` 等，换色不碰 box-shadow）。

## 六、结论
像素风在 Web 端**不需要任何图片或外部字体**即可高保真落地：核心三件套是
① `border-radius:0` + `box-shadow` 零模糊硬投影、② `image-rendering:pixelated`、③ 系统等宽栈 / box-shadow 点阵数字。
我们的像素番茄钟就是这套方法的完整范本，可直接作为团队内"像素风实现规范"复用。
