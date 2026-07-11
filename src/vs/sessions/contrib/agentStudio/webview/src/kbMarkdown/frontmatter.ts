/* Minimal YAML frontmatter parsing + a React block to render it.
 *
 * Glyph uses `remark-frontmatter` + `js-yaml`. Those packages are not installed
 * in this offline workspace, so we strip the leading `---\n…\n---` fence before
 * the document is handed to react-markdown (so it is never rendered as a
 * horizontal rule) and parse a pragmatic subset of YAML here.
 *
 * Supported subset (hand-written, zero dependencies):
 *   - top-level `key: value` pairs
 *   - block sequences (`key:\n  - a\n  - b`) — at top level or under a mapping
 *   - inline flow sequences `key: [a, b, c]`
 *   - nested block mappings (`parent:\n  child: x`) and inline flow mappings
 *     (`parent: {child: x, other: 2}`) — preserved as nested objects
 *   - scalar type inference: booleans, integers, floats, `null`/`~`
 *   - single/double quoted strings (commas inside quotes are not split)
 *   - multi-line continuation for the current key
 */

export interface IFrontmatter {
	data: Record<string, unknown>;
	raw: string;
	body: string;
}

export function parseFrontmatter(content: string): IFrontmatter | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!match) return null;
	const raw = match[1];
	const body = content.slice(match[0].length);
	const data = parseYamlSubset(raw);
	return { data, raw, body };
}

function parseYamlSubset(text: string): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	// Each frame is an open mapping keyed by its starting indent. Index 0 is
	// the root (indent -1, so any real line is deeper).
	const frames: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
	// The most recent key seen in each frame (for continuation / list attach).
	const lastKey: (string | null)[] = [null];
	let listKey: string | null = null;
	let listArr: unknown[] | null = null;

	const curFrame = () => frames[frames.length - 1];

	for (const raw of text.split(/\r?\n/)) {
		if (raw.trim() === '') continue;
		const indent = raw.length - raw.trimStart().length;

		// Close any frames that are no deeper than the current line.
		while (frames.length > 1 && indent <= curFrame().indent) {
			frames.pop();
			lastKey.pop();
			listKey = null;
			listArr = null;
		}

		const trimmed = raw.trim();

		// Block sequence item: attach to the nearest key (searching up frames).
		const listItem = /^-\s+(.*)$/.exec(trimmed);
		if (listItem) {
			let target: { key: string; obj: Record<string, unknown> } | null = null;
			for (let i = frames.length - 1; i >= 0; i--) {
				const k = lastKey[i];
				if (k != null) { target = { key: k, obj: frames[i].obj }; break; }
			}
			if (!target) continue;
			if (!listArr || listKey !== target.key) {
				listKey = target.key;
				listArr = Array.isArray(target.obj[target.key]) ? (target.obj[target.key] as unknown[]) : [];
				if (!Array.isArray(target.obj[target.key])) target.obj[target.key] = listArr;
			}
			listArr.push(parseScalar(listItem[1].trim()));
			continue;
		}

		const kv = /^([A-Za-z0-9_.\-/]+)\s*:\s*(.*)$/.exec(trimmed);
		if (kv) {
			const key = kv[1];
			const rawVal = kv[2].trim();
			lastKey[lastKey.length - 1] = key;
			listKey = null;
			listArr = null;
			if (rawVal === '') {
				// Open a nested mapping (filled by deeper-indented lines).
				const child: Record<string, unknown> = {};
				curFrame().obj[key] = child;
				frames.push({ indent, obj: child });
				lastKey.push(null);
			} else {
				curFrame().obj[key] = parseScalar(rawVal);
			}
			continue;
		}

		// Continuation line: append to the current frame's latest string key.
		const key = lastKey[lastKey.length - 1];
		if (key != null && typeof curFrame().obj[key] === 'string') {
			curFrame().obj[key] = `${(curFrame().obj[key] as string)} ${trimmed}`;
		}
	}
	return root;
}

/** Parse a single scalar / flow collection, with type inference. */
function parseScalar(v: string): unknown {
	const s = v.trim();
	if (s === '') return '';
	if (s.startsWith('[') && s.endsWith(']')) {
		const inner = s.slice(1, -1).trim();
		if (inner === '') return [];
		return splitTopLevel(inner, ',').map((x) => parseScalar(x.trim()));
	}
	if (s.startsWith('{') && s.endsWith('}')) {
		return parseInlineMap(s);
	}
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	if (s === 'null' || s === '~') return null;
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
	return s;
}

/** Parse an inline flow mapping `{a: 1, b: two}` into a nested object. */
function parseInlineMap(s: string): Record<string, unknown> {
	const inner = s.slice(1, -1).trim();
	const obj: Record<string, unknown> = {};
	if (inner === '') return obj;
	for (const part of splitTopLevel(inner, ',')) {
		const kv = /^([^:]+):\s*(.*)$/.exec(part.trim());
		if (kv) obj[kv[1].trim()] = parseScalar(kv[2].trim());
		else obj[part.trim()] = parseScalar(part.trim());
	}
	return obj;
}

/** Split on `sep`, ignoring separators inside quotes or nested [ ] / { }. */
function splitTopLevel(s: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr: string | null = null;
	let cur = '';
	for (const ch of s) {
		if (inStr) {
			cur += ch;
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
		if (ch === '[' || ch === '{') depth++;
		if (ch === ']' || ch === '}') depth--;
		if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
		cur += ch;
	}
	if (cur.trim() !== '') out.push(cur);
	return out;
}
