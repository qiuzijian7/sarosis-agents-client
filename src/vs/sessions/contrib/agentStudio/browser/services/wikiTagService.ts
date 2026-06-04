/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';
import type { IDomainEntry, IEntityEntry, IProposalItem, IStagingItem, ITagDefinition, ITagTreeNode, IValidationResult, IDeletionRecord, ITagRenameValidationResult, TagLevel } from '../../common/wikiTagTypes.js';

export const IWikiTagService = createDecorator<IWikiTagService>('wikiTagService');

export interface IWikiTagService {
	readonly _serviceBrand: undefined;

	/** Whether the data directory is accessible */
	readonly isAvailable: boolean;

	/** Fires when availability changes */
	readonly onDidChangeAvailability: Event<boolean>;

	/** Fires when proposals change */
	readonly onDidChangeProposals: Event<void>;

	/** Fires when staging items change */
	readonly onDidChangeStaging: Event<void>;

	/** Fires when library (committed tags) change */
	readonly onDidChangeLibrary: Event<void>;

	// ─── Proposals (审核队列) ────────────────────────────────

	/** Get all pending proposals sorted by level priority */
	getProposals(): Promise<IProposalItem[]>;

	/** Approve a proposal → moves to staging */
	approveProposal(id: string): Promise<void>;

	/** Reject a proposal → removes it, with optional reason */
	rejectProposal(id: string, reason?: string): Promise<void>;

	// ─── Staging (待入库) ────────────────────────────────────

	/** Get all staging items sorted by level priority */
	getStagingItems(): Promise<IStagingItem[]>;

	/** Rename a staging item (triggers validation) */
	renameStagingItem(id: string, newName: string): Promise<IValidationResult>;

	/** Validate a potential name for a staging item */
	validateName(id: string, name: string): Promise<IValidationResult>;

	/** Commit a staging item to the library */
	commitToLibrary(id: string): Promise<void>;

	// ─── Library (已入库) ────────────────────────────────────

	/** Get all domains */
	listDomains(): Promise<Record<string, IDomainEntry>>;

	/** Get all entities */
	listEntities(): Promise<Record<string, IEntityEntry>>;

	/** Get tags for a domain */
	listTags(domain: string): Promise<Record<string, ITagDefinition>>;

	/** Get full tag tree structure */
	getTagTree(): Promise<ITagTreeNode[]>;

	// ─── Settings ────────────────────────────────────────────

	/** Get current settings */
	getSettings(): Promise<IWikiSettings>;

	/** Save settings */
	saveSettings(settings: IWikiSettings): Promise<void>;

	// ─── Tag Operations (重命名 / 删除) ─────────────────────

	/** Validate a rename for a library tag */
	validateTagRename(level: TagLevel, name: string, newName: string, domain?: string): Promise<ITagRenameValidationResult>;

	/** Rename a library tag (Domain/Entity/L1/L2) */
	renameTag(level: TagLevel, name: string, newName: string, domain?: string): Promise<ITagRenameValidationResult>;

	/** Delete a library tag and all children, write deletion record */
	deleteTag(level: TagLevel, name: string, domain?: string): Promise<void>;

	/** Get unprocessed deletion records */
	getDeletions(): Promise<IDeletionRecord[]>;
}

export interface IWikiSettings {
	wikiRoot: string;
	maxProposalCount: number;
}
