/*---------------------------------------------------------------------------------------------
 *  工具面快照守卫（报告 7.3 的 R4/R5：清单漂移不能靠人肉报告发现）。
 *
 *  被钉住的是 `dsh-plugins/tools-snapshot.json` —— 由 `dsh-plugins/tools-snapshot.mjs` 从
 *  **插件的真实 apply()**（进程内 fake ctx）抽出来的（名字 / 必填参数 / 描述指纹）✓。
 *
 *  为什么必须有这条守卫：报告 `doc/dsh-tool-skill-mcp-report.html` 的 2.x 工具表是**手工测绘**的
 *  ⇒ 下次重构立刻过期 ✗；而"文档里的数字"只要没有机器校验就一定会腐烂 ✓（本仓已吃过 p3-06 那种
 *  "文档里有、没人跑、悄悄烂掉"的亏 ✓）。⇒ 那类文档一律**引用这份快照**，禁止手写数字 ✓。
 *
 *  三条断言：
 *    ① 抽取不空转（插件数/工具数在下限之上 ⇒ 抽取逻辑坏掉时立刻红 ✗）；
 *    ② 与快照逐条一致（新增/改名/改必填/改描述 ⇒ 红 ⇒ 必须显式 `--write` 并把 diff 进 PR ✓）；
 *    ③ 工具名**跨插件不重名**（重名 = 后注册的顶掉前一个、且失败是静默的 ✗）—— 例外表**不许腐烂** ✓。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_REL = 'dsh-plugins';

/**
 * 仓库根：与 `dshPluginPackages.test.ts` 同一口径（`process.cwd()` + 目录存在性）✓。
 * ⚠ **不能用 `import.meta.url`** ✗：本套件被 esbuild 打成 **CJS** 跑（见 runner 的 `format: 'cjs'`）⇒
 * `import.meta.url` 是 `undefined` ⇒ `pathToFileURL(undefined)` 直接抛 TypeError（第一版就这么红的 ✓）。
 */
function repoRoot(): string | undefined {
	return fs.existsSync(path.join(process.cwd(), REPO_REL, 'tools-snapshot.mjs')) ? process.cwd() : undefined;
}

/**
 * 跨插件重名例外（**必须逐条给理由**，且当重名消失时这条要删掉 ⇒ 见下面的断言 ✓）。
 *
 * **2026-10-12：现在为空** —— 这份快照曾**首次**发现 5 处重名（`browser` + `unreal_*`：
 * `vssaros-browser` / `vssaros-unreal` 与 `vssaros-ide` 各注册了一份同名工具 ✗，
 * 手工测绘的报告里一条都没有）。当时的处理是"先登记 + 钉住'重名不活'（那两包没有 `vssaros.module`）"；
 * 随后两条都落地了：① 过渡期 `vssaros-ide` 按 `ctx.get('vssarosBrowser'/'vssarosUnreal')` **让路**；
 * ② 退役（README 4.73 Step 3）把 `browser` / `unreal_*` 从 `vssaros-ide` **整族删掉** ⇒
 * **重名彻底消失**，例外表清空 ✓（下面那条"实际重名集合 == 例外表"的双向断言会盯着它不许回潮 ✓）。
 */
const KNOWN_NAME_COLLISIONS: ReadonlyArray<{ name: string; plugins: string[]; why: string }> = [];

