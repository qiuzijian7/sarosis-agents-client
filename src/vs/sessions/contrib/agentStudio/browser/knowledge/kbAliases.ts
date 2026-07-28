/*---------------------------------------------------------------------------------------------
 *  kbAliases — 同义归一（P1）
 *  用户可编辑的同义词表，让不同表述归一到同一概念，改善去抽象化门控的跨笔记聚合
 *  （如「GC机制」「垃圾回收」「GarbageCollection」视为同源，共享来源数）。
 *
 *  配置位置：<kbDir>/aliases.json（与 kb-schema.json 同一理念：用户可编辑、代码零硬编码）。
 *  代码只保留确定性纯函数 + 安全降级读取。
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export interface IKbAliases {
	/** canonical → 同义词列表（canonical 自身无需列出）。键/值均按 normalizeAliasKey 归一比较。 */
	aliases: Record<string, string[]>;
}

/** aliases.json 在 kbDir 下的相对文件名（用户可编辑）。 */
export const KB_ALIASES_FILE = 'aliases.json';

/** 标题/同义词归一：小写 + 去空白与标点（与 deabstraction 门控 _normalizeTitle 保持一致）。 */
export function normalizeAliasKey(s: string): string {
	return s.toLowerCase().replace(/[\s\-_./，。、:：()（）]/g, '').trim();
}

/**
 * 把标题归一到 canonical 键。
 * 若归一后的标题命中某条目的同义词集合（含 canonical 自身），返回该条目归一后的 canonical；
 * 否则返回标题自身的归一形式（标题自身即为 canonical）。
 */
export function canonicalizeTitle(title: string, aliases: IKbAliases): string {
	const key = normalizeAliasKey(title);
	if (!key) {
		return key;
	}
	for (const [canon, syns] of Object.entries(aliases.aliases)) {
		const canonKey = normalizeAliasKey(canon);
		if (canonKey === key) {
			return canonKey;
		}
		for (const s of syns) {
			if (normalizeAliasKey(s) === key) {
				return canonKey;
			}
		}
	}
	return key;
}

/**
 * 读取 <kbDir>/aliases.json。文件不存在或 JSON 非法时返回空表（安全降级，绝不阻断门控）。
 */
export async function loadKbAliases(fileService: IFileService, kbDir: URI): Promise<IKbAliases> {
	const uri = URI.joinPath(kbDir, KB_ALIASES_FILE);
	try {
		const raw = (await fileService.readFile(uri)).value.toString();
		const parsed = JSON.parse(raw) as Partial<IKbAliases>;
		if (parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object') {
			return { aliases: parsed.aliases as Record<string, string[]> };
		}
	} catch {
		// 文件不存在或 JSON 非法 → 空表降级
	}
	return { aliases: {} };
}
