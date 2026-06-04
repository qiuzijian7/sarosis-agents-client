/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WikiTagService — 直接读写 WIKI_ROOT 下的 JSON 数据文件。
 *
 * 数据流：LLM propose → proposals.json → approve → staging.json → commit → library
 *
 * 不通过 MCP Server 中转，直接操作文件系统（通过 IFileService）。
 * 与 wiki-tag-server 共享相同的文件格式，两者可以并存。
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWikiTagService, IWikiSettings } from './wikiTagService.js';
import { TAG_LEVEL_PRIORITY } from '../../common/wikiTagTypes.js';
import { AGENT_STUDIO_WIKI_ROOT_SETTING, AGENT_STUDIO_WIKI_MAX_PROPOSAL_SETTING } from '../../common/constants.js';
import type { IDomainEntry, IEntityEntry, IProposalItem, IStagingItem, ITagDefinition, ITagTreeNode, IValidationResult, IDeletionRecord, IDeletionItem, ITagRenameValidationResult, TagLevel } from '../../common/wikiTagTypes.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

// ─── Default config ────────────────────────────────────────
const DEFAULT_WIKI_ROOT = 'E:/AITools/LLM-Wiki';
const DEFAULT_MAX_PROPOSAL_COUNT = 20;

export class WikiTagServiceImpl extends Disposable implements IWikiTagService {
	declare readonly _serviceBrand: undefined;

	private _isAvailable = true;
	private _wikiRoot: string = DEFAULT_WIKI_ROOT;
	private _maxProposalCount: number = DEFAULT_MAX_PROPOSAL_COUNT;

	private readonly _onDidChangeAvailability = this._register(new Emitter<boolean>());
	readonly onDidChangeAvailability: Event<boolean> = this._onDidChangeAvailability.event;

	private readonly _onDidChangeProposals = this._register(new Emitter<void>());
	readonly onDidChangeProposals: Event<void> = this._onDidChangeProposals.event;

	private readonly _onDidChangeStaging = this._register(new Emitter<void>());
	readonly onDidChangeStaging: Event<void> = this._onDidChangeStaging.event;

	private readonly _onDidChangeLibrary = this._register(new Emitter<void>());
	readonly onDidChangeLibrary: Event<void> = this._onDidChangeLibrary.event;

	get isAvailable(): boolean {
		return this._isAvailable;
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._loadSettings();
		this.logService.info(`[WikiTagService] initialized with WIKI_ROOT=${this._wikiRoot}`);
	}

	private _loadSettings(): void {
		const root = this.configurationService.getValue<string>(AGENT_STUDIO_WIKI_ROOT_SETTING);
		const max = this.configurationService.getValue<number>(AGENT_STUDIO_WIKI_MAX_PROPOSAL_SETTING);
		if (root) { this._wikiRoot = root; }
		if (max && max > 0) { this._maxProposalCount = max; }
	}

	// ─── File helpers ────────────────────────────────────────

	private _uri(relativePath: string): URI {
		return URI.file(`${this._wikiRoot}/${relativePath}`);
	}

	private async _readJson<T>(relativePath: string): Promise<T | undefined> {
		try {
			const content = await this.fileService.readFile(this._uri(relativePath));
			return JSON.parse(content.value.toString());
		} catch (err: any) {
			if (err?.fileOperationResult === 1 /* FILE_NOT_FOUND */) {
				return undefined;
			}
			this.logService.warn(`[WikiTagService] failed to read ${relativePath}: ${err?.message}`);
			return undefined;
		}
	}

	private async _writeJson(relativePath: string, data: unknown): Promise<void> {
		const content = VSBuffer.fromString(JSON.stringify(data, null, 2));
		await this.fileService.writeFile(this._uri(relativePath), content);
	}

	private async _ensureDir(relativePath: string): Promise<void> {
		try {
			await this.fileService.createFolder(this._uri(relativePath));
		} catch {
			// Already exists
		}
	}

	// ─── Proposals (审核队列) ────────────────────────────────

	async getProposals(): Promise<IProposalItem[]> {
		const data = await this._readJson<{ proposals: IProposalItem[] }>('proposals.json');
		const proposals = data?.proposals ?? [];
		// Sort by level priority: domain > entity > L1 > L2
		return proposals.sort((a, b) => TAG_LEVEL_PRIORITY[a.level] - TAG_LEVEL_PRIORITY[b.level]);
	}

