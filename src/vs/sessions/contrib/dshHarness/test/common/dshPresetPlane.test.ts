/*---------------------------------------------------------------------------------------------
 *  dsh 的"agent preset plane"（报告 2.7 ⑤ / R13）—— 第 ① 步的守卫：**我们的 preset 生成物**。
 *
 *  背景（实测，2026-10-12）：preset 就是**一整行**（`- id: preset-standard` + `config.plugins: [完整行列表]`），
 *  而 `--patch` 打 preset 是**整份替换 config** ✗（只写一行我们的模块 ⇒ 官方那些行全没了 ✗）
 *  ⇒ 想给会话"官方能力 + 我们的能力"，只能**把官方 preset 逐字复制一份再追加我们的行** ✓。
 *
 *  本套件守三件事（都**离线**可跑 ✓ —— 官方的原件在 runtime 里、机器相关的路径不适合进守卫 ✓）：
 *    ① `cordis.presets.yml` 必须**恰好**等于 `baseline + preset-vssaros.rows.yml`（手改 / 漏重生成 ⇒ 红 ✓）；
 *    ② 我们的行的**行名集合**必须**恰好**等于工具面快照里"注册了工具的模块插件"（多一个少一个都红 ✓）
 *       —— 这就把报告 7.3 要的"每个 preset 的工具面 = 期望集合"接上了一半（另一半要等默认切换后才能真验 ✗）；
 *    ③ 清单接线：`vssaros-agents` 的 `dsh.bundle.patch` 必须收录这个 preset 文件、`files` 必须覆盖它
 *       （不收录 ⇒ 文件装了也没人加载 ✗；不覆盖 ⇒ 包里根本没有它 ✗）。
 *
 *  ⚠ 与 runtime 的比对（baseline 是否还等于官方那一版）**不在这里** ✗ —— 那要读 `.runtime/`（被 gitignore、
 *  且与机器有关 ✓）。它由 `node dsh-plugins/preset-sync.mjs`（check 模式）负责 ✓，生成器里会打印用了哪个版本 ✓。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGINS_REL = 'dsh-plugins';
const AGENTS_REL = 'dsh-plugins/vssaros-agents';

function repoRoot(): string | undefined {
	return fs.existsSync(path.join(process.cwd(), PLUGINS_REL, 'preset-sync.mjs')) ? process.cwd() : undefined;
}

/** 从我们的行文件里抽出被追加的行名（`name: '@vssaros/…'` ✓）。 */
function rowNamesOf(rowsText: string): string[] {
	return [...rowsText.matchAll(/^\s+name:\s*'(@vssaros\/[^']+)'\s*$/gm)].map(m => m[1]).sort();
}

/**
 * 剥注释后再扫源码 —— **必须**：本仓的注释里经常正写着被禁/被要求的写法名（例如
 * "用 `ctx.reflect.get(name, false)` 探一次"），不剥的话断言会被**自己的注释**满足 ⇒
 * 反向突变假绿 ✗（2026-10-16 实测：本文件那条 provide 幂等守卫第一版就这么假绿了 ✓）。
 */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

