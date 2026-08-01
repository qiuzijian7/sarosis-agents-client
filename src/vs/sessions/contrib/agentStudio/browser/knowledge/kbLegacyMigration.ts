import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/**
 * 旧版知识库（系统 A / Hyper-Extract）存量数据迁移到 llm-wiki（系统 B）。
 *
 * 系统 A 的 session 落盘为 `<kb-storage-root>/<id>/kb.json`，其结构在引擎下线后
 * 已无稳定 schema，因此迁移采用**最佳努力、安全归档（不硬删）**策略：
 *   - 尽力从 `data.items` / `data.nodes` / `data.texts` / 递归字符串中提取可读文本；
 *   - 提取失败则把原始 JSON 作为代码块内嵌进笔记，保证数据零丢失；
 *   - 迁移成功后把旧目录移动到 `<root>/_migrated_backup_<ts>/`，便于人工回滚；
 *   - 根目录下的旧产物 `.folderRagIndex.json` 一并归档。
 *
 * 注意：这是一次性迁移工具，提取结果可能不如原引擎 `exportToNotes` 精确，
 * 但保证可用（可被 `kb_search` 全文检索）且不破坏任何原始数据。
 */

export interface LegacyKbMigrationDeps {
	fileService: IFileService;
	logService?: ILogService;
}

export interface LegacyKbMigrationReport {
	scanned: number;
	migrated: number;
	skipped: number;
	failed: string[];
	notesWritten: string[];
	archiveDir?: string;
}

const ARCHIVE_PREFIX = '_migrated_backup_';

// ─── 纯函数：payload → 可读笔记（可单测） ───────────────────────────────

export function renderLegacyNote(payload: unknown): { title: string; markdown: string } {
	const p = (payload ?? {}) as Record<string, any>;
	const meta = (p.metadata ?? {}) as Record<string, any>;
	const originalId = typeof meta.id === 'string' ? meta.id : (typeof p.id === 'string' ? p.id : '');
	const originalType = typeof meta.type === 'string' ? meta.type : (typeof p.type === 'string' ? p.type : 'unknown');
	const titleRaw = (typeof meta.title === 'string' && meta.title.trim())
		? meta.title.trim()
		: (typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : (originalId || 'legacy-kb-session'));

	const body = extractLegacyKbText(payload);
	const migratedAt = new Date().toISOString();

	let md = '';
	md += '---\n';
	md += 'migratedFrom: hyper-extract\n';
	md += `originalId: ${JSON.stringify(originalId)}\n`;
	md += `originalType: ${JSON.stringify(originalType)}\n`;
	md += `migratedAt: ${migratedAt}\n`;
	md += '---\n\n';
	md += `# ${titleRaw}\n\n`;
	if (body && body.trim()) {
		md += body.trim() + '\n';
	} else {
		md += '> 无法从旧版知识库 session 提取结构化文本，以下为原始 JSON 存档（未丢失）：\n\n';
		md += '```json\n' + safeStringify(payload) + '\n```\n';
	}
	return { title: titleRaw, markdown: md };
}

export function extractLegacyKbText(payload: unknown): string {
	if (payload == null) { return ''; }
	const data = (payload as any).data ?? payload;
	if (data && Array.isArray((data as any).items)) {
		return ((data as any).items as unknown[]).map(renderItem).filter(Boolean).join('\n\n');
	}
	if (data && Array.isArray((data as any).nodes)) {
		return ((data as any).nodes as unknown[]).map(renderNode).filter(Boolean).join('\n\n');
	}
	if (data && Array.isArray((data as any).texts)) {
		return ((data as any).texts as unknown[]).filter(t => typeof t === 'string').map(String).join('\n\n');
	}
	if (data && typeof (data as any).text === 'string' && (data as any).text.trim()) {
		return (data as any).text as string;
	}
	return collectStrings(payload, new Set([
		'embedding', 'vector', 'vectors', '__v', '_id', 'id', 'createdAt', 'updatedAt',
		'type', 'metadata', 'index', 'namespace',
	]));
}

function renderItem(item: unknown): string {
	if (item == null) { return ''; }
	if (typeof item === 'string') { return item; }
	if (typeof item !== 'object') { return String(item); }
	const obj = item as Record<string, any>;
	const lines: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		const s = valueToString(v);
		if (s) { lines.push(`${k}: ${s}`); }
	}
	return lines.join('\n');
}

function renderNode(node: unknown): string {
	if (node == null) { return ''; }
	if (typeof node === 'string') { return node; }
	if (typeof node !== 'object') { return String(node); }
	const obj = node as Record<string, any>;
	const label = obj.label ?? obj.text ?? obj.title ?? obj.name;
	const lines: string[] = [];
	if (label) { lines.push(String(label)); }
	for (const [k, v] of Object.entries(obj)) {
		if (k === 'label' || k === 'text' || k === 'title' || k === 'name') { continue; }
		const s = valueToString(v);
		if (s) { lines.push(`- ${k}: ${s}`); }
	}
	return lines.join('\n');
}

function valueToString(v: any): string {
	if (v == null) { return ''; }
	if (typeof v === 'string') { return v.trim(); }
	if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
	if (Array.isArray(v)) { return v.map(valueToString).filter(Boolean).join('; '); }
	if (typeof v === 'object') {
		const parts = Object.entries(v).map(([k, x]) => `${k}=${valueToString(x)}`).filter(Boolean);
		return parts.join(', ');
	}
	return '';
}

