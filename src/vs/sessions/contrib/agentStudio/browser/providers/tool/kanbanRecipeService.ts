/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kanban Recipe Store — persistent, URL-matched extraction recipes for
 * `web_scrape_to_board`. A recipe binds a URL pattern (regex) to a Playwright
 * extraction function so that fixed sites (TAPD / Jira / GitHub Issues) can be
 * turned into task boards deterministically, without relying on the LLM to
 * parse the page snapshot every time.
 *
 * Recipes are persisted in PROFILE storage so they are available across all
 * workspaces of the current profile (site-specific selectors are usually
 * reusable regardless of the project).
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { Event, Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export const IKanbanRecipeService = createDecorator<IKanbanRecipeService>('kanbanRecipeService');

/** One task produced by a recipe's extraction function. */
export interface IRecipeTaskSpec {
	title: string;
	description?: string;
	priority?: 'low' | 'medium' | 'high';
	assignee?: string;
	dueDate?: string;
	tags?: string[];
	/** Optional per-task URL (e.g. a deep link to the issue). */
	sourceUrl?: string;
}

/** A saved scraping recipe. */
export interface IKanbanRecipe {
	/** Unique recipe name (used to reference it from tools). */
	name: string;
	/** Regex source matched against the browser page URL. */
	urlPattern: string;
	/** Optional regex flags (e.g. "i") applied when compiling `urlPattern`. */
	urlFlags?: string;
	/**
	 * Extraction function string of the form:
	 *   async (page, args) => ({ boardName, sourceUrl, tasks: IRecipeTaskSpec[] })
	 * or a bare array of IRecipeTaskSpec[]. `page` is the Playwright Page object;
	 * `args[0]` is the page URL. The return value must be JSON-serializable.
	 */
	extractFn: string;
	/** Optional fixed board name; otherwise the function's boardName (or page title) is used. */
	boardName?: string;
	/** Optional per-recipe task cap (clamped to 1..100 by the consumer). */
	maxTasks?: number;
	/** ISO timestamp when the recipe was saved. */
	createdAt?: string;
}

export interface IKanbanRecipeService {
	readonly _serviceBrand: undefined;

	/** Fired whenever the recipe set changes (add/remove). */
	readonly onDidChangeRecipes: Event<void>;

	/** All saved recipes (read-only copy). */
	getRecipes(): IKanbanRecipe[];

	/** Look up a recipe by exact name. */
	getRecipe(name: string): IKanbanRecipe | undefined;

	/** Save a recipe (upsert by name). Throws if the recipe is invalid. */
	addRecipe(recipe: IKanbanRecipe): void;

	/** Remove a recipe by name. Returns true if something was removed. */
	removeRecipe(name: string): boolean;

	/** Find the first recipe whose URL pattern matches the given page URL. */
	matchRecipe(url: string): IKanbanRecipe | undefined;
}

const STORAGE_KEY = 'saros.kanban.recipes';

export class KanbanRecipeService extends Disposable implements IKanbanRecipeService {

	readonly _serviceBrand: undefined;

	private _recipes: IKanbanRecipe[] = [];
	private readonly _onDidChangeRecipes = this._register(new Emitter<void>());
	readonly onDidChangeRecipes: Event<void> = this._onDidChangeRecipes.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._load();
	}

	private _load(): void {
		try {
			const raw = this.storageService.getObject<IKanbanRecipe[]>(STORAGE_KEY, StorageScope.PROFILE, []) ?? [];
			this._recipes = Array.isArray(raw) ? raw : [];
		} catch {
			this._recipes = [];
		}
	}

	private _save(): void {
		this.storageService.store(STORAGE_KEY, JSON.stringify(this._recipes), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	getRecipes(): IKanbanRecipe[] {
		// Return defensive copies so callers cannot mutate internal state.
		return this._recipes.map(r => ({ ...r }));
	}

	getRecipe(name: string): IKanbanRecipe | undefined {
		const found = this._recipes.find(r => r.name === name);
		return found ? { ...found } : undefined;
	}

	addRecipe(recipe: IKanbanRecipe): void {
		if (!recipe || typeof recipe.name !== 'string' || !recipe.name.trim()) {
			throw new Error('recipe.name is required');
		}
		if (typeof recipe.urlPattern !== 'string' || !recipe.urlPattern.trim()) {
			throw new Error('recipe.urlPattern is required');
		}
		// Compile the URL pattern now so a bad regex fails at save time, not run time.
		try {
			new RegExp(recipe.urlPattern, recipe.urlFlags ?? '');
		} catch (err) {
			throw new Error(`recipe.urlPattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
		}
		this._validateExtractFn(recipe.extractFn);

		const normalized: IKanbanRecipe = {
			name: recipe.name.trim(),
			urlPattern: recipe.urlPattern,
			urlFlags: recipe.urlFlags,
			extractFn: recipe.extractFn,
			boardName: recipe.boardName?.trim() || undefined,
			maxTasks: typeof recipe.maxTasks === 'number' ? recipe.maxTasks : undefined,
			createdAt: new Date().toISOString(),
		};

		const idx = this._recipes.findIndex(r => r.name === normalized.name);
		if (idx >= 0) {
			this._recipes[idx] = normalized;
		} else {
			this._recipes.push(normalized);
		}
		this._save();
		this._onDidChangeRecipes.fire();
	}

	removeRecipe(name: string): boolean {
		const before = this._recipes.length;
		this._recipes = this._recipes.filter(r => r.name !== name);
		if (this._recipes.length !== before) {
			this._save();
			this._onDidChangeRecipes.fire();
			return true;
		}
		return false;
	}

	matchRecipe(url: string): IKanbanRecipe | undefined {
		if (!url) {
			return undefined;
		}
		for (const r of this._recipes) {
			try {
				const re = new RegExp(r.urlPattern, r.urlFlags ?? '');
				if (re.test(url)) {
					return { ...r };
				}
			} catch {
				// Skip recipes with an invalid regex rather than crashing matching.
			}
		}
		return undefined;
	}

	/** Ensure extractFn evaluates to a function expression. */
	private _validateExtractFn(fn: unknown): void {
		if (typeof fn !== 'string' || !fn.trim()) {
			throw new Error('recipe.extractFn is required');
		}
		try {
			// eslint-disable-next-line no-new-func
			const compiled = new Function('return (' + fn + ');')();
			if (typeof compiled !== 'function') {
				throw new Error('extractFn did not evaluate to a function');
			}
		} catch (err) {
			throw new Error(`recipe.extractFn is not valid JS: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
