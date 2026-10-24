/**
 * 关系图谱力学的**唯一参数来源**（2026-10-24）。
 *
 * 为什么单独一个文件：这套参数此前有**两份手抄**——
 *   · `lib/graphPage.js` 的 `GRAPH_SCRIPT`（独立页 `/x/kb/graph`）
 *   · `lib/client.js` 的 `KbGraph`（工作台面板内的 canvas）
 * 两处数值一旦分叉，同一个库在两个入口的画布上会呈现完全不同的形状，而这种差异
 * 只能靠肉眼比对才发现 ⇒ 收敛成一份。
 *
 * 两种用法：
 *   · `graphPage.js` **import 本文件**，把数值插值进它那段页内脚本（真单源）。
 *   · `client.js` 是**单块客户端 chunk**（不能 import，见其文件头：拆子块会踩
 *     immutable 缓存）⇒ 那里保留一份 `KB_GRAPH_PHYS` 常量，并由
 *     `scripts/check-kb-graph-physics.mjs` **逐项对账**：数值不一致时守卫直接报红。
 *
 * ⚠ 单位/含义（改之前先读）：
 *   - `repulsion`：斥力系数（`k*k/dist` 里的 k；页面侧再乘以节点权重）
 *   - `spring`：弹簧系数（`(dist - want) * spring`）
 *   - `center`：向画布中心回拉的比例
 *   - `damping`：每帧速度衰减（越小越"黏"，收敛快但容易挤成一团）
 *   - `maxStep`：**单帧位移钳制**（不做这一步，斥力冲量会让节点飘出几万像素 —— 2026-10-19 真踩过）
 *   - `minDist`：斥力/碰撞的距离下限（`dist→1` 时 `k*k/dist` 会爆炸）
 *   - `collision`：碰撞软约束权重（软约束，会被弹簧与中心力压过）
 *   - `nodeRadius` / `springPadding`：弹簧的目标距离 = `2*nodeRadius + springPadding`
 *   - `settleTicks`：跑多少帧后停止（之后静止绘制，不再耗 CPU）
 */
export const GRAPH_PHYSICS = Object.freeze({
	repulsion: 0.16,
	spring: 0.2,
	center: 0.012,
	damping: 0.9,
	maxStep: 24,
	minDist: 12,
	collision: 0.9,
	nodeRadius: 5,
	springPadding: 40,
	settleTicks: 260,
});

/** 面板侧（`client.js`）与页面侧共用的子集 —— 对账守卫按这个列表逐项比较。 */
export const SHARED_KEYS = Object.freeze(['center', 'damping', 'minDist', 'nodeRadius', 'springPadding', 'settleTicks']);
