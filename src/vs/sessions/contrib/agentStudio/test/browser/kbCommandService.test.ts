/*---------------------------------------------------------------------------------------------
 *  KbCommandService（知识库命令服务）单元测试 —— 2026-10-15 README 5.138「甲」第 1 期。
 *
 * ## 为什么这批动作值得单测
 * 它们的前身是 `KnowledgeBaseViewPane` 的**私有方法**，当年靠"视图永远在"这个前提活着；
 * 真机上正是这个前提不成立（dsh 引擎下同一个视图 id 被插件页接管）⇒ ⚙/🕸/配置文件夹/删除知识库
 * 四个入口**全哑**。抽成服务后它们成了**命令侧唯一入口** ⇒ 一旦行为漂移，没有第二处兜底 ✗。
 *
 * ## 覆盖
 * 路径（存储根 / 库根 / `库`·`笔记` 分区）· 目录就绪缓存 · 库清单读写 · 库增删（**含取消 / 不存在
 * 两条负路**）· op-log 落盘 · "清单变了"的广播（视图据此重载内存副本 ✓）。
 * ⚠ 全程用**内存假服务**（不碰磁盘、不弹真对话框）—— 与 `kbVectorIndex.test.ts` 同款手法 ✓。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { SIDE_GROUP, type IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import type { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import type { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import type { IAgentStudioService } from '../../common/agentStudio.js';
import type { IEmbeddingService } from '../../common/embeddingProvider.js';
import type { IRequestService } from '../../../../../platform/request/common/request.js';
import type { IWebContentExtractorService, ISharedWebContentExtractorService } from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import type { IKbNativeKernelService } from '../../browser/kbNativeKernelService.js';
import type { IMermaidInlineRenderer } from '../../browser/mermaidInlineRenderer.js';
import type { IDrawioInlineRenderer } from '../../browser/drawioInlineRenderer.js';
import { KbSettingsEditorInput } from '../../browser/kbSettingsEditorInput.js';
import { IKbCommandService, KbCommandService } from '../../browser/knowledge/kbCommandService.js';
import { STORAGE_ACTIVE, STORAGE_KB_DIR, STORAGE_VAULTS } from '../../browser/knowledge/kbVaultState.js';
import type { IKbVault } from '../../browser/views/knowledgeBase/kbTypes.js';

/** 内存文件系统（只实现本服务用到的那几个面 ✓；`exists/createFolder/del/readFile/writeFile`）。 */
class FakeFileService {
	readonly dirs = new Set<string>();
	readonly files = new Map<string, string>();
	/** 调用计数（用来钉"已就绪缓存"真的短路了 ✓）。 */
	existsCalls = 0;
	createFolderCalls = 0;

	private _key(uri: URI): string { return uri.fsPath.replace(/\\/g, '/').toLowerCase(); }

	async exists(uri: URI): Promise<boolean> {
		this.existsCalls++;
		const k = this._key(uri);
		if (this.dirs.has(k)) { return true; }
		for (const dir of this.dirs) { if (dir.startsWith(k + '/')) { return true; } }
		return this.files.has(k);
	}
	async createFolder(uri: URI): Promise<void> { this.createFolderCalls++; this.dirs.add(this._key(uri)); }
	async del(uri: URI, _opts?: unknown): Promise<void> {
		const k = this._key(uri);
		if (!await this.exists(uri)) { throw new Error(`ENOENT: ${k}`); }
		this.dirs.delete(k);
		for (const dir of [...this.dirs]) { if (dir.startsWith(k + '/')) { this.dirs.delete(dir); } }
		for (const file of [...this.files.keys()]) { if (file === k || file.startsWith(k + '/')) { this.files.delete(file); } }
	}
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const text = this.files.get(this._key(uri));
		if (text === undefined) { throw new Error(`ENOENT: ${this._key(uri)}`); }
		return { value: VSBuffer.fromString(text) };
	}
	async writeFile(uri: URI, content: VSBuffer): Promise<void> { this.files.set(this._key(uri), content.toString()); }
	/**
	 * `KbLinkGraph` 的 walk 走 `resolve` + `readFile`（见 `kbGraph.ts` ✓）；
	 * ⚠ 子项必须带 **`size`**（`KbNativeKernel.collectDocMetas` 用它算总体积 ✓ —— 漏了会让统计恒为 0 ✗）。
	 */
	async resolve(uri: URI): Promise<{ children: { resource: URI; name: string; isDirectory: boolean; mtime?: number; size?: number }[] }> {
		const k = this._key(uri);
		const children: { resource: URI; name: string; isDirectory: boolean; mtime?: number; size?: number }[] = [];
		const seen = new Set<string>();
		for (const dir of this.dirs) {
			if (!dir.startsWith(k + '/')) { continue; }
			const rest = dir.slice(k.length + 1);
			if (rest.includes('/') || seen.has(rest)) { continue; }
			seen.add(rest);
			children.push({ resource: URI.file(`${uri.fsPath}/${rest}`), name: rest, isDirectory: true });
		}
		for (const [file, text] of this.files) {
			if (!file.startsWith(k + '/')) { continue; }
			const rest = file.slice(k.length + 1);
			if (rest.includes('/') || seen.has(rest)) { continue; }
			seen.add(rest);
			children.push({ resource: URI.file(`${uri.fsPath}/${rest}`), name: rest, isDirectory: false, mtime: 1, size: text.length });
		}
		if (!children.length) { throw new Error(`ENOENT: ${k}`); }
		return { children };
	}
}

