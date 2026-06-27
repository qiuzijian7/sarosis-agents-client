/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multi-Project Support — 多项目注册、跨仓库边、项目生命周期管理。
 *
 * 对标 codebase-memory-mcp 的 list_projects / delete_project 工具 + CROSS_* 跨仓库边。
 */

import { CodebaseGraphStore } from './codebaseGraphStore.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface ProjectInfo {
	name: string;
	rootPath: string;
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	lastModified?: number;
}

export interface CrossRepoEdge {
	id: number;
	sourceProject: string;
	targetProject: string;
	sourceNodeId: number;
	targetNodeId: number;
	type: string;  // CROSS_CALLS, CROSS_IMPORTS, CROSS_HTTP_CALLS
	properties?: Record<string, any>;
}

export class ProjectRegistry {
	private _projects: Map<string, ProjectInfo> = new Map();
	private _crossEdges: CrossRepoEdge[] = [];
	private _nextCrossEdgeId = 1;

	constructor(
		private readonly _store: CodebaseGraphStore,
		@ILogService private readonly _logService: ILogService,
	) {}

	// ─── Project CRUD ─────────────────────────────────────────────────────

	registerProject(name: string, rootPath: string): void {
		this._projects.set(name, {
			name,
			rootPath,
			nodeCount: 0,
			edgeCount: 0,
			fileCount: 0,
			lastModified: Date.now(),
		});
		this._logService.info('[ProjectRegistry]', `Registered project: ${name} (${rootPath})`);
	}

	unregisterProject(name: string): void {
		this._projects.delete(name);
		// Remove cross-repo edges involving this project
		this._crossEdges = this._crossEdges.filter(
			e => e.sourceProject !== name && e.targetProject !== name
		);
		this._logService.info('[ProjectRegistry]', `Unregistered project: ${name}`);
	}

	listProjects(): ProjectInfo[] {
		// Update counts from store
		for (const [name, info] of this._projects) {
			info.nodeCount = this._store.getNodeCount(name);
			info.edgeCount = this._store.getEdgeCount(name);
			info.fileCount = this._store.getAllFileHashes(name).length;
		}
		return Array.from(this._projects.values());
	}

	getProject(name: string): ProjectInfo | undefined {
		return this._projects.get(name);
	}

	// ─── Cross-Repo Edges ────────────────────────────────────────────────

	addCrossEdge(sourceProject: string, targetProject: string, sourceNodeId: number, targetNodeId: number, type: string): void {
		this._crossEdges.push({
			id: this._nextCrossEdgeId++,
			sourceProject,
			targetProject,
			sourceNodeId,
			targetNodeId,
			type,
		});
	}

	getCrossEdges(projectName?: string): CrossRepoEdge[] {
		if (!projectName) { return this._crossEdges; }
		return this._crossEdges.filter(
			e => e.sourceProject === projectName || e.targetProject === projectName
		);
	}

	// ─── Galaxy Coordinates ──────────────────────────────────────────────

	/**
	 * Assign 3D offset coordinates to each project for galaxy visualization.
	 * Each project gets a unique offset so they don't overlap.
	 */
	getProjectOffsets(): Map<string, { x: number; y: number; z: number }> {
		const offsets = new Map<string, { x: number; y: number; z: number }>();
		const projects = Array.from(this._projects.keys());
		const radius = 500 * Math.sqrt(projects.length);

		projects.forEach((name, i) => {
			const angle = (i / projects.length) * Math.PI * 2;
			offsets.set(name, {
				x: radius * Math.cos(angle),
				y: 0,
				z: radius * Math.sin(angle),
			});
		});

		return offsets;
	}

	// ─── Persistence ─────────────────────────────────────────────────────

	toJSON(): any {
		return {
			projects: Array.from(this._projects.entries()),
			crossEdges: this._crossEdges,
			nextCrossEdgeId: this._nextCrossEdgeId,
		};
	}

	fromJSON(data: any): void {
		this._projects = new Map(data.projects || []);
		this._crossEdges = data.crossEdges || [];
		this._nextCrossEdgeId = data.nextCrossEdgeId || 1;
	}
}
