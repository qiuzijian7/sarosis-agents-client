/*---------------------------------------------------------------------------------------------
 *  Unit test: mediaDownloadFilename（2026-09-11 用户需求）
 *
 *  卡片里的图片/视频/音频加「下载」按钮 —— 文件名推断是唯一可单测的纯逻辑，
 *  且边界不少（data URL 的 mime 子类型 / jpeg→jpg / query·hash / Windows 反斜杠 /
 *  无扩展名回退 / blob: 无路径）。时间戳部分用正则断言，不比对具体值。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { mediaDownloadFilename } from '../../../../browser/agentChat/mediaDownload.js';

/** 生成结果文件名：`生成结果-<13 位时间戳>.<ext>`。 */
const generated = (ext: string) => new RegExp(`^生成结果-\\d{13}\\.${ext}$`);

suite('mediaDownloadFilename', () => {

	test('★ data URL：扩展名取自 mime 子类型（jpeg → jpg）', () => {
		assert.ok(generated('png').test(mediaDownloadFilename('data:image/png;base64,AAA', 'image')));
		assert.ok(generated('jpg').test(mediaDownloadFilename('data:image/jpeg;base64,AAA', 'image')));
		assert.ok(generated('gif').test(mediaDownloadFilename('data:image/gif;base64,AAA', 'image')));
		assert.ok(generated('mp4').test(mediaDownloadFilename('data:video/mp4;base64,AAA', 'video')));
		assert.ok(generated('mpeg').test(mediaDownloadFilename('data:audio/mpeg;base64,AAA', 'audio')));
	});

	test('★ data URL 无 mime 子类型 → 按 kind 回退扩展名', () => {
		assert.ok(generated('png').test(mediaDownloadFilename('data:;base64,AAA', 'image')));
		assert.ok(generated('mp4').test(mediaDownloadFilename('data:;base64,AAA', 'video')));
		assert.ok(generated('mp3').test(mediaDownloadFilename('data:;base64,AAA', 'audio')));
	});

	test('★ 普通 URL：取 basename（去 query / hash）', () => {
		assert.strictEqual(mediaDownloadFilename('https://cdn.example.com/a/b/emoji.webp', 'image'), 'emoji.webp');
		assert.strictEqual(mediaDownloadFilename('https://cdn.example.com/x.png?v=2', 'image'), 'x.png');
		assert.strictEqual(mediaDownloadFilename('https://cdn.example.com/x.gif#frag', 'image'), 'x.gif');
		assert.strictEqual(mediaDownloadFilename('vscode-file://vscode-app/C:/tmp/out.png', 'image'), 'out.png');
	});

	test('★ Windows 反斜杠路径也能取到 basename', () => {
		assert.strictEqual(mediaDownloadFilename('C:\\Users\\me\\AppData\\out.mp4', 'video'), 'out.mp4');
	});

	test('★ 无扩展名 / blob: → 按 kind 回退（不产出无扩展名文件）', () => {
		assert.ok(generated('png').test(mediaDownloadFilename('blob:https://host/2f8a-1b', 'image')));
		assert.ok(generated('mp4').test(mediaDownloadFilename('https://cdn.example.com/download', 'video')));
		assert.ok(generated('mp3').test(mediaDownloadFilename('/var/tmp/audio-no-ext', 'audio')));
	});

	test('未知 kind 默认按图片扩展名', () => {
		assert.ok(generated('png').test(mediaDownloadFilename('data:;base64,AAA', 'unknown')));
	});
});