	async approveProposal(id: string): Promise<void> {
		const proposalsFile = await this._readJson<{ proposals: IProposalItem[] }>('proposals.json');
		if (!proposalsFile) { return; }

		const idx = proposalsFile.proposals.findIndex(p => p.id === id);
		if (idx === -1) { return; }

		const proposal = proposalsFile.proposals[idx];

		// Move to staging
		const stagingFile = await this._readJson<{ staging: IStagingItem[] }>('staging.json')
			?? { staging: [] };

		const stagingItem: IStagingItem = {
			id: proposal.id,
			level: proposal.level,
			name: proposal.name,
			originalName: proposal.name,
			description: proposal.description,
			domain: proposal.domain,
			parentL1: proposal.parentL1,
			synonyms: proposal.synonyms,
			approved_at: new Date().toISOString(),
		};

		stagingFile.staging.push(stagingItem);
		await this._writeJson('staging.json', stagingFile);

		// Remove from proposals
		proposalsFile.proposals.splice(idx, 1);
		await this._writeJson('proposals.json', proposalsFile);

		this._onDidChangeProposals.fire();
		this._onDidChangeStaging.fire();
		this.logService.info(`[WikiTagService] approved proposal: ${proposal.name} (${proposal.level})`);
	}

	async rejectProposal(id: string, reason?: string): Promise<void> {
		const proposalsFile = await this._readJson<{ proposals: IProposalItem[] }>('proposals.json');
		if (!proposalsFile) { return; }

		const idx = proposalsFile.proposals.findIndex(p => p.id === id);
		if (idx === -1) { return; }

		const rejected = proposalsFile.proposals[idx];

		// Write to rejected.json for LLM to query
		const rejectedFile = await this._readJson<{ rejected: Array<IProposalItem & { rejected_at: string; rejection_reason?: string }> }>('rejected.json')
			?? { rejected: [] };
		rejectedFile.rejected.push({
			...rejected,
			rejected_at: new Date().toISOString(),
			rejection_reason: reason,
		});

		// Trim to latest 200 entries to prevent unbounded growth
		if (rejectedFile.rejected.length > 200) {
			rejectedFile.rejected.sort((a, b) => b.rejected_at.localeCompare(a.rejected_at));
			rejectedFile.rejected = rejectedFile.rejected.slice(0, 200);
		}

		await this._writeJson('rejected.json', rejectedFile);

		// Remove from proposals
		proposalsFile.proposals.splice(idx, 1);
		await this._writeJson('proposals.json', proposalsFile);

		this._onDidChangeProposals.fire();
		this.logService.info(`[WikiTagService] rejected proposal: ${rejected.name}${reason ? ` (reason: ${reason})` : ''}`);
	}

	// ─── Staging (待入库) ────────────────────────────────────

	async getStagingItems(): Promise<IStagingItem[]> {
		const data = await this._readJson<{ staging: IStagingItem[] }>('staging.json');
		const items = data?.staging ?? [];
		return items.sort((a, b) => TAG_LEVEL_PRIORITY[a.level] - TAG_LEVEL_PRIORITY[b.level]);
	}

	async validateName(id: string, name: string): Promise<IValidationResult> {
		if (!name.trim()) {
			return { valid: false, message: '名称不能为空' };
		}

		const stagingFile = await this._readJson<{ staging: IStagingItem[] }>('staging.json');
		const item = stagingFile?.staging.find(s => s.id === id);
		if (!item) {
			return { valid: false, message: '找不到该条目' };
		}

		// Load existing domains and entities for duplication check
		const domains = await this.listDomains();
		const entities = await this.listEntities();
		const domainNames = Object.keys(domains);
		const entityNames = Object.keys(entities);

		if (item.level === 'domain') {
			// Domain must be globally unique
			if (domainNames.includes(name) && name !== item.originalName) {
				return { valid: false, message: `Domain "${name}" 已存在` };
			}
			if (entityNames.includes(name)) {
				return { valid: false, message: `与 Entity "${name}" 同名` };
			}
		} else if (item.level === 'entity') {
			// Entity must be globally unique
			if (entityNames.includes(name) && name !== item.originalName) {
				return { valid: false, message: `Entity "${name}" 已存在` };
			}
			if (domainNames.includes(name)) {
				return { valid: false, message: `与 Domain "${name}" 同名` };
			}
		} else {
			// L1/L2: cannot match any domain or entity name
			if (domainNames.includes(name)) {
				return { valid: false, message: `与 Domain "${name}" 同名，不允许` };
			}
			if (entityNames.includes(name)) {
				return { valid: false, message: `与 Entity "${name}" 同名，不允许` };
			}
		}

		return { valid: true };
	}

