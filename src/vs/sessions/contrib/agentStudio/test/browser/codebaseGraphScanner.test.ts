/*---------------------------------------------------------------------------------------------
 *  codebaseGraphScanner.test.ts — 文件扫描（含 keepDirs 例外下钻）回归测试。
 *
 *  背景（2026-09-09）：扫描逻辑从 `codebaseGraphService.ts` 拆到 `codebaseGraphScanner.ts`。
 *  这段逻辑（尤其 keepDirs 例外）一旦出错会**直接改变索引范围**，而该错误只有用户重建
 *  索引后才会暴露——故搬迁后必须补测试锁住。
 *
 *  覆盖：
 *  - 排除目录被跳过 / 支持扩展名才进结果
 *  - keepDirs **精确命中**：被排除目录仍全扫
 *  - keepDirs **祖先**：只沿 keep 路径下钻，不遍历兄弟目录（防 Content 等巨型目录爆扫）
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphScanner.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CodebaseGraphScanner } from '../../browser/codebaseGraphScanner.js';
import { matchesExcludeDir } from '../../common/codebaseIndexDefaults.js';

/** 归一化路径（Windows / POSIX 一致），用作 mock 的 key。 */
function norm(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\/([a-zA-Z]:)/, '$1');
}

interface MockEntry { name: string; isDirectory: boolean; children?: MockEntry[] }

/** 以 fsPath 为 key 的只读目录树 mock（实现 IFileService 所需的 resolve/stat）。 */
class MockFileService {
	private readonly _dirs = new Map<string, MockEntry[]>();

	/** dir 形如 '/root/src'，entries 为其直接子项。 */
	addDir(dir: string, entries: MockEntry[]): this {
		this._dirs.set(norm(dir), entries);
		return this;
	}

	async resolve(uri: URI): Promise<any> {
		const children = this._dirs.get(norm(uri.fsPath)) ?? [];
		return {
			children: children.map(c => ({
				name: c.name,
				isDirectory: c.isDirectory,
				isFile: !c.isDirectory,
				resource: URI.file(`${norm(uri.fsPath).replace(/\/$/, '')}/${c.name}`),
			})),
		};
	}

	async stat(uri: URI): Promise<any> {
		const isDir = this._dirs.has(norm(uri.fsPath));
		return { isDirectory: isDir, isFile: !isDir };
	}
}

/** 排除匹配的极简 stub（语义与 resolver 一致，由 matchesExcludeDir 单测保证）。 */
const excludeResolverStub = {
	isExcluded: (name: string, excludeDirs: Set<string>) => matchesExcludeDir(name, excludeDirs),
} as any;

const logStub = { info() { }, debug() { }, warn() { }, error() { } } as any;
const token = CancellationToken.None;

function scanner(fs: MockFileService): CodebaseGraphScanner {
	return new CodebaseGraphScanner(excludeResolverStub, fs as any, logStub);
}

const dir = (name: string, children?: MockEntry[]): MockEntry => ({ name, isDirectory: true, children });
const file = (name: string): MockEntry => ({ name, isDirectory: false });

function basenames(paths: string[]): string[] {
	return paths.map(p => norm(p).split('/').pop()!).sort();
}

suite('CodebaseGraphScanner (2026-09-09 extracted)', () => {

	test('collects indexable files and skips excluded dirs', async () => {
		const fs = new MockFileService()
			.addDir('/root', [dir('src'), dir('node_modules'), file('readme.md')])
			.addDir('/root/src', [file('a.ts'), file('b.txt')])
			.addDir('/root/node_modules', [file('dep.ts')]);

		const files = await scanner(fs).scanFiles('/root', new Set(['node_modules']), undefined, token);

		assert.deepStrictEqual(basenames(files), ['a.ts'], 'only supported ext in non-excluded dirs');
	});

	test('cancellation and depth guard do not throw', async () => {
		const fs = new MockFileService().addDir('/root', [file('a.ts')]);
		const cancelled = { isCancellationRequested: true } as CancellationToken;
		const files = await scanner(fs).scanFiles('/root', new Set(), undefined, cancelled);
		assert.strictEqual(files.length, 0, 'cancelled scan returns nothing');
	});

	test('keepDirs exact hit: excluded dir is still fully scanned', async () => {
		const fs = new MockFileService()
			.addDir('/root', [dir('build'), dir('src')])
			.addDir('/root/build', [file('gen.ts')])
			.addDir('/root/src', [file('app.ts')]);

		const files = await scanner(fs).scanFiles('/root', new Set(['build']), undefined, token, ['build']);

		assert.deepStrictEqual(basenames(files), ['app.ts', 'gen.ts'], 'keep=build rescans build/');
	});

	test('keepDirs ancestor: descends only along the keep path (no sibling traversal)', async () => {
		// keep=content/script 时：只沿 Content/Script 下钻，Content/Art 必须被跳过
		const fs = new MockFileService()
			.addDir('/root', [dir('Content')])
			.addDir('/root/Content', [dir('Script'), dir('Art')])
			.addDir('/root/Content/Script', [file('s.ts')])
			.addDir('/root/Content/Art', [file('a.ts')]);

		const files = await scanner(fs).scanFiles('/root', new Set(['Content']), undefined, token, ['Content/Script']);

		assert.deepStrictEqual(
			basenames(files),
			['s.ts'],
			'excluded ancestor must be descended only along the keep path',
		);
	});

	test('★★ 凭据 / 密钥名恒不进索引（2026-09-13 新增的显式判定）', async () => {
		const fs = new MockFileService()
			.addDir('/root', [file('auth.json'), file('id_rsa'), dir('.ssh'), file('a.ts')])
			.addDir('/root/.ssh', [file('id_rsa'), file('config')]);

		const files = await scanner(fs).scanFiles('/root', new Set(), undefined, token);

		// ⚠ 说明：今天这些名字**恰好**也被「点开头跳过」/「扩展名白名单」挡住 ——
		// 本用例钉的是**结果**（敏感名绝不出现于索引范围），显式判定的**存在**由
		// `guardrailWiring` 的源码级不变量钉住。二者缺一：只钉结果的话，将来白名单
		// 加入 `.json` 时本用例会**恰好**开始失败（那也算防线），但没有它就无法
		// 定位「是谁该负责跳过」。
		assert.deepStrictEqual(basenames(files), ['a.ts'], '凭据名不得进索引结果');
	});

	test('progress callback is invoked with scan messages', async () => {
		const fs = new MockFileService().addDir('/root', [file('a.ts')]);
		const msgs: string[] = [];
		await scanner(fs).scanFiles('/root', new Set(), undefined, token, undefined, m => msgs.push(m));

		assert.ok(msgs.some(m => m.includes('扫描目录')), 'start progress');
		assert.ok(msgs.some(m => m.includes('扫描完成')), 'done progress');
	});
});