class FakeStorage {
	readonly map = new Map<string, string>();
	get(key: string, _scope: StorageScope): string | undefined { return this.map.get(key); }
	store(key: string, value: string, _scope: StorageScope, _target: StorageTarget): void { this.map.set(key, value); }
}

interface IHarness {
	readonly service: IKbCommandService;
	readonly fs: FakeFileService;
	readonly storage: FakeStorage;
	readonly info: string[];
	readonly warns: string[];
	readonly errors: string[];
	readonly confirmAnswer: { confirmed: boolean };
	readonly pickAnswer: { picked: URI[] | undefined };
	readonly dialogCalls: { confirm: number; pick: number };
	/** 收到的"清单变了"事件次数（视图就是靠它重载 ✓）。 */
	readonly changes: { count: number };
	/** `editorService.openEditor` 的调用记录（图谱 / 设置面板走它 ✓）。 */
	readonly opened: { input: unknown; group: unknown }[];
	/** 假的编辑器分组个数（`<=1` 走 SIDE_GROUP 那条分支 ✓）。 */
	readonly groups: { count: number };
	/** `openerService.open` 的调用记录（「打开知识库文件夹」走它 ✓）。 */
	readonly openedExternal: { uri: URI; opts: unknown }[];
	/** `terminalService.createTerminal` 的调用记录（飞书同步走它 ✓）。 */
	readonly terminals: unknown[];
	/** 内核服务收到的 `setBuildContext` 调用（向量重建 ✓）。 */
	readonly buildContexts: { roots: unknown[]; persistUri: unknown }[];
	/** 向量重建是否被调用过 ✓。 */
	readonly vectorBuilds: { count: number };
	/** 原生输入框（`dialogService.input`）的答复与调用记录（「导入链接」走它 ✓）。 */
	readonly inputAnswer: { confirmed: boolean; value: string };
	readonly inputCalls: { count: number; message: string };
	/** `agentStudioService` 上两个"过程反馈"通道的调用记录 ✓。 */
	readonly badges: unknown[];
	readonly progress: unknown[];
	/** `requestKbRefresh()` 的调用记录（导入 / 思维导图改完都要喊一声"该刷新了" ✓）。 */
	readonly refreshes: unknown[];
}

const HOME = 'c:/users/probe';
const DATA_ROOT = `${HOME}/.vssaros`;