	async renameStagingItem(id: string, newName: string): Promise<IValidationResult> {
		const validation = await this.validateName(id, newName);
		if (!validation.valid) {
			return validation;
		}

		const stagingFile = await this._readJson<{ staging: IStagingItem[] }>('staging.json');
		if (!stagingFile) {
			return { valid: false, message: 'Staging file not found' };
		}

		const item = stagingFile.staging.find(s => s.id === id);
		if (!item) {
			return { valid: false, message: 'Item not found' };
		}

		item.name = newName.trim();
		await this._writeJson('staging.json', stagingFile);
		this._onDidChangeStaging.fire();

		return { valid: true };
	}

	async commitToLibrary(id: string): Promise<void> {
		const stagingFile = await this._readJson<{ staging: IStagingItem[] }>('staging.json');
		if (!stagingFile) { return; }

		const idx = stagingFile.staging.findIndex(s => s.id === id);
		if (idx === -1) { return; }

		const item = stagingFile.staging[idx];

		switch (item.level) {
			case 'domain':
				await this._commitDomain(item);
				break;
			case 'entity':
				await this._commitEntity(item);
				break;
			case 'L1':
			case 'L2':
				await this._commitTag(item);
				break;
		}

		// Remove from staging
		stagingFile.staging.splice(idx, 1);
		await this._writeJson('staging.json', stagingFile);

		this._onDidChangeStaging.fire();
		this._onDidChangeLibrary.fire();
		this.logService.info(`[WikiTagService] committed to library: ${item.name} (${item.level})`);
	}

	private async _commitDomain(item: IStagingItem): Promise<void> {
		const registry = await this._readJson<{ $schema: string; domains: Record<string, IDomainEntry> }>('domain-registry.json')
			?? { $schema: 'domain-registry/v1', domains: {} };

		registry.domains[item.name] = {
			description: item.description,
			synonyms: item.synonyms,
			cross_refs: [],
			status: 'active',
			created: new Date().toISOString().slice(0, 10),
		};

		await this._writeJson('domain-registry.json', registry);

		// Initialize domain directory
		await this._ensureDir(`domains/${item.name}`);
		await this._ensureDir(`domains/${item.name}/blocks`);
		await this._ensureDir(`domains/${item.name}/tag-index`);
		await this._writeJson(`domains/${item.name}/tag-registry.json`, {
			$schema: 'tag-registry/v1',
			domain: item.name,
			tags: {},
		});
		await this._writeJson(`domains/${item.name}/pending-tags.json`, {
			$schema: 'pending-tags/v1',
			domain: item.name,
			pending: [],
		});
	}

	private async _commitEntity(item: IStagingItem): Promise<void> {
		const entityPool = await this._readJson<{ $schema: string; entities: Record<string, IEntityEntry> }>('entity-pool.json')
			?? { $schema: 'entity-pool/v1', entities: {} };

		entityPool.entities[item.name] = {
			description: item.description,
			synonyms: item.synonyms,
			created: new Date().toISOString().slice(0, 10),
		};

		await this._writeJson('entity-pool.json', entityPool);
	}

	private async _commitTag(item: IStagingItem): Promise<void> {
		if (!item.domain) {
			this.logService.warn(`[WikiTagService] cannot commit tag without domain: ${item.name}`);
			return;
		}

		const registryFile = await this._readJson<{ $schema: string; domain: string; tags: Record<string, ITagDefinition> }>(`domains/${item.domain}/tag-registry.json`)
			?? { $schema: 'tag-registry/v1', domain: item.domain, tags: {} };

		registryFile.tags[item.name] = {
			level: item.level === 'L1' ? 1 : 2,
			synonyms: item.synonyms,
			description: item.description,
			status: 'approved',
			created: new Date().toISOString().slice(0, 10),
			parent: item.parentL1,
		};

		await this._writeJson(`domains/${item.domain}/tag-registry.json`, registryFile);
	}

