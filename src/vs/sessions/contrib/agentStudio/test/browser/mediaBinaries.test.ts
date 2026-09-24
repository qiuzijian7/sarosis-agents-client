/*---------------------------------------------------------------------------------------------
 *  媒体二进制解析（ffmpeg / ffprobe / yt-dlp）单元测试 —— 2026-09-24
 *
 *  背景：抽帧/视频理解此前**只用裸命令名**⇒ 完全依赖用户 PATH ⇒ 绝大多数机器上工具只能
 *  返回「请先安装」（本机即如此）。产品其实早就有随包携带 ffmpeg 的机制（vox 用），
 *  本模块把它搬到工具层：环境变量覆盖 → 随包内置（resources/saros/bin）→ dev 仓库
 *  （build/saros/bin）→ PATH。
 *
 *  这层最容易出的错是**静默降级**（候选拼错 ⇒ 永远落回 PATH ⇒ 用户看到「未检测到 ffmpeg」
 *  却不知道该文件明明在包里），因此逐条钉住：
 *   ① 候选顺序与拼法（含 yt-dlp 的 `.exe` 后缀与「兜底裸名不带后缀」）；
 *   ② 优先级不可颠倒（覆盖 > 内置 > PATH）；
 *   ③ 覆盖指向不存在的路径时**必须回退**（否则一个陈旧环境变量会把工具彻底打死）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mediaBinaries.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import {
	executableName, mediaBinaryOverride, bundledBinaryCandidates, resolveMediaBinary,
	resolveMediaBinaries, describeResolvedBinary, defaultMediaBinaryRuntime,
	type MediaBinaryName,
} from '../../browser/knowledge/mediaBinaries.js';

/** 只实现解析用到的面：stat（存在性）+ exists（宿主可能只提供它）。 */
class FakeFs {
	constructor(private readonly present: string[]) { }
	private has(p: string): boolean { return this.present.some(x => x.toLowerCase() === p.toLowerCase()); }
	async stat(uri: URI): Promise<{ isDirectory: boolean }> {
		if (!this.has(uri.fsPath)) { throw new Error('ENOENT'); }
		return { isDirectory: false };
	}
}

/** 只提供 exists 的宿主（模拟单测里的内存文件系统）。 */
class ExistsOnlyFs {
	constructor(private readonly present: string[]) { }
	async exists(uri: URI): Promise<boolean> {
		return this.present.some(x => x.toLowerCase() === uri.fsPath.toLowerCase());
	}
}

const RESOURCES = 'C:\\app\\resources';
const APP_ROOT = 'C:\\repo\\out';

function ctxWith(present: string[], over: Partial<Parameters<typeof resolveMediaBinary>[1]> = {}) {
	const warns: string[] = [];
	return {
		warns,
		ctx: {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: new FakeFs(present) as any,
			appRoot: APP_ROOT,
			resourcesPath: RESOURCES,
			env: {},
			platform: 'win32',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			logService: { warn: (m: string) => warns.push(m), info() { }, error() { }, debug() { }, trace() { } } as any,
			...over,
		} as Parameters<typeof resolveMediaBinary>[1],
	};
}

suite('媒体二进制解析 · 纯函数', () => {

	test('executableName：win32 加 .exe；其它平台不加（yt-dlp 连字符原样保留）', () => {
		assert.strictEqual(executableName('ffmpeg', 'win32'), 'ffmpeg.exe');
		assert.strictEqual(executableName('yt-dlp', 'win32'), 'yt-dlp.exe');
		assert.strictEqual(executableName('yt-dlp', 'darwin'), 'yt-dlp');
		assert.strictEqual(executableName('ffprobe', 'linux'), 'ffprobe');
	});

	test('mediaBinaryOverride：各二进制的环境变量名（yt-dlp 接受两个别名）；空串视为未设置', () => {
		assert.strictEqual(mediaBinaryOverride('ffmpeg', { FFMPEG_PATH: 'D:/b/ffmpeg.exe' }), 'D:/b/ffmpeg.exe');
		assert.strictEqual(mediaBinaryOverride('ffprobe', { FFPROBE_PATH: ' x ' }), 'x', '两侧空白应被裁掉');
		assert.strictEqual(mediaBinaryOverride('yt-dlp', { YTDLP_PATH: 'a' }), 'a');
		assert.strictEqual(mediaBinaryOverride('yt-dlp', { YT_DLP_PATH: 'b' }), 'b', '别名：YT_DLP_PATH');
		assert.strictEqual(mediaBinaryOverride('yt-dlp', { YTDLP_PATH: '   ' }), undefined);
		assert.strictEqual(mediaBinaryOverride('ffmpeg', {}), undefined);
		assert.strictEqual(mediaBinaryOverride('ffmpeg', undefined), undefined, '没有 env 时必须安全返回 undefined');
	});

	test('bundledBinaryCandidates：随包路径优先；dev 仓库从 appRoot 逐层上溯；去重且顺序稳定', () => {
		const c = bundledBinaryCandidates('yt-dlp', { resourcesPath: RESOURCES, appRoot: APP_ROOT, platform: 'win32' });
		assert.strictEqual(c[0], 'C:\\app\\resources\\saros\\bin\\yt-dlp.exe', '安装包路径必须是第一候选');
		assert.ok(c.includes('C:\\repo\\out\\build\\saros\\bin\\yt-dlp.exe'), `appRoot 自身那层：${c.join(' | ')}`);
		assert.ok(c.includes('C:\\repo\\build\\saros\\bin\\yt-dlp.exe'), '上一层（dev 下 appRoot=out）');
		assert.strictEqual(new Set(c.map(x => x.toLowerCase())).size, c.length, '不得有重复候选');

		// 非 win32：不带 .exe（内置二进制只随 Windows 包提供 ⇒ 其余平台自动落到 PATH）
		const mac = bundledBinaryCandidates('ffmpeg', { resourcesPath: '/app/Resources', appRoot: '/repo/out', platform: 'darwin' });
		assert.ok(mac.every(p => !p.endsWith('.exe')), mac.join(' | '));

		assert.deepStrictEqual(bundledBinaryCandidates('ffmpeg', {}), [], '没有 resourcesPath/appRoot ⇒ 无候选（退化 PATH）');
	});
});

