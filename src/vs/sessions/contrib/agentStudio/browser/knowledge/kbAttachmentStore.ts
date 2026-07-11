/*---------------------------------------------------------------------------------------------
 *  kbAttachmentStore.ts — 笔记附件统一管理器。
 *
 *  每篇笔记（.md）对应一个 `.attachments/` 目录，附件通过 ID 管理，解决：
 *    1. CSP 阻止 file:// 协议加载本地图片
 *    2. 附件随笔记一起复制/备份的可移植性
 *    3. 附件清理（删除笔记时同步删除附件目录）
 *
 *  目录结构：
 *    note.md
 *    note.md.bsdoc          ← Yjs 快照（Phase A 信封格式）
 *    note.attachments/      ← 附件目录
 *      manifest.json         ← [{id, filename, mimeType, size, added}]
 *      <id>.<ext>            ← 附件文件
 *
 *  用法：在 webview 中通过 `vscode-webview://...` 代理加载附件，避免 CSP 问题。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

export interface IKbAttachment {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	added: number; // epoch ms
}

/**
 * 对于宿主（kbBlocksEditorPane），返回可通过 webview 的 localResourceRoots
 * 访问的本地绝对路径（后续由 webview URI 代理映射为 `vscode-resource://`）。
 * 对于 Agent 工具，可直接读写文件系统路径。
 */
export class KbAttachmentStore {
	constructor(private readonly fileService: IFileService) {}

	/** `<note.md>` → `<note.attachments/>` */
	static dirUri(noteUri: URI): URI {
		const lastDot = noteUri.path.lastIndexOf('.');
		const namePrefix = lastDot > 0 ? noteUri.path.slice(0, lastDot) : noteUri.path;
		return URI.file(namePrefix + '.attachments');
	}

	/** 获取笔记的所有附件清单。 */
	async list(noteUri: URI): Promise<IKbAttachment[]> {
		const manifestUri = URI.joinPath(KbAttachmentStore.dirUri(noteUri), 'manifest.json');
		try {
			const content = await this.fileService.readFile(manifestUri);
			const arr = JSON.parse(content.value.toString());
			return Array.isArray(arr) ? arr : [];
		} catch {
			return [];
		}
	}

	/**
	 * 保存附件到笔记的附件目录，返回附件 ID。
	 * @param data 原始字节
	 * @param filename 原始文件名（含扩展名）
	 */
	async save(noteUri: URI, data: Uint8Array, filename: string, mimeType: string): Promise<string> {
		const dir = KbAttachmentStore.dirUri(noteUri);
		await this._ensureDir(dir);

		const id = this._newId();
		const ext = this._extension(filename);
		const fileUri = URI.joinPath(dir, `${id}${ext}`);

		await this.fileService.writeFile(fileUri, VSBuffer.wrap(data));

		const manifest = await this.list(noteUri);
		manifest.push({ id, filename, mimeType, size: data.byteLength, added: Date.now() });
		await this._writeManifest(dir, manifest);

		return id;
	}

	/** 删除附件（文件 + 清单条目）。 */
	async delete(noteUri: URI, id: string): Promise<void> {
		const dir = KbAttachmentStore.dirUri(noteUri);
		const manifest = await this.list(noteUri);
		const entry = manifest.find(a => a.id === id);
		if (entry) {
			const ext = this._extension(entry.filename);
			const fileUri = URI.joinPath(dir, `${id}${ext}`);
			try { await this.fileService.del(fileUri); } catch { /* ignore */ }
		}
		const updated = manifest.filter(a => a.id !== id);
		await this._writeManifest(dir, updated);
	}

	/** 读取附件原始字节。 */
	async read(noteUri: URI, id: string, filename: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
		const ext = this._extension(filename);
		const fileUri = URI.joinPath(KbAttachmentStore.dirUri(noteUri), `${id}${ext}`);
		try {
			const content = await this.fileService.readFile(fileUri);
			const manifest = await this.list(noteUri);
			const entry = manifest.find(a => a.id === id);
			return { bytes: content.value.buffer, mimeType: entry?.mimeType ?? 'application/octet-stream' };
		} catch {
			return undefined;
		}
	}

	/** 删除整个笔记附件目录（卸载笔记时调用）。 */
	async deleteDir(noteUri: URI): Promise<void> {
		const dir = KbAttachmentStore.dirUri(noteUri);
		try {
			await this.fileService.del(dir, { recursive: true });
		} catch { /* best-effort */ }
	}

	// -------------------------------------------------------------------
	// helpers
	// -------------------------------------------------------------------

	private async _ensureDir(dir: URI): Promise<void> {
		try {
			await this.fileService.createFolder(dir);
		} catch { /* already exists */ }
	}

	private async _writeManifest(dir: URI, manifest: IKbAttachment[]): Promise<void> {
		await this.fileService.writeFile(
			URI.joinPath(dir, 'manifest.json'),
			VSBuffer.fromString(JSON.stringify(manifest, null, 2)),
		);
	}

	private _newId(): string {
		return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	private _extension(filename: string): string {
		const i = filename.lastIndexOf('.');
		return i > 0 ? filename.slice(i) : '';
	}
}