	// ─── Library (已入库) ────────────────────────────────────

	async listDomains(): Promise<Record<string, IDomainEntry>> {
		const registry = await this._readJson<{ domains: Record<string, IDomainEntry> }>('domain-registry.json');
		return registry?.domains ?? {};
	}

	async listEntities(): Promise<Record<string, IEntityEntry>> {
		const pool = await this._readJson<{ entities: Record<string, IEntityEntry> }>('entity-pool.json');
		return pool?.entities ?? {};
	}

	async listTags(domain: string): Promise<Record<string, ITagDefinition>> {
		const registry = await this._readJson<{ tags: Record<string, ITagDefinition> }>(`domains/${domain}/tag-registry.json`);
		return registry?.tags ?? {};
	}

	async getTagTree(): Promise<ITagTreeNode[]> {
		const domains = await this.listDomains();
		const tree: ITagTreeNode[] = [];

		for (const [domainName, domainEntry] of Object.entries(domains)) {
			const domainNode: ITagTreeNode = {
				name: domainName,
				level: 'domain',
				description: domainEntry.description,
				children: [],
			};

			const tags = await this.listTags(domainName);
			const l1Tags = Object.entries(tags).filter(([, d]) => d.level === 1);
			const l2Tags = Object.entries(tags).filter(([, d]) => d.level === 2);

			for (const [tagName, tagDef] of l1Tags) {
				const l1Node: ITagTreeNode = {
					name: tagName,
					level: 'L1',
					description: tagDef.description,
					children: [],
				};

				// Find L2 children
				for (const [l2Name, l2Def] of l2Tags) {
					if (l2Def.parent === tagName) {
						l1Node.children.push({
							name: l2Name,
							level: 'L2',
							description: l2Def.description,
							children: [],
						});
					}
				}

				domainNode.children.push(l1Node);
			}

			// Orphan L2 tags (no parent set)
			for (const [l2Name, l2Def] of l2Tags) {
				if (!l2Def.parent) {
					domainNode.children.push({
						name: l2Name,
						level: 'L2',
						description: l2Def.description,
						children: [],
					});
				}
			}

			tree.push(domainNode);
		}

		return tree;
	}

	// ─── Settings ────────────────────────────────────────────

	async getSettings(): Promise<IWikiSettings> {
		return {
			wikiRoot: this._wikiRoot,
			maxProposalCount: this._maxProposalCount,
		};
	}

	async saveSettings(settings: IWikiSettings): Promise<void> {
		this._wikiRoot = settings.wikiRoot;
		this._maxProposalCount = settings.maxProposalCount;

		// Persist via IConfigurationService
		await this.configurationService.updateValue(AGENT_STUDIO_WIKI_ROOT_SETTING, settings.wikiRoot);
		await this.configurationService.updateValue(AGENT_STUDIO_WIKI_MAX_PROPOSAL_SETTING, settings.maxProposalCount);

		this.logService.info(`[WikiTagService] settings saved: wikiRoot=${this._wikiRoot}, maxProposalCount=${this._maxProposalCount}`);
	}

	// ─── Tag Operations (重命名 / 删除) ─────────────────────

