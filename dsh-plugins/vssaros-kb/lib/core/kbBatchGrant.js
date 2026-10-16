// @vssaros/dsh-kb — "本批一次性授权"的**纯逻辑**（零 I/O、零 dsh 依赖）。
//
// ## 为什么需要它（2026-10-12 取证驱动，见 doc/dsh-kb-build-orchestration.html §5 D2）
//
// `kb_build mode="build"` 会让子代理**逐篇**调 `kb_write_note` ⇒ 每篇一张审批卡 ✗。
// 审批疲劳不是小毛病：用户很快学会闭眼点"允许"，闸就等于没有（本模块在 `kb_organize` 那期
// 定过同一条判据：只读操作不该弹窗，否则会稀释真闸的效力 ✓）。
//
// 那能不能靠基座？**不能** ✗ —— 本轮实测（`.runtime/<版本>` 的 `dsh-permission-presets` typert + `dsh-client-ui-approval` 契约）：
//   · `ApprovalDecision = 'allowed-once' | 'rejected'`（客户端只有两档 ✓）
//   · `ApprovalOutcome  = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
//     且 `dsh-user-approval` 的注释原话：**"`'allowed-once'` is the only grant"** ✓
//   · 全局旋钮只有 `ApprovalPolicy = 'ask' | 'never'`（要么每次问、要么根本不问 ✗）
// ⇒ 基座**没有**"记住本批/本会话允许"这一档 ⇒ 要在**我们这层**实现一个有界授权 ✓。
//
// ## ★ 2026-10-13 真机修正（p3-45）：这份授权**不是"省几次弹窗"，而是子代理唯一能写成笔记的途径** ✗✗
//
// 真源把**委派出去的孩子**钉死在 `approvalPolicy: 'never'` 上 ——
// `dsh-subagent/lib/types/child-agent.d.ts:116-121` 原话：*"'never' whenever the approval capability is
// composed … a delegated child acts only within the sandbox scope fixed at delegation, so **its asks are
// rejected deterministically**"*；另一处（同包 `lib/index.js:487`）给孩子看的运行时声明同义：
// "operations that require approval are rejected automatically" ✓。
// ⇒ 实测（p3-45 真 Host）：**没有**这份授权时，子代理每次 `kb_write_note` 都返回
//   `Error: the user rejected tool "kb_write_note"` ⇒ **一篇都写不出来** ✓（不是"多弹几张卡" ✓）。
// ⇒ 两个结论都改了实现：
//   ① 授权必须覆盖"**我批准的那次构建派生出去的子会话**"，不能只认批准者自己的会话 id ✗
//      （子会话的工具调用带的是**孩子的** agent id；血缘靠子会话 header 的
//      `parentSession = 批准者的会话 id` ✓ —— 真源 `childSessionMeta()` 里 `parentSession: parentHeader.id`，
//      同处还有 `origin: 'subagent'` 与 `delegationDepth` ✓）；
//   ② 所以"关掉批授权"＝**构建能力关闭**（而不是"退回逐篇问" ✗）—— 文案与探针都按这个真相写 ✓。
//
// ## 三条不变式（缺一条就会变成"模型拿空白支票" ✗）
//   ① **有界**：只覆盖固定篇数（`remaining` 递减到 0 即失效 ✓）；
//   ② **有时限**：`expiresAt` 到点即失效（长任务也要收敛 ✓）；
//   ③ **有归属**：只对**同一个 vault + 同一族会话**生效（批准者自己，或由它**直接**派生出去的子代理 ✓；
//      别的会话 / 别的库一律不放行 ✗）。⚠ 只认**直接**父子：我们派子代理时 `maxDepth: 1` ⇒ 不会有孙子 ✓
//      （真有也会因 `parentSession` 指向孩子而非批准者而不匹配 ✓）。
//
// ⚠ 这就是本模块唯一的"内部授权态"：它**只在内存里**（不落盘、不跨进程 ✓）、
//   且**只在 `kb_build mode="build"` 被用户批准之后**才会被打开 ✓ ——
//   批准那一刻的文案会**写明**"本批最多 N 篇写入将不再逐篇询问"（用户看得到，见 index.js 的 `writeIntentOf` ✓）。