function makeHarness(): IHarness {
	const fs = new FakeFileService();
	const storage = new FakeStorage();
	const info: string[] = [];
	const warns: string[] = [];
	const errors: string[] = [];
	const confirmAnswer = { confirmed: true };
	const pickAnswer: { picked: URI[] | undefined } = { picked: undefined };
	const dialogCalls = { confirm: 0, pick: 0 };
	const changes = { count: 0 };
	const opened: { input: unknown; group: unknown }[] = [];
	const groups = { count: 1 };
	const openedExternal: { uri: URI; opts: unknown }[] = [];
	const terminals: unknown[] = [];
	const buildContexts: { roots: unknown[]; persistUri: unknown }[] = [];
	const vectorBuilds = { count: 0 };
	const inputAnswer = { confirmed: false, value: 'https://' };
	const inputCalls = { count: 0, message: '' };
	const badges: unknown[] = [];
	const progress: unknown[] = [];
	const refreshes: unknown[] = [];

	// ⚠ 参数顺序必须与服务构造函数一致（DI 按序注入 ✓）；假件只实现被测路径用到的那几个面 ✓。
	const service = new KbCommandService(
		fs as unknown as IFileService,
		storage as unknown as IStorageService,
		{
			info: (m: unknown) => info.push(String(m)),
			warn: (m: unknown) => warns.push(String(m)),
			error: (m: unknown) => errors.push(String(m)),
		} as unknown as INotificationService,
		{
			confirm: async () => { dialogCalls.confirm++; return { confirmed: confirmAnswer.confirmed }; },
			input: async (opts: { message?: string } = {}) => {
				inputCalls.count++;
				inputCalls.message = String(opts.message ?? '');
				return { confirmed: inputAnswer.confirmed, values: [inputAnswer.value] };
			},
		} as unknown as IDialogService,
		{ showOpenDialog: async () => { dialogCalls.pick++; return pickAnswer.picked; } } as unknown as IFileDialogService,
		{ getValue: () => undefined } as unknown as IConfigurationService,
		{ userHome: URI.file(HOME), userDataPath: DATA_ROOT } as unknown as INativeEnvironmentService,
		{ openEditor: async (input: unknown, _opts?: unknown, group?: unknown) => { opened.push({ input, group }); return undefined; } } as unknown as IEditorService,
		{ getGroups: () => Array.from({ length: groups.count }, (_v, i) => ({ id: i + 1 })) } as unknown as IEditorGroupsService,
		{
			createTerminal: async (options: unknown) => {
				terminals.push(options);
				return { onData: () => ({ dispose: () => { } }) };
			},
			setActiveInstance: () => { }, revealTerminal: async () => { },
		} as unknown as ITerminalService,
		{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
		{ open: async (uri: URI, opts?: unknown) => { openedExternal.push({ uri, opts }); return true; } } as unknown as IOpenerService,
		{
			requestLibraryBadge: (req: unknown) => { badges.push(req); },
			reportKbProcessing: (st: unknown) => { progress.push(st); },
			requestKbRefresh: () => { refreshes.push(true); },
		} as unknown as IAgentStudioService,
		// 「导入链接」的抓取依赖（本单测只走**负路** ⇒ 这两个假件不会被真的用上 ✓）
		{} as unknown as IRequestService,
		{} as unknown as IWebContentExtractorService,
		{} as unknown as ISharedWebContentExtractorService,
		{ getActiveTag: () => 'mock/embed' } as unknown as IEmbeddingService,
		{
			invalidate: () => { }, setBuildContext: (roots: unknown[], persistUri?: unknown) => { buildContexts.push({ roots, persistUri }); },
			buildVectorIndex: async () => { vectorBuilds.count++; }, getVectorStatus: () => ({ chunkCount: 3, dimensions: 8 }),
			exportVectorToFile: async () => { }, hasActiveVault: () => false,
		} as unknown as IKbNativeKernelService,
		{ renderToSvg: async () => '' } as unknown as IMermaidInlineRenderer,
		{ renderToSvg: async () => '' } as unknown as IDrawioInlineRenderer,
		{ warn: () => { }, info: () => { }, error: () => { }, trace: () => { }, debug: () => { } } as unknown as ILogService,
	);
	service.onDidChangeVaults(() => { changes.count++; });
	return {
	service, fs, storage, info, warns, errors, confirmAnswer, pickAnswer, dialogCalls, changes,
	opened, groups, openedExternal, terminals, buildContexts, vectorBuilds, inputAnswer, inputCalls, badges, progress, refreshes,
	};
	}

/** 往假文件系统里放一个库（根 + `库`/`笔记` + 若干 md；`links` 指定双链目标名 ✓）。 */
function seedVault(h: IHarness, vault: IKbVault, notes: readonly { name: string; link?: string }[]): void {
	const root = h.service.vaultRootUri(vault).fsPath.replace(/\\/g, '/');
	h.fs.dirs.add(root.toLowerCase());
	h.fs.dirs.add(`${root}/库`.toLowerCase());
	h.fs.dirs.add(`${root}/笔记`.toLowerCase());
	for (const note of notes) {
		const body = note.link ? `# ${note.name}\n\n[[${note.link}]]\n` : `# ${note.name}\n\n正文。\n`;
		h.fs.files.set(`${root}/笔记/${note.name}.md`.toLowerCase(), body);
	}
}

/** 造一条库记录（只给必需的字段 ✓）。 */
function vault(id: string, extra: Partial<IKbVault> = {}): IKbVault {
	return { id, name: id, icon: '📚', sort: 0, sortMode: 'createdASC', closed: false, path: '', ...extra } as IKbVault;
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** 等 `void logOp(...)` 那条 fire-and-forget 链落盘（它内部有 3 个 await ✓）。 */
const flushAsyncLog = () => new Promise<void>(resolve => setTimeout(resolve, 20));

suite('AgentStudio - KbCommandService（命令要的知识库动作）', () => {

	test('路径：存储根（默认 / 用户改过两条分支）＋ 库根（customPath 优先）＋ 分区', () => {
		const h = makeHarness();
		// ① 默认：`<userHome>/.vssaros/knowledge-base`（与 `kbVaultFs.resolveActiveVaultRoot` 同值 ✓）
		assert.strictEqual(norm(h.service.kbRootUri().fsPath), `${HOME}/.vssaros/knowledge-base`);
		// ② 用户改过知识库目录 ⇒ 用它（**判别力**：这条与 ① 必须给出不同答案）
		h.storage.map.set(STORAGE_KB_DIR, 'e:/VsSarosVault');
		assert.strictEqual(norm(h.service.kbRootUri().fsPath), 'e:/vssarosvault');

		const defaultVault = vault('20260101000000-aaaaaa1');
		assert.strictEqual(norm(h.service.vaultRootUri(defaultVault).fsPath), 'e:/vssarosvault/20260101000000-aaaaaa1');
		const custom = vault('20260101000000-bbbbbb2', { customPath: 'D:/MyVault' });
		assert.strictEqual(norm(h.service.vaultRootUri(custom).fsPath), 'd:/myvault');
		assert.strictEqual(norm(h.service.sectionUri(custom, 'library').fsPath), 'd:/myvault/库');
		assert.strictEqual(norm(h.service.sectionUri(custom, 'notes').fsPath), 'd:/myvault/笔记');
		h.service.dispose();
	});

	test('目录就绪：建 根/库/笔记 三处；第二次调用被缓存短路；invalidate 后重查 ✓', async () => {
		const h = makeHarness();
		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		await h.service.ensureVaultFolders(v);
		assert.deepStrictEqual([...h.fs.dirs].sort(), ['d:/myvault', 'd:/myvault/笔记', 'd:/myvault/库'].sort());
		const created = h.fs.createFolderCalls;
		const existsBefore = h.fs.existsCalls;
		await h.service.ensureVaultFolders(v);
		assert.strictEqual(h.fs.createFolderCalls, created, '第二次不该再建目录 ✗');
		assert.strictEqual(h.fs.existsCalls, existsBefore, '第二次应被"已就绪"缓存短路（连 exists 都不该问）✗');
		// 换过目录 / 新建库都要清缓存（否则会被短路 ✗）
		h.service.invalidateVaultFolders(v.id);
		await h.service.ensureVaultFolders(v);
		assert.ok(h.fs.existsCalls > existsBefore, 'invalidate 之后必须重新判定目录 ✓');
		h.service.dispose();
	});

	test('库清单读写：storage 是**唯一真源**；`saveVaults` 只写不广播（广播只属命令侧改动 ✓）', () => {
		const h = makeHarness();
		assert.deepStrictEqual(h.service.loadVaults(), []);
		const list = [vault('a'), vault('b', { customPath: 'd:/x' })];
		h.service.saveVaults(list);
		assert.deepStrictEqual(h.service.loadVaults().map(v => v.id), ['a', 'b']);
		// storage 里的形状就是 JSON 数组（与视图 / Agent 工具同一份契约 ✓）
		assert.deepStrictEqual(JSON.parse(h.storage.map.get(STORAGE_VAULTS)!).map((v: IKbVault) => v.id), ['a', 'b']);
		// ★ 判别力：视图自己那 12 处保存（改名 / 开关库 / 排序 / 关联…）都走这个函数 ⇒ 它**一广播**，
		//   视图就会在每次保存后整页重渲染（会打断受 `_renameActive` 保护的内联重命名 ✗）。
		assert.strictEqual(h.changes.count, 0, '`saveVaults` 不许广播（广播只属命令侧那两处增删 ✗）');
		h.service.dispose();
	});

	test('① 配置文件夹为知识库：取消 ⇒ false 且清单不动；选中 ⇒ 落清单＋建目录＋设为当前＋广播 ✓', async () => {
		const h = makeHarness();
		// 取消（负路：**不许**偷偷加一个库，也不许假装成功 ✓）
		h.pickAnswer.picked = undefined;
		assert.strictEqual(await h.service.addVaultFromFolder(), false);
		assert.deepStrictEqual(h.service.loadVaults(), []);
		assert.strictEqual(h.changes.count, 0, '取消 ⇒ 不该广播（宿主也就不该重启 Host ✓）');

		h.pickAnswer.picked = [URI.file('d:/MyVault')];
		assert.strictEqual(await h.service.addVaultFromFolder(), true);
		const list = h.service.loadVaults();
		assert.strictEqual(list.length, 1);
		assert.deepStrictEqual(
			{ name: list[0].name, icon: list[0].icon, customPath: norm(list[0].customPath!), path: norm(list[0].path) },
			{ name: 'MyVault', icon: '📁', customPath: 'd:/myvault', path: 'd:/myvault' },
			'库记录的形状（name / icon / path / customPath）必须与视图那条逐字一致 ✗');
		// ⚠ 只钉"该建的建了"（不等号 ⟹ 全集合断言 ✗）：op-log 那次落盘会顺手建知识库根，属正常 ✓
		for (const dir of ['d:/myvault', 'd:/myvault/库', 'd:/myvault/笔记']) {
			assert.ok(h.fs.dirs.has(dir), `必须建 ${dir} ✓（实际：${[...h.fs.dirs].join(', ')}）`);
		}
		assert.strictEqual(h.storage.map.get(STORAGE_ACTIVE), list[0].id, '新配置的库应成为当前库 ✓');
		assert.strictEqual(h.changes.count, 1, '成功 ⇒ 广播一次 ✓');
		assert.ok(h.info.some(m => m.includes('已配置文件夹为知识库')), `应有如实提示：${JSON.stringify(h.info)}`);
		h.service.dispose();
	});

	test('② 删除知识库：不存在 ⇒ false 且**不弹确认框**；取消 ⇒ 目录还在；确认 ⇒ 真删＋换当前库 ✓', async () => {
		const h = makeHarness();
		h.service.saveVaults([vault('a', { customPath: 'd:/va' }), vault('b', { customPath: 'd:/vb' })]);
		h.service.setActiveVaultId('a');
		h.fs.dirs.add('d:/va'); h.fs.dirs.add('d:/vb'); h.fs.dirs.add('d:/va/库');
		const eventsBefore = h.changes.count;

		// 负路 1：清单里没有这个 id ⇒ 直接 false（**不许**猜、不许删第一个 ✗ —— 不可逆操作）
		assert.strictEqual(await h.service.removeVaultById('不存在'), false);
		assert.strictEqual(h.dialogCalls.confirm, 0, '没这个库时不该弹确认框 ✗');

		// 负路 2：用户在原生确认框里取消
		h.confirmAnswer.confirmed = false;
		assert.strictEqual(await h.service.removeVaultById('a'), false);
		assert.deepStrictEqual(h.service.loadVaults().map(v => v.id), ['a', 'b'], '取消 ⇒ 清单不动 ✗');
		assert.ok(h.fs.dirs.has('d:/va'), '取消 ⇒ 目录必须还在 ✗');
		assert.strictEqual(h.changes.count, eventsBefore, '取消 ⇒ 不广播（宿主不该重启 Host ✓）');

		// ★ 顺序口径（反向突变才咬出来的 ✗）：广播那一刻，订阅方（＝视图）读到的必须是**终态** ——
		//   清单里已经没有被删的库、当前库也已经换好；否则视图会在"当前库已被删掉"的中间态上做回落判断 ✗。
		const seenAtFire: { active?: string; ids: string[] }[] = [];
		h.service.onDidChangeVaults(() => { seenAtFire.push({ active: h.service.activeVaultId(), ids: h.service.loadVaults().map(v => v.id) }); });

		// 正路：确认删除
		h.confirmAnswer.confirmed = true;
		assert.strictEqual(await h.service.removeVaultById('a'), true);
		assert.deepStrictEqual(seenAtFire, [{ active: 'b', ids: ['b'] }],
			'广播时订阅方读到的必须是终态（清单已删、当前库已换）✗');
		assert.deepStrictEqual(h.service.loadVaults().map(v => v.id), ['b'], '确认 ⇒ 移出清单 ✓');
		assert.strictEqual(h.fs.dirs.has('d:/va'), false, '确认 ⇒ 目录（含子目录）真的删掉 ✓');
		assert.strictEqual(h.fs.dirs.has('d:/va/库'), false, '子目录也要没 ✓');
		assert.ok(h.fs.dirs.has('d:/vb'), '别的库不许受影响 ✗');
		assert.strictEqual(h.storage.map.get(STORAGE_ACTIVE), 'b', '当前库要落到下一个没关的 ✓');
		assert.strictEqual(h.changes.count, eventsBefore + 1, '删成功 ⇒ 广播一次 ✓');
		h.service.dispose();
	});

	test('删除失败 ⇒ 如实说（warn + op-log failure）且清单不动 ✓', async () => {
		const h = makeHarness();
		h.service.saveVaults([vault('a', { customPath: 'd:/va' })]);
		// 盘上没有这个目录 ⇒ fileService.del 抛错 ⇒ 必须接住（旧路径是让异常冒到命令层 ✗）
		assert.strictEqual(await h.service.removeVaultById('a'), false);
		assert.deepStrictEqual(h.service.loadVaults().map(v => v.id), ['a'], '删除失败 ⇒ 清单不许动 ✗');
		assert.ok(h.warns.some(m => m.includes('删除知识库失败')), `应如实报错：${JSON.stringify(h.warns)}`);
		// ⚠ 服务里 op-log 是 `void` 出去的（不拖慢命令）⇒ 这里要**等它落盘**再断言（否则是竞态假红 ✗）
		await flushAsyncLog();
		assert.ok(h.fs.files.has(`${DATA_ROOT}/knowledge-base/.op-log.jsonl`), '失败也要留痕（op-log ✓）');
		h.service.dispose();
	});

	test('op-log：落 `<存储根>/.op-log.jsonl`，补 ts 与 channel=vault ✓；根可被设置改过', async () => {
		const h = makeHarness();
		await h.service.logOp('vault.delete', 'success', { target: 'd:/x' });
		const logFile = `${DATA_ROOT}/knowledge-base/.op-log.jsonl`;
		assert.ok(h.fs.files.has(logFile), `op-log 应落在 ${logFile}（实际：${[...h.fs.files.keys()].join(', ')}）`);
		const entry = JSON.parse(h.fs.files.get(logFile)!.trim().split('\n').pop()!);
		assert.strictEqual(entry.op, 'vault.delete');
		assert.strictEqual(entry.status, 'success');
		assert.strictEqual(entry.channel, 'vault', 'channel 默认 vault（与 Agent 工具侧的 engine 区分 ✓）');
		assert.ok(typeof entry.ts === 'string' && entry.ts.length >= 20, 'ts 应被补齐 ✓');
		h.service.dispose();
	});

	test('③ 关系图谱：根只含 库+笔记；无库 / 空图 ⇒ 如实提示且**不开编辑器**；有图 ⇒ 开一次 ✓', async () => {
		const h = makeHarness();

		// 负路 1：一个库都没有 ⇒ 提示 + **不开编辑器**（视图旧行为是静默 return；命令这条路上静默就是"没反应" ✗）
		await h.service.openGraph();
		assert.strictEqual(h.opened.length, 0, '没有可用库时不该开编辑器 ✗');
		assert.ok(h.info.some(m => m.includes('还没有可用的知识库')), `应如实提示"还没有可用的知识库…"（静默 = 点了没反应 ✗）：${JSON.stringify(h.info)}`);

		// 负路 2：库在、但没有任何带双链的 md ⇒ 空图 ⇒ 提示 + 不开编辑器
		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		await h.service.openGraph();
		assert.strictEqual(h.opened.length, 0, '空图不该开编辑器 ✗');
		assert.ok(h.info.some(m => m.includes('暂无可绘制的关系')), `应如实提示"知识库暂无可绘制的关系…"：${JSON.stringify(h.info)}`);

		// 正路：两篇笔记、其中一篇指向另一篇 ⇒ 2 节点 + 1 条边 ⇒ 开一次（单分组 ⇒ SIDE_GROUP ✓）
		seedVault(h, v, [{ name: '甲', link: '乙' }, { name: '乙' }]);
		const data = await h.service.noteGraphData(v);
		assert.deepStrictEqual(data.nodes.map(n => n.label).sort(), ['乙', '甲'], `节点应来自两篇 md：${JSON.stringify(data.nodes.map(n => n.label))}`);
		assert.strictEqual(data.links.length, 1, `[[乙]] 应产生一条边：${JSON.stringify(data.links)}`);
		await h.service.openGraph();
		assert.strictEqual(h.opened.length, 1, '有图 ⇒ 开一次编辑器 ✓');
		assert.strictEqual(h.opened[0].group, SIDE_GROUP, '只有一个分组 ⇒ 开在侧分组（`SIDE_GROUP` ✓ —— 别写死数字 ✗）');
		assert.ok(h.info.length === 2, `不该多出提示：${JSON.stringify(h.info)}`);

		// 根只含 库 / 笔记 两个分区（关联的代码仓库不进图谱 ✓）
		assert.deepStrictEqual(h.service.graphRoots(v).map(r => `${r.section}:${norm(r.uri.fsPath)}`),
			['library:d:/myvault/库', 'notes:d:/myvault/笔记']);
		h.service.dispose();
	});

	test('④ 设置面板：host 的**数据面**不依赖视图（库在 ⇒ 库/统计/关联数；库不在 ⇒ 全空且如实）', async () => {
		const h = makeHarness();

		// 负路：一个库都没有 ⇒ host 说"没有可用库"，统计全 0（面板据此不展示统计区块 ✓）
		await h.service.openSettings();
		assert.strictEqual(h.opened.length, 1, '没有库也要开面板（面板自己会显示空态 ✓）');
		const emptyInput = h.opened[0].input as KbSettingsEditorInput;
		assert.ok(emptyInput instanceof KbSettingsEditorInput, '开的必须是设置面板 Input ✓');
		assert.strictEqual(emptyInput.host.hasActiveVault(), false, '没有库 ⇒ hasActiveVault=false ✓');
		assert.strictEqual(emptyInput.host.getDocCount(), 0);
		assert.strictEqual(emptyInput.host.getLinkedWorkspaceCount(), 0);

		// 正路：库在 + 盘上有两篇笔记 ⇒ 统计来自**真盘**（只 stat、不建索引 ✓）
		// ⚠ 两个字段是**不同**的：`linkedWorkspaces` 只用来显示"已关联工作区数"；
		//   `linkedFolders` 才是进**索引根**的那些（视图 `buildRoots()` 用的就是它 ✓ —— 别混 ✗）
		const v = vault('20260101000000-aaaaaa1', {
			customPath: 'd:/MyVault',
			linkedWorkspaces: ['/ws/a', '/ws/b'],
			linkedFolders: ['/ws/a', '/ws/b'],
		} as Partial<IKbVault>);
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		seedVault(h, v, [{ name: '甲' }, { name: '乙' }]);
		const stats = await h.service.docStats(v);
		assert.deepStrictEqual(stats.docs, 2, `统计应来自盘上的两篇笔记：${JSON.stringify(stats)}`);
		assert.ok(stats.bytes > 0, '体积应 > 0 ✓');

		h.opened.length = 0;
		await h.service.openSettings('feishu');
		const input = h.opened[0].input as KbSettingsEditorInput;
		assert.strictEqual(input.focusSection, 'feishu', '定位分组要透传（「同步飞书」按钮就靠它 ✓）');
		assert.strictEqual(input.host.hasActiveVault(), true);
		assert.strictEqual(input.host.getDocCount(), 2, 'host 的 docCount 用打开那一刻的快照 ✓');
		assert.strictEqual(input.host.getLinkedWorkspaceCount(), 2, '关联工作区数取自库记录 ✓');
		assert.strictEqual(input.host.isSqliteActive(), false, '2 篇 < 2000 阈值 ⇒ 未启用 SQLite ✓（同一条规则 ✓）');
		assert.strictEqual(norm(input.host.getRootPath()), `${HOME}/.vssaros/knowledge-base`, '根目录口径与 kbRootUri 同源 ✓');
		// 索引根 = 库 + 笔记 + 关联的代码仓库（顺序：库、笔记、逐个关联 ✓）
		assert.deepStrictEqual(h.service.indexRoots(v).map(r => norm(r.uri.fsPath)),
			['d:/myvault/库', 'd:/myvault/笔记', '/ws/a', '/ws/b']);
		h.service.dispose();
	});

	test('④ 设置面板：「打开知识库文件夹」走系统打开；没有库时**不打开**任何东西 ✓', async () => {
		const h = makeHarness();
		await h.service.openKbFolder();
		assert.strictEqual(h.openedExternal.length, 0, '没有库 ⇒ 不该打开任何路径 ✗');

		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		await h.service.openKbFolder();
		assert.strictEqual(h.openedExternal.length, 1);
		assert.strictEqual(norm(h.openedExternal[0].uri.fsPath), 'd:/myvault', '应打开该库的根目录 ✓');
		assert.deepStrictEqual(h.openedExternal[0].opts, { openExternal: true }, '必须走系统打开（资源管理器 ✓）');
		h.service.dispose();
	});

	test('④ 飞书同步负路：没有库 ⇒ 如实提示且**不起终端**（静默＝点了没反应 ✗）', async () => {
		const h = makeHarness();
		await h.service.feishuSync('apply');
		assert.strictEqual(h.terminals.length, 0, '没有库时不该起终端 ✗');
		assert.ok(h.warns.some(m => m.includes('没有可用的知识库 Vault')), `应如实提示：${JSON.stringify(h.warns)}`);
		h.service.dispose();
	});

	test('④ 向量重建：先给共享内核**建上下文**（含缓存落点），再建索引 ✓', async () => {
		const h = makeHarness();
		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		const input = await (async () => { await h.service.openSettings(); return h.opened[0].input as KbSettingsEditorInput; })();
		input.host.rebuildVectorIndex();                       // host 那侧是 fire-and-forget ✓
		await new Promise<void>(resolve => setTimeout(resolve, 20));
		assert.strictEqual(h.vectorBuilds.count, 1, '应调用一次 buildVectorIndex ✓');
		assert.strictEqual(h.buildContexts.length, 1, '构建前必须 setBuildContext（否则共享内核不知道库在哪 ✗）');
		assert.deepStrictEqual(h.buildContexts[0].roots, h.service.indexRoots(v), '上下文用的根应与 indexRoots 一致 ✓');
		assert.strictEqual(norm((h.buildContexts[0].persistUri as URI).fsPath), 'd:/myvault/.kbkernel.json', '缓存落点 = <库根>/.kbkernel.json ✓');
		h.service.dispose();
	});

	test('⑤ 导入链接：取消 / 只填了 https:// ⇒ **零副作用**（不抓取、不动徽标、不写 op-log）', async () => {
		const h = makeHarness();

		// 负路 1：用户在原生输入框里取消。
		// ⚠ 这里必须用**一个像样的 URL**：真实 `input()` 取消时**仍会回带当前文本** ⇒ 若拿占位串来验，
		//   下面那条"值 == https://"的守卫也会把它拦住 ⇒ **判不出 confirmed 这条守卫**（反向突变 M1 就假绿了 ✗）。
		h.inputAnswer.confirmed = false;
		h.inputAnswer.value = 'https://example.com/some-article';
		await h.service.importFromUrl();
		assert.strictEqual(h.inputCalls.count, 1, '应该弹一次原生输入框 ✓');
		assert.ok(/导入链接/.test(h.inputCalls.message), `输入框文案应是"导入链接…"：${h.inputCalls.message}`);
		assert.strictEqual(h.badges.length, 0, '取消 ⇒ 不许动徽标 ✗');
		assert.strictEqual(h.progress.length, 0, '取消 ⇒ 不许报"处理中" ✗（哪怕输入框里已经有 URL）');

		// 负路 2：确认了，但值是默认占位（只有 `https://`）⇒ 同样不抓取
		h.inputAnswer.confirmed = true;
		h.inputAnswer.value = 'https://';
		await h.service.importFromUrl();
		assert.strictEqual(h.badges.length, 0, '只填占位串 ⇒ 不算 URL、不许动徽标 ✗');
		assert.strictEqual(h.progress.length, 0);

		// 负路 3：空白
		h.inputAnswer.value = '   ';
		await h.service.importFromUrl();
		assert.strictEqual(h.badges.length, 0, '空白 ⇒ 同上 ✗');
		// 三条负路都不该在 op-log 里留 `kb.importUrl`（只有真的去抓了才记 ✓）
		await flushAsyncLog();
		const opLog = h.fs.files.get(`${DATA_ROOT}/knowledge-base/.op-log.jsonl`) ?? '';
		assert.ok(!opLog.includes('kb.importUrl'), `负路不该留 kb.importUrl 痕迹：${opLog.slice(0, 120)}`);
		h.service.dispose();
	});

	test('⑥ 思维导图：没有库 ⇒ 如实提示且**不开编辑器**；打开 .canvas：正常 ⇒ CanvasEditorInput，坏文件 ⇒ 退化成文本 ✓', async () => {
		const h = makeHarness();

		// 负路：没有可用库
		await h.service.openMindmap();
		assert.strictEqual(h.opened.length, 0, '没有库 ⇒ 不该开任何编辑器 ✗');
		assert.ok(h.info.some(m => m.includes('还没有可用的知识库')), `应如实提示"还没有可用的知识库…"（静默 = 点了没反应 ✗）：${JSON.stringify(h.info)}`);

		// 正路：笔记区有一份合法 .canvas ⇒ 用 CanvasEditorInput 打开（单分组 ⇒ SIDE_GROUP ✓）
		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		const canvas = 'd:/myvault/笔记/mindmap.canvas';
		h.fs.dirs.add('d:/myvault'); h.fs.dirs.add('d:/myvault/笔记'); h.fs.dirs.add('d:/myvault/库');
		h.fs.files.set(canvas, JSON.stringify({ nodes: [{ id: 'n1' }], edges: [] }));
		await h.service.openMindmap();
		assert.strictEqual(h.opened.length, 1, '有 .canvas ⇒ 开一次编辑器 ✓');
		// ⚠ 用 constructor.name 判（不 import 那个输入类 ⇒ 单测不必拖进整条 canvas 渲染链 ✓）。
		// ⚠ 写成模糊匹配：打包器会给类名加下划线前缀（实测 `_CanvasEditorInput`）⇒ 精确等于会**假红** ✗。
		const canvasName = (h.opened[0].input as { constructor: { name: string } }).constructor.name;
		assert.ok(/CanvasEditorInput/.test(canvasName), `应是 CanvasEditorInput：${canvasName}`);
		assert.strictEqual(h.opened[0].group, SIDE_GROUP, '只有一个分组 ⇒ 侧分组 ✓');

		// 负路：坏 .canvas（非法 JSON）⇒ **退化成纯文本编辑器**（不许静默什么都不开 ✗）
		h.opened.length = 0;
		h.fs.files.set(canvas, '{ 这不是 JSON');
		await h.service.openCanvasEditor(URI.file(canvas));
		assert.strictEqual(h.opened.length, 1, '解析失败也必须开出**纯文本**编辑器（退化路径 ✓）');
		const fallback = h.opened[0].input as { constructor: { name: string }; resource?: unknown };
		assert.ok(!/CanvasEditorInput/.test(fallback.constructor.name), '坏文件不该再走 canvas 编辑器 ✗');
		assert.ok(fallback.resource, '退化路径应传 { resource, options } 那种"打开普通文件"的形状 ✓');
		h.service.dispose();
	});

	test('⑥ 思维导图：拿不到 LLM 模型 ⇒ **不生成也不喊刷新**（不假装干过活 ✓）', async () => {
		const h = makeHarness();
		const v = vault('20260101000000-aaaaaa1', { customPath: 'd:/MyVault' });
		h.service.saveVaults([v]);
		h.service.setActiveVaultId(v.id);
		seedVault(h, v, [{ name: '甲' }, { name: '乙' }, { name: '丙' }]);
		// 假 agentStudioService 上没有 `createKbChatModel` ⇒ resolveKbChatModel 返回 null ⇒ 早退 ✓
		await h.service.generateMindmapAfterImport();
		assert.strictEqual(h.refreshes.length, 0, '没模型 ⇒ 不许喊刷新（那会让视图白刷一次 ✗）');
		assert.strictEqual(h.opened.length, 0);
		h.service.dispose();
	});

	test('服务是单例注册面的一部分（IKbCommandService 可被 DI 解出 ✓）', () => {
		// 命令侧现在**只**经它拿动作（不再取视图）⇒ 注册丢了就是"点了没反应"复现 ✗。
		// 这里只钉"装饰器与类同源"这一件事实，DI 真实装配由 `noUnusedLocals`/类型检查与真机兜 ✓。
		assert.strictEqual(typeof IKbCommandService, 'function');
		assert.strictEqual(IKbCommandService.toString().includes('kbCommandService'), true);
	});
});
