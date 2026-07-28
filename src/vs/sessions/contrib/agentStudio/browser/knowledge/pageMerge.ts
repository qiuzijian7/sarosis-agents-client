/*---------------------------------------------------------------------------------------------
 *  页面合并写工具（P1-2，对齐 llm_wiki `src/lib/page-merge.ts`）。
 *
 *  本项目笔记当前为"导入即写新文件"，无覆盖场景；此模块供未来"重新结构化抽取 / 去重合并"
 *  场景使用：保留用户手改的 frontmatter 字段与 body 段落，仅并入 incoming 的新内容。
 *  当前的 sources 注入合并已由 frontmatter.injectSources（行级，保留其他字段）覆盖。
 *--------------------------------------------------------------------------------------------*/

export type FrontmatterValue = string | string[];

/**
 * frontmatter 字段级合并：incoming 覆盖 old，但 old 中 incoming 未提及的字段保留。
 * 用户手改的 title/tags 等不会被 incoming 的同名字段冲掉（除非 incoming 显式提供）。
 */
export function mergeFrontmatter(
	old: Record<string, FrontmatterValue>,
	incoming: Record<string, FrontmatterValue>,
): Record<string, FrontmatterValue> {
	return { ...old, ...incoming };
}

/**
 * body 段落级合并：按 `## 标题` 分段，保留 old 独有段落，incoming 覆盖同名段落，
 * incoming 独有段落追加。避免重新抽取时丢失用户补充的段落。
 */
export function mergeBody(oldBody: string, incomingBody: string): string {
	const sections = splitSections(oldBody);
	const incoming = splitSections(incomingBody);
	const merged = new Map<string, { heading: string; body: string }>();
	for (const s of sections) { merged.set(s.heading, s); }
	// incoming 覆盖同名段，其余追加（保留 incoming 顺序）
	const order: string[] = [];
	for (const s of sections) { if (!order.includes(s.heading)) { order.push(s.heading); } }
	for (const s of incoming) {
		// __pre__ 段：保留 old 非空前置，不被 incoming 空前置覆盖
		if (s.heading === '__pre__') {
			const oldPre = merged.get('__pre__');
			if (oldPre && oldPre.body.trim()) { continue; }
		}
		merged.set(s.heading, s);
		if (!order.includes(s.heading)) { order.push(s.heading); }
	}
	const out: string[] = [];
	for (const h of order) {
		const s = merged.get(h)!;
		if (h === '__pre__') {
			if (s.body.trim()) { out.push(s.body); }
		} else {
			out.push(s.heading);
			if (s.body.trim()) { out.push(s.body); }
		}
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitSections(text: string): { heading: string; body: string }[] {
	const lines = text.split(/\r?\n/);
	const sections: { heading: string; body: string }[] = [];
	let cur: { heading: string; body: string } = { heading: '__pre__', body: '' };
	for (const line of lines) {
		const m = /^(#{1,6}\s+.*)$/.exec(line);
		if (m) {
			sections.push(cur);
			cur = { heading: m[1], body: '' };
		} else {
			cur.body += (cur.body ? '\n' : '') + line;
		}
	}
	sections.push(cur);
	return sections;
}