/** 一批最多构建多少份素材（照真源 `MAX_ASSETS = 20` ✓：无人工介入的长任务，路径太多会跑很久、烧很多 token）。 */
export const DEFAULT_BATCH_LIMIT = 20;

/** 授权时限（分钟级任务够用；到点自动失效 ⇒ 不会变成永久放行 ✓）。 */
export const GRANT_TTL_MS = 30 * 60 * 1000;

/** 把 `batch` 参数夹到合法区间（缺省 = `DEFAULT_BATCH_LIMIT` ✓）。 */
export function clampBatch(value, limit = DEFAULT_BATCH_LIMIT) {
	if (!Number.isFinite(value)) {
		return limit;
	}
	return Math.min(limit, Math.max(1, Math.floor(value)));
}

/**
 * 打开一个授权。
 * @param {{ vaultId: string, ownerId: string, writes: number, ttlMs?: number, now?: number }} input
 */
export function openGrant({ vaultId, ownerId, writes, ttlMs = GRANT_TTL_MS, now = Date.now() }) {
	return {
		vaultId: String(vaultId ?? ''),
		ownerId: String(ownerId ?? ''),
		remaining: Math.max(0, Math.floor(Number.isFinite(writes) ? writes : 0)),
		expiresAt: now + ttlMs,
	};
}

/**
 * 这次调用能不能用授权（**只读判断**，不改授权 ✓）。三条不变式都在这 ✓。
 *
 * `ownerIds` 是"这次写算**谁**在写"的**归属集合**（调用方负责算 ✓，本模块不认识 agent 的形状 ✓）：
 * 通常是 `[本会话 id, 子会话 header.parentSession]` ⇒ 批准者自己与它直接派出去的孩子都算 ✓。
 * 空集合 ⇒ **不放行**（fail-closed：身份不明时宁可多问一次，也不能"可能是我批的就放行" ✗）。
 */
export function grantAllows(grant, { vaultId, ownerIds, now = Date.now() }) {
	if (!grant) {
		return false;
	}
	if (grant.remaining <= 0 || now >= grant.expiresAt) {
		return false;
	}
	if (grant.vaultId !== String(vaultId ?? '')) {
		return false;
	}
	const claimed = (Array.isArray(ownerIds) ? ownerIds : [ownerIds]).filter(Boolean).map(String);
	return claimed.length > 0 && claimed.includes(grant.ownerId);
}

/**
 * 消费一次授权。
 * 只有 `kb_write_note` **记账**（篇数就是它写的篇数 ✓）；`kb_mkdir` 由同一授权覆盖但**不记账**
 * （建目录不产生"笔记篇数"，而它本身也是围栏内的写 ⇒ 同样不该狂弹窗 ✓）。
 * 返回**新的** grant（纯函数 ✓）；`remaining` 减到 0 即自然失效 ✓。
 */
export function consumeGrant(grant, { name, now = Date.now() }) {
	if (!grant) {
		return grant;
	}
	void now;
	if (name !== 'kb_write_note') {
		return grant;
	}
	return { ...grant, remaining: Math.max(0, grant.remaining - 1) };
}

/** 供回执/审批文案用的摘要（如实报剩余篇数与到期时间 ✓）。 */
export function describeGrant(grant, { now = Date.now() } = {}) {
	if (!grant) {
		return '（没有生效中的批授权）';
	}
	const leftMs = Math.max(0, grant.expiresAt - now);
	return `剩余 ${grant.remaining} 篇 / ${Math.ceil(leftMs / 60000)} 分钟后失效 / 仅限 vault ${grant.vaultId}`;
}
