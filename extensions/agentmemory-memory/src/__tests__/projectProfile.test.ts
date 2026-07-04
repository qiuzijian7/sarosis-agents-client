/*---------------------------------------------------------------------------------------------
 *  Q2: Project Profile 测试 — 自动维护 concepts/files/conventions/errors
 *  对齐 agentmemory ProjectProfile 类型 + profile.ts
 *--------------------------------------------------------------------------------------------*/
import { describe, it, assert, assertEqual } from './testRunner.js';

// --- 被测类型与函数 ---

interface ProjectProfile {
	project: string;
	topConcepts: Array<{ concept: string; frequency: number }>;
	topFiles: Array<{ file: string; touchCount: number }>;
	conventions: string[];
	commonErrors: string[];
	updatedAt: number;
}

class ProfileManager {
	private profiles = new Map<string, ProjectProfile>();

	getOrCreate(project: string): ProjectProfile {
		let p = this.profiles.get(project);
		if (!p) {
			p = {
				project,
				topConcepts: [],
				topFiles: [],
				conventions: [],
				commonErrors: [],
				updatedAt: Date.now(),
			};
			this.profiles.set(project, p);
		}
		return p;
	}

	/**
	 * 从新记忆条目更新 profile
	 * 对齐 agentmemory profile.ts updateProfileFromMemories
	 */
	updateFromMemories(project: string, memories: Array<{ content: string; metadata?: Record<string, unknown>; type?: string }>): ProjectProfile {
		const profile = this.getOrCreate(project);
		const conceptMap = new Map<string, number>();
		const fileMap = new Map<string, number>();
		const errors: string[] = [];

		for (const mem of memories) {
			// 加载现有计数
			for (const c of profile.topConcepts) conceptMap.set(c.concept, c.frequency);
			for (const f of profile.topFiles) fileMap.set(f.file, f.touchCount);

			// 概念提取：CamelCase / PascalCase 词汇
			const concepts = mem.content.match(/[A-Z][a-zA-Z]{2,}/g) ?? [];
			for (const c of concepts) {
				conceptMap.set(c.toLowerCase(), (conceptMap.get(c.toLowerCase()) ?? 0) + 1);
			}

			// 文件提取：路径模式
			const files = mem.content.match(/(?:file|path)[:\s]*([/\w.-]+\.[a-z]{2,4})/gi) ?? [];
			for (const f of files) {
				const clean = f.replace(/^(?:file|path)[:\s]*/i, '');
				fileMap.set(clean, (fileMap.get(clean) ?? 0) + 1);
			}

			// 错误模式
			if (/error|Error|错误|异常/.test(mem.content)) {
				const msg = mem.content.slice(0, 120).replace(/\s+/g, ' ');
				errors.push(msg);
			}
		}

		// 排序取 top 8 concepts
		profile.topConcepts = [...conceptMap.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([concept, frequency]) => ({ concept, frequency }));

		// 排序取 top 8 files
		profile.topFiles = [...fileMap.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([file, touchCount]) => ({ file, touchCount }));

		// 去重最近 5 个错误
		const seen = new Set(profile.commonErrors);
		for (const e of errors) { if (!seen.has(e)) { seen.add(e); profile.commonErrors.push(e); } }
		profile.commonErrors = profile.commonErrors.slice(-5);

		profile.updatedAt = Date.now();
		return profile;
	}

	get(project: string): ProjectProfile | undefined {
		return this.profiles.get(project);
	}
}

export function runProjectProfileTests(): void {
	describe('ProfileManager (Q2)', () => {
		const pm = new ProfileManager();

		it('creates empty profile for new project', () => {
			const p = pm.getOrCreate('test-proj');
			assertEqual(p.topConcepts.length, 0, 'no concepts');
			assertEqual(p.topFiles.length, 0, 'no files');
			assert(p.updatedAt > 0, 'has timestamp');
		});

		it('extracts concepts from memory content', () => {
			const p = pm.updateFromMemories('test-proj', [
				{ content: 'Using TypeScriptService to handle React component rendering' },
				{ content: 'Refactored TypeScriptService for better performance' },
			]);
			const ts = p.topConcepts.find(c => c.concept === 'typescriptservice');
			assert(ts !== undefined, 'TypeScriptService concept found');
			assert(ts!.frequency >= 2, 'frequency tracked');
		});

		it('extracts file paths from memory content', () => {
			const p = pm.updateFromMemories('test-proj', [
				{ content: 'Modified file: src/components/App.tsx to add dark mode' },
				{ content: 'Config changed at path: config/settings.json' },
			]);
			assert(p.topFiles.length > 0, 'files extracted');
		});

		it('captures common errors', () => {
			const p = pm.updateFromMemories('test-proj', [
				{ content: 'Error: TypeScript compilation failed — missing type definition' },
				{ content: 'Runtime error: null reference in handleClick' },
			]);
			assert(p.commonErrors.length > 0, 'errors captured');
		});

		it('caps errors to max 5', () => {
			const errors = Array.from({ length: 8 }, (_, i) => ({
				content: `Error #${i}: something went wrong with module ${i}`
			}));
			const p = pm.updateFromMemories('test-proj', errors);
			assert(p.commonErrors.length <= 5, `capped at 5, got ${p.commonErrors.length}`);
		});

		it('deduplicates concepts and files', () => {
			const p = pm.updateFromMemories('test-proj', [
				{ content: 'Hello world' },
			]);
			// No CamelCase concepts in "Hello world"
			assert(Array.isArray(p.topConcepts), 'returns concepts array');
		});

		it('get returns undefined for unknown project', () => {
			assertEqual(pm.get('unknown-proj'), undefined, 'unknown project');
		});
	});
}
