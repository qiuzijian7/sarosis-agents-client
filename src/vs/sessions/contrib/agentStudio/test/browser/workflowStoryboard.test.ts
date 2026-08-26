/*---------------------------------------------------------------------------------------------
 * P0: Storyboard Editor 数据契约（对齐 ComfyTV boardDoc.ts）纯函数单测。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	createBoard, defaultBoardState, boardDurationMs, boardImageUrl, totalDurationMs,
	shotLabels, coverImageUrl, boardsToImagesJson, duplicateBoardData,
	boardsFromImagesJson, suggestedDurationMs, boardsFromShotsJson,
	type StoryboardDoc, type StoryBoardData,
} from '../../webview/src/features/workflowEditor/comfyHost/storyboardEditor.js';

suite('P0 StoryboardEditor 数据契约', () => {

	test('createBoard 默认 newShot=false（对齐 ComfyTV）', () => {
		const b = createBoard();
		assert.strictEqual(b.newShot, false);
		assert.strictEqual(b.layerState, null);
		assert.strictEqual(b.durationMs, null);
	});

	test('shotLabels: 首板 1A，newShot 才递增', () => {
		const doc: StoryboardDoc = {
			version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000,
			boards: [
				createBoard({ newShot: true }),   // 1A
				createBoard({ newShot: false }),  // 1A（延续）
				createBoard({ newShot: true }),   // 1B
				createBoard({ newShot: false }),  // 1B
				createBoard({ newShot: true }),   // 1C
			],
		};
		assert.deepStrictEqual(shotLabels(doc), ['1A', '1A', '1B', '1B', '1C']);
	});

	test('shotLabels: 26 以上字母列（AA/AB）', () => {
		const boards = Array.from({ length: 28 }, () => createBoard({ newShot: true }));
		const doc: StoryboardDoc = { version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000, boards };
		const labels = shotLabels(doc);
		assert.strictEqual(labels[0], '1A');
		assert.strictEqual(labels[25], '1Z');
		assert.strictEqual(labels[26], '1AA');
		assert.strictEqual(labels[27], '1AB');
	});

	test('totalDurationMs 累加有效时长（durationMs ?? default）', () => {
		const doc: StoryboardDoc = {
			version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000,
			boards: [
				createBoard({ durationMs: 1500 }), // 1500
				createBoard(),                     // 2000（default）
				createBoard({ durationMs: 1000 }), // 1000
			],
		};
		assert.strictEqual(totalDurationMs(doc), 4500);
	});

	test('coverImageUrl 取首个有图像的板', () => {
		const doc: StoryboardDoc = {
			version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000,
			boards: [
				createBoard(),                       // 无图
				createBoard({ refUrl: 'https://x/2.png' }),  // 有图
				createBoard({ compositeUrl: 'data:...' }),   // 有图（但不该轮到）
			],
		};
		assert.strictEqual(coverImageUrl(doc), 'https://x/2.png');
	});

	test('boardsToImagesJson 只含有效图像 + shotLabels 对齐', () => {
		const doc: StoryboardDoc = {
			version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000,
			boards: [
				createBoard({ newShot: true, refUrl: 'https://x/1.png' }),
				createBoard({ refUrl: 'https://x/2.png' }),
				createBoard({ newShot: true }),   // 无图 → 跳过
			],
		};
		const out = JSON.parse(boardsToImagesJson(doc)) as { images: Array<{ index: number; label: string; image_url: string }> };
		assert.strictEqual(out.images.length, 2);
		assert.deepStrictEqual(out.images[0], { index: 1, label: '1A', image_url: 'https://x/1.png' });
		assert.deepStrictEqual(out.images[1], { index: 2, label: '1A', image_url: 'https://x/2.png' });
	});

	test('duplicateBoardData 深拷贝 layerState + 新 uid', () => {
		const b = createBoard({ newShot: true, layerState: { width: 10, height: 10, layers: [{ id: 'l1', name: 'a', visible: true, opacity: 1, ops: [] }] } });
		const dup = duplicateBoardData(b);
		assert.notStrictEqual(dup.uid, b.uid);
		assert.notStrictEqual(dup.layerState, b.layerState); // 深拷贝
		assert.deepStrictEqual(dup.layerState, b.layerState);
		// 修改 dup 不影响原 board
		(dup.layerState as { width: number }).width = 999;
		assert.notStrictEqual((b.layerState as { width: number }).width, 999);
	});

	test('boardsFromImagesJson 映射为参考板（newShot=true + refUrl + notes label）', () => {
		const boards = boardsFromImagesJson(JSON.stringify({ images: [{ image_url: 'https://x/a.png', label: '镜头 1' }, { image_url: 'https://x/b.png', label: 'composite' }] }));
		assert.strictEqual(boards.length, 2);
		assert.strictEqual(boards[0].newShot, true);
		assert.strictEqual(boards[0].refUrl, 'https://x/a.png');
		assert.strictEqual(boards[0].notes, '镜头 1');
		assert.strictEqual(boards[1].notes, ''); // 'composite' 被过滤
	});

	test('boardsFromImagesJson 非法 JSON 返回空', () => {
		assert.deepStrictEqual(boardsFromImagesJson('{not json'), []);
		assert.deepStrictEqual(boardsFromImagesJson(JSON.stringify({ foo: 1 })), []);
	});

	test('suggestedDurationMs: 纯中文按 150ms/字', () => {
		const b = createBoard({ dialogue: '你好世界' });
		assert.strictEqual(suggestedDurationMs(b), Math.max(1000, 500 + 4 * 150));
	});

	test('suggestedDurationMs: 纯拉丁按 300ms/词', () => {
		const b = createBoard({ dialogue: 'hello world' });
		assert.strictEqual(suggestedDurationMs(b), Math.max(1000, 500 + 2 * 300));
	});

	test('suggestedDurationMs: 空对白返回 null', () => {
		assert.strictEqual(suggestedDurationMs(createBoard({ dialogue: '' })), null);
		assert.strictEqual(suggestedDurationMs(createBoard()), null);
	});

	test('boardsFromShotsJson 映射 16 字段（duration 秒→毫秒）', () => {
		const boards = boardsFromShotsJson(JSON.stringify({ shots: [{
			duration: 2.5, dialogue: '你好', action: '走路', scene_purpose: '开场',
			character: '小明', shot_size: '近景', image_prompt: '一只猫',
			motion_prompt: '缓慢推近', image_url: 'https://x/s.png',
		}] }));
		assert.strictEqual(boards.length, 1);
		const b = boards[0];
		assert.strictEqual(b.newShot, true);
		assert.strictEqual(b.durationMs, 2500);
		assert.strictEqual(b.dialogue, '你好');
		assert.strictEqual(b.action, '走路');
		assert.strictEqual(b.scenePurpose, '开场');
		assert.strictEqual(b.character, '小明');
		assert.strictEqual(b.shotSize, '近景');
		assert.strictEqual(b.imagePrompt, '一只猫');
		assert.strictEqual(b.motionPrompt, '缓慢推近');
		assert.strictEqual(b.refUrl, 'https://x/s.png');
	});

	test('boardsFromShotsJson: prompt 字段兜底 image_prompt', () => {
		const boards = boardsFromShotsJson(JSON.stringify({ shots: [{ prompt: 'fallback', duration: 1 }] }));
		assert.strictEqual(boards[0].imagePrompt, 'fallback');
	});

	test('defaultBoardState 首板 newShot=false（对齐 ComfyTV）', () => {
		const doc = defaultBoardState();
		assert.strictEqual(doc.boards.length, 1);
		assert.strictEqual(doc.boards[0].newShot, false);
		assert.strictEqual(doc.boards[0].layerState !== null, true); // 自研 LayerDoc 兜底
	});
});