suite('dsh 工具面快照（防止清单漂移）', () => {

	test('★ 抽取与快照逐条一致（改工具必须显式重生成快照）', async function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const mod = await import(pathToFileURL(path.join(root!, REPO_REL, 'tools-snapshot.mjs')).href) as {
			extractToolSnapshot: () => Promise<{ plugins: Record<string, unknown[]>; total: number; failures: string[] }>;
			SNAPSHOT_PATH: string;
			diffSnapshots: (a: unknown, b: unknown) => string[];
		};
		const snapshotPath = path.join(root!, REPO_REL, 'tools-snapshot.json');
		assert.ok(fs.existsSync(snapshotPath), '快照文件必须存在（跑 `node dsh-plugins/tools-snapshot.mjs --write` 生成）');

		const current = await mod.extractToolSnapshot();
		// ① 不许有插件在 apply 期抛错：抛了 ⇒ 它的工具**一条都抽不到** ⇒ 清单静默缺一块 ✗
		assert.deepStrictEqual(current.failures, [], `有插件在 apply 期抛错 ⇒ 清单会缺一块：\n${current.failures.join('\n')}`);
		// ① 不空转
		assert.ok(Object.keys(current.plugins).length >= 7, `只抽到 ${Object.keys(current.plugins).length} 个插件 ⇒ 抽取逻辑可疑（下限 7）`);
		assert.ok(current.total >= 40, `只抽到 ${current.total} 个工具 ⇒ 抽取逻辑可疑（下限 40）`);

		const stored = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
		const problems = mod.diffSnapshots(stored, current);
		assert.deepStrictEqual(problems, [],
			`工具面与快照不一致（${problems.length} 处）—— 确认是**有意**改动后跑 \`node dsh-plugins/tools-snapshot.mjs --write\`，把 diff 一起进 PR ✓：\n${problems.slice(0, 12).join('\n')}`);
	});

	test('★ 工具名跨插件不重名（例外表逐条有理由，且不许腐烂）', async function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const stored = JSON.parse(fs.readFileSync(path.join(root!, REPO_REL, 'tools-snapshot.json'), 'utf8')) as {
			plugins: Record<string, Array<{ name: string; required: string[] }>>;
		};
		const owners = new Map<string, string[]>();
		const badShape: string[] = [];
		for (const [dir, tools] of Object.entries(stored.plugins)) {
			for (const tool of tools) {
				if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || tool.required.length !== new Set(tool.required).size) {
					badShape.push(`${dir}/${tool.name}`);
				}
				owners.set(tool.name, [...(owners.get(tool.name) ?? []), dir]);
			}
		}
		assert.deepStrictEqual(badShape, [], `工具名形状/必填参数有异常（应为 [a-z][a-z0-9_]* 且必填不重复）：${badShape.join(', ')}`);

		const collisions = [...owners].filter(([, dirs]) => dirs.length > 1);
		// ③ 实际重名集合 == 例外表（**双向**：多一个 ⇒ 红；例外消失了 ⇒ 也红，逼你删掉过期的例外 ✓）
		const actual = collisions.map(([name, dirs]) => ({ name, plugins: [...dirs].sort() })).sort((a, b) => a.name.localeCompare(b.name));
		const declared = KNOWN_NAME_COLLISIONS.map(c => ({ name: c.name, plugins: [...c.plugins].sort() })).sort((a, b) => a.name.localeCompare(b.name));
		assert.deepStrictEqual(actual, declared,
			`重名集合与例外表不一致。实际=${JSON.stringify(actual)}，例外表=${JSON.stringify(declared)}\n`
			+ '新增重名 ⇒ 后注册的会**静默顶掉**前一个 ✗：要么改名，要么把它也登记进例外表并写清理由 ✓');

		// ★ 「重名不活」是不变量，不是传闻 ✓：例外表里**至少有一方**必须是"非模块插件"
		//   （`vssaros.module` 缺省 ⇒ 不随包自动安装 ⇒ 不会与另一方同装 ⇒ 重名顶不掉谁 ✓）。
		//   随包安装的判据只有 `vssaros.module` 这一份（见 `dshPluginPackages` 的同名守卫 ✓）——
		//   所以将来有人给这些插件加上 `module`，这条会**立刻红** ✓，把"一个能力悄悄消失"挡在装出问题之前 ✓。
		const modulePlugins = (dir: string): boolean => {
			const pkg = path.join(root!, REPO_REL, dir, 'package.json');
			if (!fs.existsSync(pkg)) { return false; }
			const manifest = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { vssaros?: { module?: unknown } }).vssaros;
			return typeof manifest?.module === 'string' && manifest.module.length > 0;
		};
		const liveCollisions = KNOWN_NAME_COLLISIONS.filter(c => c.plugins.every(modulePlugins));
		assert.deepStrictEqual(liveCollisions.map(c => c.name), [],
			`例外表里这些重名**已经变活**（同名的插件都是模块插件 ⇒ 会一起随包装上 ⇒ 后者静默顶掉前者 ✗）：`
			+ `${liveCollisions.map(c => `${c.name}(${c.plugins.join(' + ')})`).join(', ')}\n`
			+ '处理：要么改名，要么把其中一方从随包安装里去登记（并在这里写清理由 ✓）');
	});
});
