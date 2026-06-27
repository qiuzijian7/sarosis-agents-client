/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ADR (Architecture Decision Records) Management.
 *
 * 对标 codebase-memory-mcp 的 manage_adr MCP 工具。
 * CRUD + 分节解析 + 校验。
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export interface ADR {
	id: string;
	title: string;
	status: 'proposed' | 'accepted' | 'rejected' | 'deprecated' | 'superseded';
	date: string;
	deciders?: string[];
	tags?: string[];
	sections: { [key: string]: string };
	filePath: string;
}

const ADR_DIR = 'docs/adr';

export class AdrManager {
	constructor(@IFileService private readonly _fileService: IFileService) {}

	async list(rootUri: URI): Promise<ADR[]> {
		const adrDirUri = URI.joinPath(rootUri, ADR_DIR);
		const adrs: ADR[] = [];

		try {
			const stat = await this._fileService.resolve(adrDirUri);
			if (!stat.children) { return []; }

			for (const child of stat.children) {
				if (child.isFile && (child.name.endsWith('.md') || child.name.endsWith('.mdx'))) {
					try {
						const content = await this._fileService.readFile(child.resource);
						const adr = this._parseAdr(content.value.toString(), child.resource.fsPath);
						if (adr) { adrs.push(adr); }
					} catch { /* ignore */ }
				}
			}
		} catch { /* dir doesn't exist */ }

		return adrs.sort((a, b) => b.date.localeCompare(a.date));
	}

	async get(rootUri: URI, id: string): Promise<ADR | undefined> {
		const adrs = await this.list(rootUri);
		return adrs.find(a => a.id === id);
	}

	async create(rootUri: URI, adr: Partial<ADR>): Promise<string> {
		const id = adr.id || `adr-${Date.now()}`;
		const title = adr.title || 'Untitled Decision';
		const date = adr.date || new Date().toISOString().split('T')[0];
		const status = adr.status || 'proposed';

		const content = this._renderAdr({
			id, title, status, date,
			deciders: adr.deciders,
			tags: adr.tags,
			sections: adr.sections || {
				context: 'Describe the context and problem...',
				decision: 'Describe the decision...',
				status: status,
				consequences: 'Describe the consequences...',
			},
			filePath: '',
		});

		const adrDirUri = URI.joinPath(rootUri, ADR_DIR);
		try { await this._fileService.createFolder(adrDirUri); } catch { /* might exist */ }
		const filePath = `${adrDirUri.fsPath}/${id}.md`;
		await this._fileService.writeFile(URI.file(filePath), VSBuffer.fromString(content));

		return id;
	}

	async update(rootUri: URI, id: string, sections: { [key: string]: string }): Promise<boolean> {
		const adr = await this.get(rootUri, id);
		if (!adr) { return false; }

		adr.sections = { ...adr.sections, ...sections };
		const content = this._renderAdr(adr);
		await this._fileService.writeFile(URI.file(adr.filePath), VSBuffer.fromString(content));
		return true;
	}

	async delete(rootUri: URI, id: string): Promise<boolean> {
		const adr = await this.get(rootUri, id);
		if (!adr) { return false; }
		await this._fileService.del(URI.file(adr.filePath));
		return true;
	}

	// ─── Parsing ──────────────────────────────────────────────────────────

	private _parseAdr(content: string, filePath: string): ADR | undefined {
		const lines = content.split('\n');

		// Title: first # heading
		let title = '';
		for (const line of lines) {
			const m = line.match(/^#\s+(.+)$/);
			if (m) { title = m[1]; break; }
		}
		if (!title) { return undefined; }

		// Parse front matter and sections
		const sections: { [key: string]: string } = {};
		let currentSection = '';
		let currentContent: string[] = [];

		for (const line of lines) {
			const sectionMatch = line.match(/^##?\s+(.+)$/);
			if (sectionMatch) {
				if (currentSection) { sections[currentSection.toLowerCase()] = currentContent.join('\n').trim(); }
				currentSection = sectionMatch[1].trim();
				currentContent = [];
			} else if (currentSection) {
				currentContent.push(line);
			}
		}
		if (currentSection) { sections[currentSection.toLowerCase()] = currentContent.join('\n').trim(); }

		// Extract metadata
		const id = filePath.split('/').pop()?.replace(/\.(md|mdx)$/, '') || 'unknown';
		const status = (sections['status'] as any || 'proposed') as ADR['status'];
		const dateMatch = content.match(/date:\s*(.+)/i);
		const date = dateMatch ? dateMatch[1].trim() : new Date().toISOString().split('T')[0];

		return {
			id, title, status, date,
			sections,
			filePath,
		};
	}

	private _renderAdr(adr: ADR): string {
		let content = `# ${adr.title}\n\n`;
		content += `- **Status**: ${adr.status}\n`;
		content += `- **Date**: ${adr.date}\n`;
		if (adr.deciders && adr.deciders.length > 0) {
			content += `- **Deciders**: ${adr.deciders.join(', ')}\n`;
		}
		if (adr.tags && adr.tags.length > 0) {
			content += `- **Tags**: ${adr.tags.join(', ')}\n`;
		}
		content += '\n';

		for (const [key, value] of Object.entries(adr.sections)) {
			const title = key.charAt(0).toUpperCase() + key.slice(1);
			content += `## ${title}\n\n${value}\n\n`;
		}

		return content;
	}

	validate(adr: ADR): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		if (!adr.title) { errors.push('Title is required'); }
		if (!adr.id) { errors.push('ID is required'); }
		if (!['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'].includes(adr.status)) {
			errors.push(`Invalid status: ${adr.status}`);
		}
		if (!adr.sections['context']) { errors.push('Context section is required'); }
		if (!adr.sections['decision']) { errors.push('Decision section is required'); }

		return { valid: errors.length === 0, errors };
	}
}
