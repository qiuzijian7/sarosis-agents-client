// @vssaros/dsh-memory — 草稿提升（自动沉淀的另一半：从"草稿"走到"长期记忆"）。
//
// 为什么这一步必须由**人**触发：自动提取必然有误 ⇒ 草稿的意义就是"等人判断" ✓
//（见 `core/distill.js` 的约束 ②）。所以它是**页面上的一个动作**，不是模型能自己调的工具 ✓。
//
// ⚠⚠ **为什么页面提升不走审批闸** —— 这条推理必须写下来，否则后人一定会以为是漏了 ✗：
//   · 闸（`tools/pre-execute` ⇒ `ask`）存在的**唯一理由**是"**模型**可能不经确认就把内容固化进
//     用户的记忆库" ✓（`lib/index.js` 的闸注释里写的就是这个）。而"**人**在页面上按下提升"
//     **本身就是那次确认** ✓ —— 再弹一次窗问同一个人"你确定吗"，是把确认链叠了两层，
//     只会让人养成盲点 ✗（与 kb 的"dry-run 只出计划 ⇒ 不该弹窗"是**同一判据**：
//     判据是"**谁会因此改用户数据**"，不是"这个动作像不像写" ✓）。
//   · 另一条路（真去走 `approval/request`）**技术上也不通**：审批服务的不变量要求请求发生在
//     **open turn** 内（`dsh-user-approval` 的校验 ✓，另外 `lib/index.js` 里也记过这一条），
//     而页面请求没有 turn ✗。
//   ⇒ 结论：**页面 = 人的显式动作 ⇒ 不弹窗 ✓**；**模型**要写记忆仍然必须过闸（两条路各自正确 ✓）。
//
// ⚠ 依赖全部注入（`draftStore` / `remember` / `auditAppend`）⇒ 本文件零 dsh 依赖、可独立测 ✓。
//   尤其 `remember` 注入让探针**不必起真网关**就能钉住"提升真的发了写请求 + 发了什么载荷" ✓。

/** 提升后的记忆类型（固定 `fact`）：草稿的自然语义就是"一条事实/约定" ✓（将来要分型，加个表单字段即可 ✓）。 */
export const PROMOTE_MEMORY_TYPE = 'fact';

/**
 * 提升后的 `importance`：自动提取的东西**不该**比模型显式写的更高 ⇒ 取中间值 ✓
 *（模型显式写时常给 8–10；草稿是插件猜的，给 6 ⇒ 检索排序里不会压过人的明确意图 ✓）。
 */
export const PROMOTE_IMPORTANCE = 6;

/**
 * 提升后那条记忆的 id（由草稿**指纹**派生 ⇒ 同一条草稿重复提升不会在长期层留下两条不同 id 的记忆 ✓）。
 * @param {{digest?: string}} row - 草稿行。
 * @returns {string} 记忆 id。
 */
export function promotedMemoryIdOf(row) {
	return `draft-${String(row?.digest ?? '').slice(0, 12)}`;
}

/**
 * 建一个提升器。
 * @param {{draftStore: object, remember: Function, gatewayBase: string|null, agentId: string,
 *   auditAppend?: Function, now?: () => number}} deps - 依赖。
 * @returns {{promote: (id: string) => Promise<{ok: boolean, id?: string, memoryId?: string, text?: string, error?: string}>}} 提升器。
 */