	async validateTagRename(level: TagLevel, name: string, newName: string, domain?: string): Promise<ITagRenameValidationResult> {
		const trimmed = newName.trim();
		if (!trimmed) {
			return { valid: false, message: '名称不能为空' };
		}
		if (trimmed === name) {
			return { valid: true }; // no change
		}

		const domains = await this.listDomains();
		const entities = await this.listEntities();
		const domainNames = Object.keys(domains);
		const entityNames = Object.keys(entities);

		if (level === 'domain') {
			// New name cannot conflict with other domains
			if (domainNames.includes(trimmed)) {
				return { valid: false, message: `Domain "${trimmed}" 已存在` };
			}
			// Cannot conflict with entities
			if (entityNames.includes(trimmed)) {
				return { valid: false, message: `与 Entity "${trimmed}" 同名` };
			}
		} else if (level === 'entity') {
			// New name cannot conflict with other entities
			if (entityNames.includes(trimmed)) {
				return { valid: false, message: `Entity "${trimmed}" 已存在` };
			}
			// Cannot conflict with domains
			if (domainNames.includes(trimmed)) {
				return { valid: false, message: `与 Domain "${trimmed}" 同名` };
			}
		} else {
			// L1/L2: cannot use any Domain or Entity name
			if (domainNames.includes(trimmed)) {
				return { valid: false, message: `不可使用 Domain 名称 "${trimmed}"` };
			}
			if (entityNames.includes(trimmed)) {
				return { valid: false, message: `不可使用 Entity 名称 "${trimmed}"` };
			}
			// Check same-level duplicates within domain
			if (domain) {
				const tags = await this.listTags(domain);
				const targetLevel = level === 'L1' ? 1 : 2;
				for (const [tagName, tagDef] of Object.entries(tags)) {
					if (tagName === trimmed && tagDef.level === targetLevel && tagName !== name) {
						return { valid: false, message: `同 Domain 下 ${level} "${trimmed}" 已存在` };
					}
				}
			}
		}

		return { valid: true };
	}

	async renameTag(level: TagLevel, name: string, newName: string, domain?: string): Promise<ITagRenameValidationResult> {
		const validation = await this.validateTagRename(level, name, newName, domain);
		if (!validation.valid) {
			return validation;
		}

		const trimmed = newName.trim();
		if (trimmed === name) {
			return { valid: true };
		}

		switch (level) {
			case 'domain':
				await this._renameDomain(name, trimmed);
				break;
			case 'entity':
				await this._renameEntity(name, trimmed);
				break;
			case 'L1':
			case 'L2':
				if (!domain) {
					return { valid: false, message: '缺少 domain 参数' };
				}
				await this._renameTagInRegistry(domain, name, trimmed, level);
				break;
		}

		this._onDidChangeLibrary.fire();
		this.logService.info(`[WikiTagService] renamed ${level}: "${name}" → "${trimmed}"`);
		return { valid: true };
	}

	private async _renameDomain(oldName: string, newName: string): Promise<void> {
		const registry = await this._readJson<{ $schema: string; domains: Record<string, IDomainEntry> }>('domain-registry.json');
		if (!registry || !registry.domains[oldName]) { return; }

		// Rename key in registry
		registry.domains[newName] = registry.domains[oldName];
		delete registry.domains[oldName];
		await this._writeJson('domain-registry.json', registry);

		// Rename domain directory
		// Note: IFileService doesn't have rename, so we copy content conceptually
		// In practice, the tag-registry still references via domain field
		// Update tag-registry domain field
		const tagRegistry = await this._readJson<{ $schema: string; domain: string; tags: Record<string, ITagDefinition> }>(`domains/${oldName}/tag-registry.json`);
		if (tagRegistry) {
			tagRegistry.domain = newName;
			await this._writeJson(`domains/${oldName}/tag-registry.json`, tagRegistry);
		}
	}

	private async _renameEntity(oldName: string, newName: string): Promise<void> {
		const pool = await this._readJson<{ $schema: string; entities: Record<string, IEntityEntry> }>('entity-pool.json');
		if (!pool || !pool.entities[oldName]) { return; }

		pool.entities[newName] = pool.entities[oldName];
		delete pool.entities[oldName];
		await this._writeJson('entity-pool.json', pool);
	}

	private async _renameTagInRegistry(domain: string, oldName: string, newName: string, level: TagLevel): Promise<void> {
		const registryFile = await this._readJson<{ $schema: string; domain: string; tags: Record<string, ITagDefinition> }>(`domains/${domain}/tag-registry.json`);
		if (!registryFile || !registryFile.tags[oldName]) { return; }

		// Rename the tag key
		registryFile.tags[newName] = registryFile.tags[oldName];
		delete registryFile.tags[oldName];

		// If renaming an L1, update all L2 tags that reference it as parent
		if (level === 'L1') {
			for (const tagDef of Object.values(registryFile.tags)) {
				if (tagDef.parent === oldName) {
					tagDef.parent = newName;
				}
			}
		}

		await this._writeJson(`domains/${domain}/tag-registry.json`, registryFile);
	}

