/*---------------------------------------------------------------------------------------------
 *  mediaCollect.ts — 生成图片自动收录（P1）的纯判定逻辑。
 *
 *  与 LiteGraphCanvas.collectAsset 解耦，便于单测：每次新产生的媒体 ref 是否应
 *  收录进媒体库、以什么 provider 标注、去重 key 是什么。
 *--------------------------------------------------------------------------------------------*/

export interface CollectMediaDecision {
	/** `${workflowId}:${ref}` 去重 key */
	readonly key: string;
	readonly provider: string;
}

/**
 * 判定一条媒体 ref 是否应自动收录：
 *  - 空 ref / blob:（会话级临时 URL）→ 不收录（null）
 *  - 同一 workflow + ref 已收录过 → 不收录（null，去重）
 *  - 否则返回去重 key 与 provider（http(s) URL = comfyui / 其余 = local）
 */
export function shouldCollectMedia(
	workflowId: string,
	ref: string,
	collected: ReadonlySet<string>,
): CollectMediaDecision | null {
	if (!ref || ref.startsWith('blob:')) { return null; }
	const key = `${workflowId}:${ref}`;
	if (collected.has(key)) { return null; }
	return { key, provider: /^https?:\/\//i.test(ref) ? 'comfyui' : 'local' };
}
