/*---------------------------------------------------------------------------------------------
 *  项目解析 — 从 cwd 解析项目名称。
 *  1:1 复刻 agentmemory src/hooks/_project.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * 从工作目录路径解析项目名称
 * 优先级：环境变量 > 路径的末尾目录名 > 'unknown'
 */
export function resolveProject(cwd?: string): string {
	if (!cwd || typeof cwd !== 'string') return 'unknown';

	// 标准化路径
	const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');

	// 取末尾目录名
	const parts = normalized.split('/');
	const lastPart = parts[parts.length - 1];

	if (lastPart && lastPart.length > 0 && lastPart !== '.') {
		return lastPart;
	}

	return 'unknown';
}

/**
 * 从路径提取项目根目录
 */
export function resolveProjectRoot(cwd?: string): string | null {
	if (!cwd || typeof cwd !== 'string') return null;
	const normalized = cwd.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length === 0) return null;
	return parts.join('/');
}

/**
 * 获取相对路径（相对于项目根目录）
 */
export function getRelativePath(filePath: string, projectRoot?: string): string {
	if (!projectRoot) return filePath;
	const normalizedFile = filePath.replace(/\\/g, '/');
	const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	if (normalizedFile.startsWith(normalizedRoot + '/')) {
		return normalizedFile.slice(normalizedRoot.length + 1);
	}
	return filePath;
}

/**
 * 检查路径是否在项目根目录下
 */
export function isPathInProject(filePath: string, projectRoot: string): boolean {
	const normalizedFile = filePath.replace(/\\/g, '/');
	const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	return normalizedFile.startsWith(normalizedRoot + '/') || normalizedFile === normalizedRoot;
}

export class ProjectResolver {
	private _projectMap = new Map<string, string>();  // cwd → project name

	/**
	 * 注册项目映射
	 */
	register(cwd: string, projectName: string): void {
		this._projectMap.set(cwd.replace(/\\/g, '/'), projectName);
	}

	/**
	 * 解析项目名
	 */
	resolve(cwd?: string): string {
		if (cwd) {
			const normalized = cwd.replace(/\\/g, '/');
			const mapped = this._projectMap.get(normalized);
			if (mapped) return mapped;
		}
		return resolveProject(cwd);
	}

	/**
	 * 获取所有注册的项目
	 */
	getRegistered(): Array<{ cwd: string; project: string }> {
		return Array.from(this._projectMap.entries()).map(([cwd, project]) => ({ cwd, project }));
	}

	clear(): void {
		this._projectMap.clear();
	}
}