function collectStrings(node: any, skip: Set<string>, depth = 0, out: string[] = []): string {
	if (depth > 12 || out.length > 500) { return out.join('\n'); }
	if (node == null || typeof node === 'function') { return out.join('\n'); }
	if (typeof node === 'string') {
		const t = node.trim();
		if (t.length > 1 && !/^\d{11,}$/.test(t)) { out.push(t); }
		return out.join('\n');
	}
	if (typeof node === 'number' || typeof node === 'boolean') {
		const s = String(node);
		if (s.length > 1 && !/^\d{11,}$/.test(s)) { out.push(s); }
		return out.join('\n');
	}
	if (Array.isArray(node)) {
		for (const c of node) { collectStrings(c, skip, depth + 1, out); }
		return out.join('\n');
	}
	if (typeof node === 'object') {
		for (const [k, v] of Object.entries(node)) {
			if (skip.has(k)) { continue; }
			collectStrings(v, skip, depth + 1, out);
		}
		return out.join('\n');
	}
	return out.join('\n');
}

function safeStringify(v: unknown): string {
	try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function sanitizeFilename(name: string): string {
	let s = (name || 'legacy-kb-session').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
	if (!s) { s = 'legacy-kb-session'; }
	if (s.length > 80) { s = s.slice(0, 80); }
	return s;
}

// ─── 文件系统编排 ──────────────────────────────────────────────────────

async function dirChildren(fileService: IFileService, dir: URI): Promise<IFileStat[]> {
	try {
		const stat = await fileService.resolve(dir);
		return stat.children ?? [];
	} catch {
		return [];
	}
}

export async function migrateLegacyKbSessions(
	deps: LegacyKbMigrationDeps,
	storageRoot: URI,
	targetNotesDir: URI,
): Promise<LegacyKbMigrationReport> {
	const report: LegacyKbMigrationReport = { scanned: 0, migrated: 0, skipped: 0, failed: [], notesWritten: [] };
	const { fileService, logService } = deps;

	if (!await fileService.exists(storageRoot)) {
		logService?.info('[KB-migrate] storage root missing, nothing to migrate');
		return report;
	}
	if (!await fileService.exists(targetNotesDir)) {
		await fileService.createFolder(targetNotesDir).catch(() => undefined);
	}

	const children = await dirChildren(fileService, storageRoot);
	const legacy: { name: string; jsonUri: URI; dirUri: URI }[] = [];
	for (const child of children) {
		if (!child.isDirectory) {
			// 兼容可能存在的扁平 `<id>.kb.json`
			if (child.name.endsWith('.kb.json')) {
				legacy.push({ name: child.name, jsonUri: child.resource, dirUri: child.resource });
			}
			continue;
		}
		if (child.name.startsWith(ARCHIVE_PREFIX)) { continue; } // 跳过我们自己的归档目录
		const kbJson = URI.joinPath(child.resource, 'kb.json');
		if (await fileService.exists(kbJson)) {
			legacy.push({ name: child.name, jsonUri: kbJson, dirUri: child.resource });
		}
	}

	if (legacy.length === 0) { return report; }

	const archiveRoot = URI.joinPath(storageRoot, `${ARCHIVE_PREFIX}${Date.now()}`);
	let archiveCreated = false;

	for (const leg of legacy) {
		report.scanned++;
		try {
			const raw = (await fileService.readFile(leg.jsonUri)).value.toString();
			const payload = JSON.parse(raw);
			const { title, markdown } = renderLegacyNote(payload);

			let fileName = sanitizeFilename(title) + '.md';
			let noteUri = URI.joinPath(targetNotesDir, fileName);
			let i = 2;
			while (await fileService.exists(noteUri)) {
				fileName = `${sanitizeFilename(title)} (${i}).md`;
				noteUri = URI.joinPath(targetNotesDir, fileName);
				i++;
			}
			await fileService.writeFile(noteUri, VSBuffer.fromString(markdown));
			report.notesWritten.push(noteUri.fsPath);

			if (!archiveCreated) {
				await fileService.createFolder(archiveRoot);
				archiveCreated = true;
			}
			await fileService.move(leg.dirUri, URI.joinPath(archiveRoot, leg.name), true).catch((err) => {
				logService?.warn(`[KB-migrate] failed to archive ${leg.name}`, err);
			});

			report.migrated++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logService?.warn(`[KB-migrate] failed migrating ${leg.name}: ${msg}`);
			report.failed.push(leg.name);
		}
	}

	// 归档根目录下的旧产物 .folderRagIndex.json
	try {
		const fri = URI.joinPath(storageRoot, '.folderRagIndex.json');
		if (await fileService.exists(fri)) {
			if (!archiveCreated) { await fileService.createFolder(archiveRoot); archiveCreated = true; }
			await fileService.move(fri, URI.joinPath(archiveRoot, '.folderRagIndex.json'), true).catch(() => undefined);
		}
	} catch { /* ignore */ }

	if (archiveCreated) { report.archiveDir = archiveRoot.fsPath; }
	return report;
}