suite('dsh preset plane（R13 ①：我们的 preset 生成物）', () => {

	test('★ cordis.presets.yml == baseline + 我们的行（手改或漏重生成即红）', async function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const sync = await import(pathToFileURL(path.join(root!, PLUGINS_REL, 'preset-sync.mjs')).href) as {
			BASELINE_PATH: string; ROWS_PATH: string; PRESET_PATH: string; OUR_PRESET_ID: string;
			expectedPresetText: (a: string, b: string) => string;
		};
		for (const p of [sync.BASELINE_PATH, sync.ROWS_PATH, sync.PRESET_PATH]) {
			assert.ok(fs.existsSync(p), `缺文件：${path.relative(root!, p)}（跑 \`node dsh-plugins/preset-sync.mjs --write\`）`);
		}
		const baseline = fs.readFileSync(sync.BASELINE_PATH, 'utf8');
		const rows = fs.readFileSync(sync.ROWS_PATH, 'utf8');
		const actual = fs.readFileSync(sync.PRESET_PATH, 'utf8');

		// baseline 得是"官方 preset 的完整副本"：抽查几条官方标志行（防它被截断/被换成别的东西 ✗）
		for (const signature of ["name: '@deepseek-ai/dsh-agent-preset'", '        plugins:', '- id: tool-pwsh', '- id: skill-filesystem', '- id: tool-skill']) {
			assert.ok(baseline.includes(signature), `baseline 里缺官方标志行 \`${signature}\` ⇒ 它已经不是你以为的那份副本了 ✗`);
		}
		// 关键：官方 preset 的 `!!js` 标签必须**逐字保留**（解析成数据再写回来会把它变成普通字符串 ✗）
		assert.ok(/!!js/.test(baseline) && /!!js/.test(actual),
			'`!!js` 标签必须逐字保留（配置里的平台判定等靠它 ✓；被"解析再写回"就成了普通字符串 ✗）');

		assert.strictEqual(actual, sync.expectedPresetText(baseline, rows),
			'`cordis.presets.yml` 与"baseline + 我们的行"不一致 ⇒ 跑 `node dsh-plugins/preset-sync.mjs --write` 并把 diff 一起进 PR ✓');
		assert.ok(actual.includes(`id: ${sync.OUR_PRESET_ID}`), `生成物里应有 \`id: ${sync.OUR_PRESET_ID}\`（会话保存的 preset 标识 ✓）`);

		// ★ YAML 缩进下限：`plugins:` 段里的**每一行**（含注释 ✓）都必须 ≥ 10 空格。
		//   为什么非要有这条 ✗：块序列里"注释比后续项浅"会被 YAML 判为 `bad indentation of a mapping entry`，
		//   而**离线字符串比对完全看不出来** ✗ —— 2026-10-12 就是这个错让真机 `dsh plugin add` 直接拒绝安装 ✗
		//   （好在 dsh 自己把 package.json / lock / node_modules 回滚了 ✓）。这条把它提前到单测里 ✓。
		const lines = actual.split(/\r?\n/);
		const start = lines.findIndex(l => /^ {8}plugins:\s*$/.test(l));
		assert.ok(start > 0, '生成物里找不到 `        plugins:` 段 ⇒ 生成器结构变了 ✗');
		const shallow: string[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === '') { continue; }
			if (!/^ {10}/.test(line)) {
				if (/^- /.test(line)) { break; } // 出了 preset（下一个顶层行）✓ 正常结束
				shallow.push(`${i + 1}: ${line.slice(0, 60)}`);
			}
		}
		assert.deepStrictEqual(shallow, [],
			`\`plugins:\` 段里有行缩进 < 10 空格（含注释）⇒ YAML 会报 bad indentation、真机直接拒绝安装 ✗：\n${shallow.join('\n')}`);
	});

	test('★ 我们的行 == 工具面快照里"注册了工具的模块插件"（多一个少一个都红）', async function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const snapshot = JSON.parse(fs.readFileSync(path.join(root!, PLUGINS_REL, 'tools-snapshot.json'), 'utf8')) as {
			plugins: Record<string, unknown[]>;
		};
		const rowsText = fs.readFileSync(path.join(root!, AGENTS_REL, 'preset-vssaros.rows.yml'), 'utf8');

		// 快照里每个"注册了工具"的插件目录 → 它的包名 + **是不是模块插件**（`vssaros.module` 判定 ✓）
		const packages = Object.keys(snapshot.plugins).map(dir => {
			const manifest = JSON.parse(fs.readFileSync(path.join(root!, PLUGINS_REL, dir, 'package.json'), 'utf8')) as {
				name?: string; vssaros?: { module?: unknown };
			};
			assert.ok(manifest.name, `${dir} 的 package.json 没有 name`);
			return { dir, name: manifest.name!, isModule: typeof manifest.vssaros?.module === 'string' && manifest.vssaros.module.length > 0 };
		});
		// ⚠ 判据只收**模块插件** ✓：非模块插件（`vssaros-browser` / `vssaros-unreal` ✓）**不随包安装** ✗，
		//   把它们的行写进 preset 会让 preset 指向一个**没装的包** ⇒ 组合期就坏 ✗（第一次跑这条守卫就是被
		//   `@vssaros/dsh-unreal` 顶红的 ✓ —— 那次失败其实是守卫在提醒"判据要说清收哪一批" ✓）。
		const expectedNames = packages.filter(p => p.isModule).map(p => p.name).sort();
		assert.ok(expectedNames.length >= 7, `只算出 ${expectedNames.length} 个模块插件 ⇒ 判据可疑（下限 7）：${expectedNames.join(', ')}`);
		assert.deepStrictEqual(rowNamesOf(rowsText), expectedNames,
			'我们的 preset 行名单与工具面快照不一致：\n'
			+ `  快照里"注册了工具的**模块**插件"=${expectedNames.join(', ')}\n`
			+ `  preset 行=${rowNamesOf(rowsText).join(', ')}\n`
			+ '⇒ 新增/删掉一个"给模型用"的模块时，两边都要改（这正是"每个 preset 的工具面 = 期望集合"的名单 ✓）');

		// 反向：非模块插件**不许**进 preset（它们不随包安装 ⇒ 列进去 = 组合期指向不存在的包 ✗）
		const nonModule = packages.filter(p => !p.isModule).map(p => p.name);
		for (const name of nonModule) {
			assert.ok(!rowNamesOf(rowsText).includes(name),
				`${name} 不是模块插件（不随包安装）⇒ 不能写进我们的 preset ✗（组合期会指向不存在的包）`);
		}
	});

	test('★★ 双 plane 挂载的插件：`ctx.provide` 必须**幂等**（否则预设一激活就抛 ⇒ 会话整个起不来）', function () {
		// 为什么单列这条：同一个模块**既**在 host plane（`dsh-plugins/*/cordis.patch.yml` 插进 profile，
		// 启动即装）**又**在 preset plane（`preset-vssaros.rows.yml` ⇒ 生成物 `cordis.presets.yml`，
		// 会话选中它时**再 apply 一次**）—— `preset-vssaros.rows.yml` 的头部注释早就记着这个隐患
		// （"它们会被**重复挂载** ✗（页面/服务重复）"），但**没有守卫** ✗ ⇒ 2026-10-16 真机栽了：
		// 工作流 3.1 给插件加了 `ctx.provide('vssarosWorkflowEngine', …)` ⇒ 第二次 apply 抛
		// `service "…" has been registered` ⇒ **整个 preset 被判 invalid** ⇒ 凡是带它的会话
		// `session.start` 全失败（表现="点工作区 / worktree 切不过去"、界面上一句提示都没有 ✗✗）。
		// 判据：`ctx.provide(` 之前必须先**探测**一次（`ctx.reflect.get(name, false)` = 文档口径的
		// "不经 inject 要求地读"、不抛 ✓；`ctx.has(` 也算 ✓）。
		const root = repoRoot();
		if (!root) { this.skip(); }
		// ① host plane：谁有 `cordis.patch.yml`（有 = 启动即装；`disabled: true` = 那行已停用 ✓）
		const hostPlane: { name: string; dir: string; disabled: boolean }[] = [];
		for (const entry of fs.readdirSync(path.join(root!, PLUGINS_REL), { withFileTypes: true })) {
			if (!entry.isDirectory()) { continue; }
			const patchPath = path.join(root!, PLUGINS_REL, entry.name, 'cordis.patch.yml');
			if (!fs.existsSync(patchPath)) { continue; }
			const patch = fs.readFileSync(patchPath, 'utf8');
			for (const m of patch.matchAll(/^\s+name:\s*'(@vssaros\/[^']+)'\s*$/gm)) {
				hostPlane.push({ name: m[1], dir: entry.name, disabled: /^\s+disabled:\s*true\s*$/m.test(patch) });
			}
		}
		// 防空跑：patch 文件是这一族的采集面（少于 10 个 ⇒ 写法变了、本守卫静默失效 ✗）
		assert.ok(hostPlane.length >= 10, `只从 cordis.patch.yml 里认出 ${hostPlane.length} 个 host plane 行 ⇒ 采集面缩水 ✗`);
		const byName = new Map(hostPlane.map(h => [h.name, h]));
		const rows = rowNamesOf(fs.readFileSync(path.join(root!, AGENTS_REL, 'preset-vssaros.rows.yml'), 'utf8'));
		const twice = rows.map(n => byName.get(n)).filter((h): h is { name: string; dir: string; disabled: boolean } => !!h && !h.disabled);
		const disabledCount = rows.filter(n => byName.get(n)?.disabled === true).length;
		// 第 ③ 步（host 那几行 `disabled: true`）落地后本守卫自动变成"无可检"，但**采集面自检仍在** ✓
		if (disabledCount === 0) {
			assert.ok(twice.some(h => h.dir === 'vssaros-workflow'),
				'vssaros-workflow 应在"双 plane"名单里（这条守卫就是被它顶出来的 ✓）；名单变了请确认判据没失效 ✗');
		}
		// ② 逐个扫这些插件的源码：每个 `ctx.provide(` 之前必须有探测
		const offenders: string[] = [];
		const walkJs = (dir: string, out: string[] = []): string[] => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) { walkJs(full, out); continue; }
				if (e.name.endsWith('.js')) { out.push(full); }
			}
			return out;
		};
		for (const { dir } of twice) {
			const libDir = path.join(root!, PLUGINS_REL, dir, 'lib');
			if (!fs.existsSync(libDir)) { continue; }
			for (const file of walkJs(libDir)) {
				// ⚠ 必须先剥注释（见 `stripComments` 的注释：本仓注释里就写着探测写法 ⇒ 不剥会假绿 ✗）
				const text = stripComments(fs.readFileSync(file, 'utf8'));
				for (const m of text.matchAll(/ctx\.provide\(/g)) {
					const before = text.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
					if (!/reflect\.get\(|ctx\.has\(/.test(before)) {
						offenders.push(`${dir}/${path.basename(file)}：\`ctx.provide(\` 之前没有探测（reflect.get / has）`);
					}
				}
			}
		}
		assert.deepStrictEqual(offenders, [],
			'双 plane 挂载的插件里 `ctx.provide` 必须先探测再提供 —— 第二次 apply 会抛 `has been registered`，'
			+ '整个 preset 被判 invalid、该 preset 的会话全部起不来 ✗：\n' + offenders.join('\n'));
	});

	test('★ 清单接线：bundle.patch 收录 preset 文件、files 覆盖生成物（否则装了也不加载 / 包里没有）', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const pkg = JSON.parse(fs.readFileSync(path.join(root!, AGENTS_REL, 'package.json'), 'utf8')) as {
			dsh?: { bundle?: { patch?: string[] } };
			files?: string[];
		};
		const patch = pkg.dsh?.bundle?.patch ?? [];
		assert.ok(patch.includes('./cordis.presets.yml'),
			`vssaros-agents 的 dsh.bundle.patch 必须收录 './cordis.presets.yml'（不收录 ⇒ profile 组合里不会有我们的 preset ✗）：现在=${patch.join(', ')}`);
		for (const f of ['preset-standard.baseline.yml', 'preset-vssaros.rows.yml', 'cordis.presets.yml']) {
			assert.ok((pkg.files ?? []).includes(f),
				`files 必须覆盖 ${f}（否则装出来的包里没有它 ⇒ 生成物白做 ✗）：现在=${(pkg.files ?? []).join(', ')}`);
		}
	});
});
