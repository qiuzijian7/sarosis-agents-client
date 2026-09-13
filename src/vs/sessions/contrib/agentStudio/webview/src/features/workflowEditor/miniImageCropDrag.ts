/*---------------------------------------------------------------------------------------------
 *  miniImageCropDrag — MiniImageEditor 裁剪框拖拽的**纯数学**（无 React / 无 DOM）。
 *
 *  为什么要抽出来：这三段是「拖拽方向 / 边界」这类**只能靠肉眼或读代码验证**的语义，
 *  此前内联在 67KB 的组件里 → 零测试覆盖。用户 2026-09-11 报「裁剪方块向上拖拽时
 *  方块向下移动」时，只能靠读代码 + grep 构建产物来断言「代码是对的」，无法回归。
 *  抽成纯函数后由 `test/browser/miniImageCropDrag.test.ts` 钉住三条不变量：
 *    · **方向**：位移**跟随指针**（`+dx/+dy`）。减号是「视图平移（grab 滚动条反向）」
 *      的语义，框移动不能用它 —— 这正是历史上那次方向反向 bug 的根因。
 *    · **边界**：整体移动时位置 clamp 到 `[0, 1-w] / [0, 1-h]` → **尺寸恒定**，
 *      推到边界是「停住」而不是被「挤扁」（cropEditor 曾犯过这个错）。
 *    · **手柄**：四角缩放**对角固定**、被拖角跟随光标，任一边不越过对角（min 2% 防翻转）。
 *
 *  组件侧只做「读指针归一化坐标 → 调这里 → setCrop」，逻辑与视图/缩放无关。
 *--------------------------------------------------------------------------------------------*/

/** 归一化裁剪框（0..1，相对**整图**）。 */
export interface CellCropRect { x: number; y: number; w: number; h: number; }

/** 裁剪框四角手柄。 */
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';

/** 手柄最小边长（归一化）——防被拖角越过对角造成「翻转」。 */
export const CROP_MIN_SIDE = 0.02;

/** Shift 缩放的最小宽高（归一化）。 */
export const CROP_MIN_WH = 0.05;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * ★ 框内整体拖动：**跟随指针**（位移取正号），尺寸恒定。
 *
 * `dx/dy` = 指针在**整图归一化坐标**下的位移（视图无关）。
 */
export function moveCropBy(start: CellCropRect, dx: number, dy: number): CellCropRect {
	return {
		x: clamp(start.x + dx, 0, Math.max(0, 1 - start.w)),
		y: clamp(start.y + dy, 0, Math.max(0, 1 - start.h)),
		w: start.w,
		h: start.h,
	};
}

/**
 * ★ 四角手柄缩放：**对角固定**，被拖角跟随光标（任一边不越过对角，min {@link CROP_MIN_SIDE}）。
 *
 * @param n 指针的整图归一化坐标（绝对值，非位移）
 */
export function resizeCropByCorner(corner: CropCorner, start: CellCropRect, n: { x: number; y: number }): CellCropRect {
	let x0 = start.x, y0 = start.y;
	let x1 = start.x + start.w, y1 = start.y + start.h;
	if (corner === 'nw' || corner === 'sw') { x0 = clamp(n.x, 0, x1 - CROP_MIN_SIDE); } else { x1 = clamp(n.x, x0 + CROP_MIN_SIDE, 1); }
	if (corner === 'nw' || corner === 'ne') { y0 = clamp(n.y, 0, y1 - CROP_MIN_SIDE); } else { y1 = clamp(n.y, y0 + CROP_MIN_SIDE, 1); }
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * ★ Shift 缩放：**左上角固定**，宽高随位移变化（clamp 到图界，最小 {@link CROP_MIN_WH}）。
 */
export function resizeCropKeepTopLeft(start: CellCropRect, dx: number, dy: number): CellCropRect {
	return {
		x: clamp(start.x, 0, 0.98),
		y: clamp(start.y, 0, 0.98),
		w: Math.max(CROP_MIN_WH, Math.min(1 - start.x, start.w + dx)),
		h: Math.max(CROP_MIN_WH, Math.min(1 - start.y, start.h + dy)),
	};
}