suite('媒体二进制解析 · resolveMediaBinary', () => {

	test('★★ 命中随包内置 ⇒ 用绝对路径（不用 PATH）', async () => {
		const bundled = 'C:\\app\\resources\\saros\\bin\\ffmpeg.exe';
		const { ctx } = ctxWith([bundled]);
		const r = await resolveMediaBinary('ffmpeg', ctx);
		assert.strictEqual(r.source, 'bundled');
		assert.strictEqual(r.command, bundled);
		assert.strictEqual(r.path, bundled);
		assert.strictEqual(describeResolvedBinary(r), `ffmpeg=内置 ${bundled}`);
	});

	test('★★ dev 仓库（build/saros/bin）也能命中 ⇒ 源码运行同样零安装', async () => {
		const { ctx } = ctxWith(['C:\\repo\\build\\saros\\bin\\yt-dlp.exe']);
		const r = await resolveMediaBinary('yt-dlp', ctx);
		assert.strictEqual(r.source, 'bundled');
		assert.strictEqual(r.command, 'C:\\repo\\build\\saros\\bin\\yt-dlp.exe');
	});

	test('★★ 都没有 ⇒ 回退**裸名（不带 .exe）**，交 PATH 解析（保持改动前行为）', async () => {
		const { ctx } = ctxWith([]);
		const r = await resolveMediaBinary('ffmpeg', ctx);
		assert.strictEqual(r.source, 'path');
		assert.strictEqual(r.command, 'ffmpeg', '必须是裸名：命令串按 `"ffmpeg" "-version"` 断言，且非 win32 加 .exe 是错的');
		assert.strictEqual(r.path, undefined);
	});

	test('★ 环境变量覆盖绝对路径且存在 ⇒ 最高优先（压过内置）', async () => {
		const bundled = 'C:\\app\\resources\\saros\\bin\\ffmpeg.exe';
		const override = 'D:\\tools\\ffmpeg.exe';
		const { ctx } = ctxWith([bundled, override], { env: { FFMPEG_PATH: override } });
		const r = await resolveMediaBinary('ffmpeg', ctx);
		assert.strictEqual(r.source, 'override');
		assert.strictEqual(r.command, override, '显式指定必须赢');
	});

	test('★★ 覆盖指向不存在的路径 ⇒ 记 warn 并回退（陈旧环境变量不得把工具打死）', async () => {
		const bundled = 'C:\\app\\resources\\saros\\bin\\ffmpeg.exe';
		const { ctx, warns } = ctxWith([bundled], { env: { FFMPEG_PATH: 'D:\\gone\\ffmpeg.exe' } });
		const r = await resolveMediaBinary('ffmpeg', ctx);
		assert.strictEqual(r.source, 'bundled', '应回退到内置，而不是把坏路径交给 shell');
		assert.strictEqual(warns.length, 1, '必须留下可诊断的 warn');
		assert.match(warns[0], /FFMPEG_PATH/);
	});

	test('★ 覆盖写成「裸命令名」⇒ 直接采用（不检查存在性，允许 PATH 里的别名/wrapper）', async () => {
		const { ctx, warns } = ctxWith([], { env: { YTDLP_PATH: 'yt-dlp-wrapper' } });
		const r = await resolveMediaBinary('yt-dlp', ctx);
		assert.strictEqual(r.source, 'override');
		assert.strictEqual(r.command, 'yt-dlp-wrapper');
		assert.deepStrictEqual(warns, [], '裸命令名不是错误用法，不该 warn');
	});

	test('宿主只提供 exists（无 stat）时同样能命中内置（缺这层会静默落回 PATH）', async () => {
		const bundled = 'C:\\app\\resources\\saros\\bin\\ffprobe.exe';
		const r = await resolveMediaBinary('ffprobe', {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: new ExistsOnlyFs([bundled]) as any,
			resourcesPath: RESOURCES, appRoot: APP_ROOT, env: {}, platform: 'win32',
		});
		assert.strictEqual(r.source, 'bundled', 'exists-only 宿主也必须能解析到内置');
	});

	test('resolveMediaBinaries：一次解析三个（键与入参一致）', async () => {
		const names: MediaBinaryName[] = ['ffmpeg', 'ffprobe', 'yt-dlp'];
		const { ctx } = ctxWith(['C:\\app\\resources\\saros\\bin\\ffmpeg.exe']);
		const all = await resolveMediaBinaries(names, ctx);
		assert.deepStrictEqual(Object.keys(all).sort(), ['ffmpeg', 'ffprobe', 'yt-dlp']);
		assert.strictEqual(all.ffmpeg.source, 'bundled');
		assert.strictEqual(all['yt-dlp'].source, 'path');
	});

	test('defaultMediaBinaryRuntime：node 单测环境下不得误报 resourcesPath（只有 Electron 打包版才有）', () => {
		const rt = defaultMediaBinaryRuntime();
		assert.strictEqual(rt.resourcesPath, undefined, '本环境不该有 resourcesPath（有则说明读错了字段）');
		assert.strictEqual(rt.platform, process.platform, '平台应来自 process.platform');
	});
});
