// @vssaros/dsh-agents — 群聊写口的**幂等 + 陈旧防护**（2026-10-31，P2）。
//
// 为什么需要（对照 DeepSeekBot）：
//   DSB 把这两件事做在存储层 —— `channels/management.ts:273-377` 的 `channel_management_operations`
//   表（operationKey + payload hash ⇒ 同 key 同参回放）、`:124-136` 的 `channelManagementFingerprint`
//   （陈旧校验）、`:528-540`（invite 时校验指纹，不符 ⇒ `stale-channel`）。
//   我们之前**完全没有这一层**：建群/拉人重复提交（Bot 重试、用户双击、页面重发）会真的执行两次
//   —— 建群是"同名才拦得住"，拉人靠"已在成员里"兜住，但**待确认区 / 半路失败重试**兜不住。
//
// 设计：
//   · **判定是纯函数**（`planIdempotent` / `staleDenial`）⇒ 能直接单测，不依赖文件系统；
//   · IO 只有 `readOps` / `writeOps`，落 <数据根>/agent-group-ops.json，与 agent-groups.json 同级的
//     原子写（沿用 writeGroups 那套 tmp + rename）；
//   · 幂等只在**成功之后**记账（失败不记 ⇒ 重试能真正重跑，不会永远回放一个失败）；
//   · operationKey **可选**：不传就照旧执行一次（向后兼容，前端/工具不必改）。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from '../atomicWrite.js';
import { dataRootOf } from '../store.js';

/** 操作台账文件名（数据根下）。 */
export const OPS_FILE_NAME = 'agent-group-ops.json';
/** 台账保留条数（超出裁最旧 —— 它只是幂等用，不需要全量历史）。 */
export const OPS_KEEP = 200;

function stable(value) {
	if (Array.isArray(value)) { return value.map(stable); }
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
	}
	return value;
}

/** 稳定指纹：键排序后序列化 ⇒ sha256 前 12 位（键顺序不同不算不同参数）。 */
export function payloadFingerprint(payload) {
	return createHash('sha256').update(JSON.stringify(stable(payload ?? null))).digest('hex').slice(0, 12);
}

/**
 * 幂等判定（纯函数）：
 *   · 没给 operationKey  ⇒ `run`
 *   · 台账里没有这条 key ⇒ `run`
 *   · 有且指纹相同       ⇒ `replay`（回放当时记下的结果，**不重跑**）
 *   · 有但指纹不同       ⇒ `conflict`（同一个 key 换了参数 ⇒ 明确 409，绝不静默覆盖）
 */
export function planIdempotent(input) {
	const key = String(input?.key ?? '').trim();
	if (!key) { return { kind: 'run', key: '' }; }
	const fingerprint = payloadFingerprint(input.payload ?? null);
	const found = (input.records ?? []).find((r) => r && r.key === key);
	if (!found) { return { kind: 'run', key, fingerprint }; }
	if (found.fingerprint === fingerprint) { return { kind: 'replay', key, fingerprint, result: found.result }; }
	return { kind: 'conflict', key, fingerprint, existing: found.fingerprint };
}

/**
 * 陈旧判定（纯函数）：调用方把**它读到的** `updatedAt` 传回来，写之前比对。
 * 不传 ⇒ 不校验（向后兼容：老调用方不受影响）。
 */
export function staleDenial(group, expectedUpdatedAt) {
	if (expectedUpdatedAt === undefined || expectedUpdatedAt === null || expectedUpdatedAt === '') { return null; }
	const want = Number(expectedUpdatedAt);
	if (!Number.isFinite(want)) { return 'expectedUpdatedAt 必须是数字（群对象的 updatedAt）'; }
	const now = Number(group?.updatedAt ?? 0);
	if (now === want) { return null; }
	return `群已被改过（你读到的是 ${want}，现在是 ${now}）：重新读一次再操作`;
}

async function readOps(config) {
	const file = join(dataRootOf(config), OPS_FILE_NAME);
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8'));
		return Array.isArray(parsed?.ops) ? parsed.ops.filter((o) => o && typeof o.key === 'string') : [];
	} catch {
		return []; // 没有台账 / 读不出 ⇒ 当作"从没记过"（退化为不幂等，不阻断）
	}
}

async function writeOps(config, ops) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, ops: ops.slice(-OPS_KEEP) }, null, 2);
	JSON.parse(text); // 自证产物合法 ✓
	const target = join(root, OPS_FILE_NAME);
	const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
	await writeFile(tmp, text, 'utf8');
	await renameWithRetry(tmp, target);
}

/**
 * 写口用的统一入口：`run()` 里放真正的写逻辑，返回值会被记账。
 * @returns `{ result, replayed }` —— `replayed:true` 表示这次是回放，没真跑。
 */
export async function withIdempotency(config, input, run) {
	const records = await readOps(config);
	const plan = planIdempotent({ key: input?.operationKey, payload: input?.payload, records });
	if (plan.kind === 'replay') {
		return { result: plan.result, replayed: true };
	}
	if (plan.kind === 'conflict') {
		throw Object.assign(
			new Error(`operationKey 复用但参数变了（${plan.existing} → ${plan.fingerprint}）：换一个 key 或改回原参数`),
			{ httpStatus: 409 },
		);
	}
	const result = await run();
	if (plan.key) {
		await writeOps(config, [...records, { key: plan.key, fingerprint: plan.fingerprint, at: Date.now(), result }]);
	}
	return { result, replayed: false };
}