	async deleteTag(level: TagLevel, name: string, domain?: string): Promise<void> {
		const deletionItems: IDeletionItem[] = [];

		switch (level) {
			case 'domain':
				await this._deleteDomain(name, deletionItems);
				break;
			case 'entity':
				await this._deleteEntity(name, deletionItems);
				break;
			case 'L1':
			case 'L2':
				if (!domain) { return; }
				await this._deleteTagFromRegistry(domain, name, level, deletionItems);
				break;
		}

		// Write deletion record
		if (deletionItems.length > 0) {
			await this._writeDeletionRecord(domain, deletionItems);
		}

		this._onDidChangeLibrary.fire();
		this.logService.info(`[WikiTagService] deleted ${level}: "${name}" (${deletionItems.length} items)`);
	}

	private async _deleteDomain(name: string, items: IDeletionItem[]): Promise<void> {
		// Collect all tags under this domain first
		const tags = await this.listTags(name);
		for (const [tagName, tagDef] of Object.entries(tags)) {
			items.push({
				tagPath: `${name}.${tagName}`,
				level: tagDef.level === 1 ? 'L1' : 'L2',
				displayName: tagName,
			});
		}
		items.push({ tagPath: name, level: 'domain', displayName: name });

		// Remove from domain-registry
		const registry = await this._readJson<{ $schema: string; domains: Record<string, IDomainEntry> }>('domain-registry.json');
		if (registry && registry.domains[name]) {
			delete registry.domains[name];
			await this._writeJson('domain-registry.json', registry);
		}

		// Clean tag-registry
		await this._writeJson(`domains/${name}/tag-registry.json`, {
			$schema: 'tag-registry/v1',
			domain: name,
			tags: {},
		});
	}

	private async _deleteEntity(name: string, items: IDeletionItem[]): Promise<void> {
		items.push({ tagPath: name, level: 'entity', displayName: name });

		const pool = await this._readJson<{ $schema: string; entities: Record<string, IEntityEntry> }>('entity-pool.json');
		if (pool && pool.entities[name]) {
			delete pool.entities[name];
			await this._writeJson('entity-pool.json', pool);
		}
	}

	private async _deleteTagFromRegistry(domain: string, name: string, level: TagLevel, items: IDeletionItem[]): Promise<void> {
		const registryFile = await this._readJson<{ $schema: string; domain: string; tags: Record<string, ITagDefinition> }>(`domains/${domain}/tag-registry.json`);
		if (!registryFile || !registryFile.tags[name]) { return; }

		if (level === 'L1') {
			// Delete all L2 children first
			for (const [tagName, tagDef] of Object.entries(registryFile.tags)) {
				if (tagDef.parent === name && tagDef.level === 2) {
					items.push({
						tagPath: `${domain}.${name}.${tagName}`,
						level: 'L2',
						displayName: tagName,
					});
					delete registryFile.tags[tagName];
				}
			}
		}

		// Delete the tag itself
		items.push({
			tagPath: level === 'L2' && registryFile.tags[name]?.parent
				? `${domain}.${registryFile.tags[name].parent}.${name}`
				: `${domain}.${name}`,
			level,
			displayName: name,
		});
		delete registryFile.tags[name];

		await this._writeJson(`domains/${domain}/tag-registry.json`, registryFile);
	}

	private async _writeDeletionRecord(domain: string | undefined, items: IDeletionItem[]): Promise<void> {
		const deletionsFile = await this._readJson<{ deletions: IDeletionRecord[] }>('deletions.json')
			?? { deletions: [] };

		const record: IDeletionRecord = {
			id: this._generateId(),
			timestamp: new Date().toISOString(),
			domain,
			items,
			processed: false,
		};

		deletionsFile.deletions.push(record);
		await this._writeJson('deletions.json', deletionsFile);
	}

	private _generateId(): string {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async getDeletions(): Promise<IDeletionRecord[]> {
		const data = await this._readJson<{ deletions: IDeletionRecord[] }>('deletions.json');
		return (data?.deletions ?? []).filter(d => !d.processed);
	}
}
