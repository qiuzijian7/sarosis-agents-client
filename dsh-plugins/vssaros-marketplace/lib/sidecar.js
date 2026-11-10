// @vssaros/dsh-marketplace — **安装溯源侧车**（★ 2026-11-10 P1）
//
// 为什么要有这一层：官方 dsh / Agent Skills 生态里 `SKILL.md` 是**纯内容** ——
//   frontmatter 只有 name / description / whenToUse / user-invocable 这类语义字段，
//   正文逐字代表作者写的东西，没有"商城装回来的版本号"这种宿主概念。
//   我们此前用 `injectSkillFrontmatter` 往正文里塞 `storeId` / `version` / `displayName`
//   ⇒ ① 装回来的技能拷到官方 dsh / Claude Code / Cursor 会带着一堆不认识的字段；
//      ② 每次升级都改写正文，作者原文不再逐字保留；
//      ③ 想跟上游格式对齐时无从下手。
//   ⇒ 元数据挪到同级 `.market.json`：SKILL.md 保持**逐字不变**，升级溯源仍准。
//
// ⚠ 侧车是「安装溯源」，**不是作者版本**：发布端不许读它当版本号
//   （作者改了内容再发布，侧车里还是上次从商城装的版本 ⇒ 版本会停滞）。
//   发布端只读作者写的 frontmatter / 目录 mtime 推导，并把侧车排除在包外。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 侧车文件名（唯一真源；发布端排除、安装端写入、版本判定读取）。 */
export const SIDECAR_FILE = '.market.json';
export const SIDECAR_FORMAT = 'vssaros-market-resource';

/**
 * 生成侧车内容（纯函数，便于守卫单测）。
 * @param {{storeId?: string, version?: string, displayName?: string, owner?: string}} meta
 */
export function sidecarOf(meta) {
	const out = {
		format: SIDECAR_FORMAT,
		version: 1,
		storeId: String(meta?.storeId ?? ''),
		installedVersion: String(meta?.version ?? ''),
	};
	if (meta?.displayName) { out.displayName = String(meta.displayName); }
	if (meta?.owner) { out.owner = String(meta.owner); }
	return `${JSON.stringify(out, null, 2)}\n`;
}

/** 解析侧车；不是本家格式 / 坏 JSON ⇒ null（调用方兜底到正文 frontmatter）。 */
export function parseSidecar(input) {
	try {
		const raw = typeof input === 'string' || Buffer.isBuffer(input) ? input.toString('utf8') : '';
		const j = JSON.parse(raw);
		if (!j || j.format !== SIDECAR_FORMAT) { return null; }
		return {
			storeId: typeof j.storeId === 'string' ? j.storeId : '',
			version: typeof j.installedVersion === 'string' ? j.installedVersion : '',
			displayName: typeof j.displayName === 'string' ? j.displayName : '',
			owner: typeof j.owner === 'string' ? j.owner : '',
		};
	} catch {
		return null;
	}
}

/** 读某个资源目录的侧车；不存在 / 坏了 ⇒ null（存量技能走 frontmatter 兜底）。 */
export async function readSidecar(dir) {
	try {
		return parseSidecar(await readFile(join(String(dir ?? ''), SIDECAR_FILE), 'utf8'));
	} catch {
		return null;
	}
}