export function createPromoter(deps) {
	const { draftStore, remember, gatewayBase, agentId, auditAppend, now } = deps;
	const stamp = () => (typeof now === 'function' && Number.isFinite(now()) ? now() : Date.now());

	/**
	 * 把一条草稿提升成长期记忆。
	 *
	 * 顺序刻意是 **写网关成功之后才改草稿状态** ✓ —— 反过来（先标 promoted 再写）一旦写失败，
	 * 草稿就"看起来已经提升过了"，而长期层里根本没有它 ✗（这类"记录与事实不一致"是最难发现的坏法 ✓）。
	 */
	async function promote(id) {
		if (typeof id !== 'string' || !id) { return { ok: false, error: '缺少草稿 id' }; }
		if (!gatewayBase) {
			return { ok: false, error: '记忆网关未配置（config.gatewayUrl / VSSAROS_MEMORY_GATEWAY_URL）' };
		}
		const rows = await draftStore.read();
		const row = rows.find(candidate => candidate.id === id);
		if (!row) { return { ok: false, error: `草稿不存在：${id}` }; }
		if (row.status !== 'draft') { return { ok: false, error: `草稿已是 ${row.status} 状态，不再提升` }; }

		const entry = {
			id: promotedMemoryIdOf(row),
			type: PROMOTE_MEMORY_TYPE,
			content: String(row.text ?? ''),
			importance: PROMOTE_IMPORTANCE,
			timestamp: stamp(),
			// 来源可回溯（`jessenjx` 的 citation 与 `memento` 的双证据链是同一条思路 ✓）：
			// 记下"这条记忆是从哪个会话的哪个回合提取的" ✓。
			metadata: { source: 'draft', sessionId: row.sessionId, turn: row.turn },
		};

		const auditBase = {
			tool: 'memory_promote(page)', agentId, sessionId: row.sessionId,
			target: 'long', memoryType: entry.type,
			// `policy: 'human'` —— 这一笔的来源是**人的显式动作**（见文件头 ✓），
			// 与工具闸那三段的 `ask`/`auto`/`off` 刻意区分开 ✓。
			policy: 'human',
			content: entry.content,
		};

		let reply = null;
		try {
			reply = await remember(gatewayBase, agentId, entry);
		} catch (error) {
			await auditAppend?.({ action: 'executed', ...auditBase, outcome: 'failed', error });
			return { ok: false, error: String(error?.message ?? error) };
		}
		// 网关**明确**说成功才算成功（"没报错"不算 —— 与 `lib/index.js` 的写工具同一条口径 ✓）
		const ok = reply?.ok === true || reply?.success === true;
		await auditAppend?.({ action: 'executed', ...auditBase, outcome: ok ? 'ok' : 'rejected-by-gateway' });
		if (!ok) {
			return { ok: false, error: `网关未确认成功：${String(JSON.stringify(reply)).slice(0, 160)}` };
		}

		const marked = await draftStore.mark(id, 'promoted');
		return { ok: true, id, memoryId: entry.id, text: entry.content, ...(marked.ok ? {} : { marked: false, markError: marked.error }) };
	}

	/**
	 * 丢弃一条草稿（`draft` → `rejected`）。
	 *
	 * ⚠ 与提升的**不对称**是刻意的：丢弃**不碰网关** ⇒ 没有"写成功"可等 ⇒ 直接标状态即可 ✓
	 *（提升那边必须"先写成功再改状态"，否则会出现"记录说提升过了、长期层里却没有它" ✗ —— 丢弃没有对应物 ✓）。
	 *
	 * ⚠ 审计**照记**（`executed` + `policy: 'human'` + `outcome: 'discarded'`）："谁把这条约定丢了"
	 * 与"谁把它提升了"是同等重要的证据 ✓ —— 否则用户会看到一条候选**凭空消失** ✗。
	 *
	 * ⚠ **丢弃不是永久否决**：`seenDigestsOf` 只把 `status !== 'rejected'` 的算作已见
	 *（`core/distill.js` ✓）⇒ 同一条约定下次还会被重新提出来 ✓。这是刻意的：误点一次丢弃
	 * 不该等于永久关掉那条提醒 ✗✗（真要不提，就把草稿的 TTL 交给治理 ✓）。
	 *
	 * @param {string} id - 草稿 id。
	 * @returns {Promise<{ok: boolean, id?: string, text?: string, error?: string}>} 结果。
	 */
	async function discard(id) {
		if (typeof id !== 'string' || !id) { return { ok: false, error: '缺少草稿 id' }; }
		const rows = await draftStore.read();
		const row = rows.find(candidate => candidate.id === id);
		if (!row) { return { ok: false, error: `草稿不存在：${id}` }; }
		if (row.status !== 'draft') { return { ok: false, error: `草稿已是 ${row.status} 状态，不再操作` }; }
		const marked = await draftStore.mark(id, 'rejected');
		await auditAppend?.({
			action: 'executed',
			tool: 'memory_discard(page)',
			agentId,
			sessionId: row.sessionId,
			target: 'long',
			memoryType: PROMOTE_MEMORY_TYPE,
			policy: 'human',
			outcome: 'discarded',
			content: row.text,
		});
		return { ok: marked.ok, id, text: row.text, ...(marked.ok ? {} : { error: marked.error }) };
	}

	return { promote, discard };
}
