// @vssaros/dsh-browser — `evaluate` op 的校验与渲染（纯函数，可单测）。
//
// 为什么单独一个文件而不塞进 `index.js`：这四条规则（表达式上限、结果截断、类型说明、审批预览）
// 是**唯一真源** —— 守卫要能直接对拍它们，而不是去 index.js 里拼字符串。
//
// ## 这个 op 的定位（决定了下面的每一条限制）
//
// 它是"**从页面里取数据**"的逃生门，不是"让 agent 随便在页面里跑代码"的入口：
//   · `snapshot` / `images` 是**采集**（结构已知、输出有界），`evaluate` 是**问**（要什么由调用方定）；
//   · 因此它是**动作类**（逐次审批）**且默认关闭** —— 页面里的 JS 是图灵完备的：它能读该页的
//     cookie / localStorage（`cookies` op 刻意"值不进上下文"，而这里**做不到**这个保证），
//     也能改动页面、发请求。既然保证不了，就不假装 —— 改成"让你在批之前**看见那段代码**"。
//   · 这也是本文件里 `EVALUATE_REASON_PREVIEW_CHARS` 存在的原因：审批文案必须**带上表达式**。

/** 表达式长度上限（字符）：超过它多半是在把整段脚本塞进工具参数 —— 那应该写成技能里的 helper。 */
export const EVALUATE_MAX_EXPRESSION_CHARS = 4000;

/** 结果渲染上限（字符）：一个 `document.documentElement.outerHTML` 就有几百 KB，不截会灌爆上下文。 */
export const EVALUATE_MAX_RESULT_CHARS = 8000;

/** 审批文案里回显表达式的长度上限（人要在弹窗里读得完）。 */
export const EVALUATE_REASON_PREVIEW_CHARS = 300;

/** 求值超时上限（2 分钟）：再长就不是"慢"，而是"页面里有个东西永远不返回" ⇒ 该失败，而不是挂住整轮。 */
export const EVALUATE_MAX_TIMEOUT_MS = 120_000;

/**
 * 超时归一：没给 ⇒ `undefined`（交给 client 的 CDP 默认值，避免两处各写一个默认数）；给了 ⇒ 夹到
 * `[1000, EVALUATE_MAX_TIMEOUT_MS]`。非法值按"没给"处理（不报错 —— 它不是安全问题，只是一次不精确）。
 */
export function clampEvaluateTimeout(raw) {
	const n = typeof raw === 'number' ? raw : Number.NaN;
	if (!Number.isFinite(n) || n <= 0) { return undefined; }
	return Math.min(Math.max(Math.floor(n), 1000), EVALUATE_MAX_TIMEOUT_MS);
}

/**
 * 表达式校验 —— **必须在审批之前**跑（用户不该为一个必然被拒的调用点确认）。
 * 返回 trim 后的表达式；不合规直接抛（消息里说清怎么改）。
 */
export function normalizeExpression(raw) {
	if (typeof raw !== 'string' || !raw.trim()) {
		throw new Error('browser.evaluate 需要 expression（一段要在**当前页面**里求值的 JS）');
	}
	const expression = raw.trim();
	if (expression.length > EVALUATE_MAX_EXPRESSION_CHARS) {
		throw new Error(`browser.evaluate 的 expression 太长（${expression.length} > ${EVALUATE_MAX_EXPRESSION_CHARS} 字符）`
			+ ' —— 请拆成几步，或把可复用的抽取代码写进技能文件里，而不是塞进工具参数。');
	}
	return expression;
}

/** 审批预览：压平空白 + 截断（人读的是这一段，所以它必须**逐字来自调用方**，不做任何美化）。 */
export function expressionPreview(expression) {
	const flat = String(expression ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > EVALUATE_REASON_PREVIEW_CHARS
		? `${flat.slice(0, EVALUATE_REASON_PREVIEW_CHARS)}… (+${flat.length - EVALUATE_REASON_PREVIEW_CHARS} chars)`
		: flat;
}

/** 值的**类型**：给模型一个"拿到的是什么"的判据，免得它把 `[object Object]` 当内容用。 */
export function valueTypeOf(value) {
	if (value === null) { return 'null'; }
	if (Array.isArray(value)) { return `array(${value.length})`; }
	if (value === undefined) { return 'undefined'; }
	return typeof value;
}

/** 序列化：对象走 JSON（缩进便于人读），不可 JSON 化的值退回 `String()`。 */
function serialize(value) {
	if (typeof value === 'string') { return value; }
	let out;
	try {
		out = JSON.stringify(value, null, 2);
	} catch {
		// 循环引用（页面里的 DOM / window 常这样）—— CDP 通常已经先拦下了，这里只是兜底。
		out = undefined;
	}
	if (out === undefined) {
		try { out = String(value); } catch { out = '(unrepresentable value)'; }
	}
	return out;
}

/**
 * 渲染求值结果。
 *
 * ★ 两条**必须写进文本**的话（而不是留给模型猜）：
 *   ① 这是从页面里读到的**值**，不是"页面内容"（与 snapshot 不是一回事）；
 *   ② 跑 JS **可能改过页面** ⇒ 旧的 `ref` 可能失效 ⇒ 提示重新 snapshot。
 */
export function formatEvaluateResult(expression, value) {
	const serialized = serialize(value);
	const truncated = serialized.length > EVALUATE_MAX_RESULT_CHARS;
	const body = truncated
		? `${serialized.slice(0, EVALUATE_MAX_RESULT_CHARS)}\n… [truncated: ${serialized.length - EVALUATE_MAX_RESULT_CHARS} more chars not shown]`
		: serialized;

	/**
	 * ⚠ 空对象要单独提示 —— 这是**实测**（2026-10-13）得出的唯一可行办法。
	 *
	 * CDP 对 DOM 节点这类"活对象"**不报错**：`returnByValue` 会把它静默序列化成 `{}`
	 * （真实返回是 `{ result: { type: 'object', value: {} } }`，连 `objectId` 都没有）——
	 * 这与"页面**真的**返回了一个空对象"在协议层**无法区分** ⇒ client 层拦不住（那里的注释有说明）。
	 * 既然判不出来，就**别假装判**：只给一条**可行动**的提示，让模型知道下一步该返回字符串。
	 */
	const looksLikeEmptyObject = valueTypeOf(value) === 'object' && serialized.replace(/\s/g, '') === '{}';

	// 表达式回显（同一份预览口径）：模型一次要跑好几条时要能对上号。
	return `## Evaluated in page\n\n`
		+ `\`${expressionPreview(expression)}\`\n\n`
		+ `Result (${valueTypeOf(value)}):\n\n\`\`\`\n${body}\n\`\`\`\n\n`
		+ (looksLikeEmptyObject
			? '_(Note: an **empty object**. If you meant to read a DOM element, this is what a live node serialises to — '
				+ 'return a string or plain data instead, e.g. `el.outerHTML` / `el.textContent` / `[...el.children].map(c => c.className)`.)_\n\n'
			: '')
		+ '_(This is a value read from the page, not page content. Running JS may also have changed the DOM — '
		+ 'take a fresh `snapshot` before reusing old `ref` numbers.)_';
}
