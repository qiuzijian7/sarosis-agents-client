/*---------------------------------------------------------------------------------------------
 *  Real `IGitRepoProbe` backed by VS Code's `IFileService` (no direct `fs` access,
 *  so it works inside the renderer sandbox and respects the project's file-service rule).
 *  Implements the exact same interface `MockFileProbe` satisfies in unit tests — see
 *  gitRepoDiscovery.ts (the interface) and focusMode.ts (the mock pattern).
 *
 *  This is the production bridge between `discoverGitRepos` / `buildFolderRag` (which are
 *  pure + probe-injected) and the real filesystem, so the whole folder→RAG pipeline stays
 *  unit-testable with the mock probe while running for real in the KB import flow.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IGitRepoProbe } from './gitRepoDiscovery.js';

export class FsGitRepoProbe implements IGitRepoProbe {
	private readonly _fs: IFileService;

	constructor(fs: IFileService) {
		this._fs = fs;
	}

	async listFolder(path: string): Promise<readonly string[]> {
		try {
			const stat = await this._fs.resolve(URI.file(path));
			return (stat.children ?? []).map(c => c.name);
		} catch {
			return [];
		}
	}

	async isDirectory(path: string): Promise<boolean> {
		try {
			return (await this._fs.stat(URI.file(path))).isDirectory;
		} catch {
			return false;
		}
	}

	async readFile(path: string): Promise<string | undefined> {
		try {
			return (await this._fs.readFile(URI.file(path))).value.toString();
		} catch {
			return undefined;
		}
	}
}
