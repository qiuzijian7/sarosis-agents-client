/**
 * 「最近出图」账本（宿主侧）：Agent 出图后记一笔，画布页来取 ⇒ **结果自动落画布**。
 *
 * 为什么用**时间游标**而不是会话 id：画布页拿不到自己的会话 id（插件页视图的 preload 不带 sessionId），
 * 而工具执行侧也未必拿得到可靠的会话上下文 ⇒ 用「出图时间晚于画布上次同步」来对齐，天然支持
 * 多窗口各拉各的（画布页按图 id 去重 ⇒ 同一张图在两个画布里都会落位，这符合"生成结果共享"的心智 ✓）。
 *
 * 账本只在**内存**里（进程结束即失）—— 画布是草稿台，图片本体在 attachment 存储里（长期在 ✓），
 * 这里只是"最近这几张"的索引。
 */

/** 账本最多留多少条（超出丢最旧的）。 */
const DEFAULT_LIMIT = 50;

/**
 * @param {object} [options]
 * @param {number} [options.limit] 最多留多少条
 */
export function createImageLedger({ limit = DEFAULT_LIMIT } = {}) {
	/** @type {Array<{id:string, attachment:object, mediaType:string, width?:number, height?:number, prompt?:string, at:number}>} */
	const items = [];
	let seq = 0;
	return {
		/**
		 * 记一张图。
		 * @param {object} entry
		 * @param {object} entry.attachment attachments.saveImage 的返回值（读图要用它）
		 * @param {string} [entry.mediaType]
		 * @param {number} [entry.width]
		 * @param {number} [entry.height]
		 * @param {string} [entry.prompt]
		 */
		record(entry) {
			const attachment = entry?.attachment;
			if (!attachment || !attachment.attachmentId) { return undefined; }
			seq += 1;
			const item = {
				id: `ci-${seq}-${Date.now().toString(36)}`,
				attachment,
				mediaType: String(entry.mediaType || attachment.mediaType || 'image/png'),
				width: typeof entry.width === 'number' ? entry.width : attachment.width,
				height: typeof entry.height === 'number' ? entry.height : attachment.height,
				prompt: typeof entry.prompt === 'string' ? entry.prompt : undefined,
				// ★ 四批⑪：provider/模型要记下来 ⇒ 画廊才能按 provider 筛（不记 ⇒ 筛不了）。
				provider: typeof entry.provider === 'string' ? entry.provider : '',
				model: typeof entry.model === 'string' ? entry.model : '',
				// 来源：`generate`（出图）/ `import`（从磁盘插进画布的）。
				source: typeof entry.source === 'string' ? entry.source : 'generate',
				at: Date.now(),
			};
			items.push(item);
			while (items.length > limit) { items.shift(); }
			return item;
		},
		/**
		 * 取「晚于某个时刻」的图（画布页轮询用）。
		 * @param {number} sinceMs 毫秒时间戳；0 = 全部
		 */
		since(sinceMs) {
			const from = Number(sinceMs) || 0;
			return items.filter(item => item.at > from);
		},
		/** 按 id 取一条（图片字节路由用）。 */
		get(id) {
			return items.find(item => item.id === id);
		},
		/**
		 * ★ 2026-10-21（二批⑥）：按**任一种** id 找一条（`edit_image` 的 `source:'attachment_id'` 用）。
		 *
		 * 两种 id 都认：① 账本自己的 id（`ci-<seq>-<ts>`，工具回执里给模型看的就是它）；
		 * ② dsh 附件 id（`attachment.attachmentId`）—— 模型从别处抄来的也认得 ✓。
		 *
		 * @param {string} id
		 * @returns {object | undefined}
		 */
		find(id) {
			const key = String(id ?? '').trim();
			if (!key) { return undefined; }
			return items.find(item => item.id === key || item.attachment?.attachmentId === key);
		},

		/**
		 * 记下这张图**已落到工作区的路径**（生图工作台的画廊要显示"已存到工作区：…"）。
		 * @param {string} id 图 id
		 * @param {string} path 绝对路径
		 */
		markSaved(id, path) {
			const item = items.find(entry => entry.id === id);
			if (!item) { return undefined; }
			item.savedPath = String(path || '');
			return item;
		},

		/** 全部（诊断用）。 */
		all() { return items.slice(); },
		/** 条数（诊断用）。 */
		size() { return items.length; },
	};
}
