/*---------------------------------------------------------------------------------------------
 * P1: fountain 解析器 + zipWriter 打包器单测。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { parseFountain, fountainToBoards } from '../../webview/src/features/workflowEditor/comfyHost/fountain.js';
import { buildZip, crc32 } from '../../webview/src/features/workflowEditor/comfyHost/zipWriter.js';

suite('P1 fountain 解析器', () => {

	test('场景标题 + 动作 + 对白', () => {
		const scenes = parseFountain('INT. 办公室 - 白天\n\n小明坐在桌前。\n\n@小明\n你好，世界。\n');
		assert.strictEqual(scenes.length, 1);
		// heading 保留 INT./EXT. 前缀（ComfyTV 语义：只 strip 点号开头的 Force Scene Heading）
		assert.strictEqual(scenes[0].heading, 'INT. 办公室 - 白天');
		assert.deepStrictEqual(scenes[0].action, ['小明坐在桌前。']);
		assert.deepStrictEqual(scenes[0].dialogues, [{ character: '小明', text: '你好，世界。' }]);
	});

	test('英文角色提示 + 多行对白', () => {
		const scenes = parseFountain('INT. ROOM\n\nALICE\nHello world.\nHow are you?\n');
		assert.strictEqual(scenes[0].dialogues[0].character, 'ALICE');
		assert.strictEqual(scenes[0].dialogues[0].text, 'Hello world. How are you?');
	});

	test('fountainToBoards: 每场景一个 newShot board', () => {
		// 中文角色名需 @ 转义（Fountain 规范：无大写形式的名字的 escape hatch）
		const boards = fountainToBoards('INT. A\n\n@甲\n一\n\nINT. B\n\n@乙\n二\n');
		assert.strictEqual(boards.length, 2);
		assert.strictEqual(boards[0].newShot, true);
		assert.strictEqual(boards[0].scenePurpose, 'INT. A');
		assert.match(boards[0].dialogue, /甲: 一/);
		assert.strictEqual(boards[1].scenePurpose, 'INT. B');
	});

	test('空输入返回空', () => {
		assert.deepStrictEqual(parseFountain(''), []);
		assert.deepStrictEqual(fountainToBoards(''), []);
	});
});

suite('P1 zipWriter', () => {

	test('buildZip 产出合法 ZIP（PK 签名 + 中央目录）', () => {
		const bytes = buildZip([{ name: 'a.png', data: new Uint8Array([1, 2, 3]) }]);
		// local file header 签名
		assert.strictEqual(bytes[0], 0x50);
		assert.strictEqual(bytes[1], 0x4b);
		assert.strictEqual(bytes[2], 0x03);
		assert.strictEqual(bytes[3], 0x04);
		// 中央目录签名 EOCD 0x06054b50 应在文件末尾附近
		const tail = bytes.subarray(bytes.length - 22);
		assert.strictEqual(tail[0], 0x50);
		assert.strictEqual(tail[1], 0x4b);
		assert.strictEqual(tail[2], 0x05);
		assert.strictEqual(tail[3], 0x06);
	});

	test('crc32 稳定', () => {
		assert.strictEqual(crc32(new Uint8Array([1, 2, 3])), crc32(new Uint8Array([1, 2, 3])));
		assert.notStrictEqual(crc32(new Uint8Array([1, 2, 3])), crc32(new Uint8Array([1, 2, 4])));
	});

	test('空 entries 抛错', () => {
		assert.throws(() => buildZip([]), /no entries/);
	});
});
