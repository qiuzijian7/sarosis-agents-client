/*---------------------------------------------------------------------------------------------
 *  web_extract 超限正文落盘的单测（P1，对比 Hermes-Agent 后补，2026-09-24）。
 *
 *  盯四件事：**不丢尾部**（长文结论常在尾部）、**切在行边界**（半行会误导模型）、
 *  **内联片段不超预算**（超了就会触发格式化层自己的截断告警，与落盘通知语义打架）、
 *  **标记自带路径**（被缓存进 webPageCache 的就是这段片段，命中时不会再发通知 ——
 *  标记里没路径就等于"说有文件但找不到"）。
 *  另外盯**绝不误删别人的落盘文件**（回收逻辑按文件名严格归属）。
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	buildExtractExcerpt,
	isWebExtractSpillFile,
	selectWebExtractSpillFilesToDelete,
	spillMarkerWithPath,
	spillMarkerWithoutPath,
	webExtractSpillFileName,
	webExtractSpillNotice,
} from '../../browser/providers/tool/webExtractSpill.js';
import { SPILL_MAX_AGE_MS, SPILL_MAX_FILES } from '../../browser/providers/tool/execOutputSpill.js';

const LIMIT = 200;
const MARKER = spillMarkerWithPath('C:\\tmp\\web-extract-x.txt');

/** 造一段行结构清晰的正文（每行 `L000`…），便于断言"没有半行"。 */
function makeLines(count: number): string {
	return Array.from({ length: count }, (_, i) => `L${String(i).padStart(3, '0')}`).join('\n');
}

suite('webExtractSpill — 超限正文落盘', () => {

	test('未超限：不落盘，原样返回**同一引用**', () => {
		const text = 'short page';
		const r = buildExtractExcerpt(text, LIMIT, MARKER);
		assert.strictEqual(r.shouldSpill, false);
		assert.strictEqual(r.inlineExcerpt, text);
		assert.strictEqual(r.totalChars, text.length);
	});

	test('★ 超限：内联片段不超预算（否则会触发格式化层自己的截断告警，与落盘通知打架）', () => {
		const text = makeLines(500);
		const r = buildExtractExcerpt(text, LIMIT, MARKER);
		assert.strictEqual(r.shouldSpill, true);
		assert.ok(r.inlineExcerpt.length <= LIMIT, `excerpt=${r.inlineExcerpt.length} > limit=${LIMIT}`);
		assert.ok(r.inlineExcerpt.includes(MARKER), '必须带省略标记');
		assert.strictEqual(r.totalChars, text.length, 'totalChars 报告的是全文长度');
	});

	test('★★ 头尾都保留（长文的结论常在尾部，硬截断会把它丢掉）', () => {
		const text = makeLines(500);
		const r = buildExtractExcerpt(text, LIMIT, MARKER);
		assert.ok(r.inlineExcerpt.startsWith('L000'), '头部要在');
		assert.ok(r.inlineExcerpt.endsWith('L499'), '尾部要在（这正是本次修的核心）');
		assert.ok(!r.inlineExcerpt.includes('L250'), '中段被省略');
	});

	test('★ 切在行边界：内联片段里不出现半行', () => {
		const text = makeLines(500);
		const [head, tail] = buildExtractExcerpt(text, LIMIT, MARKER).inlineExcerpt.split(MARKER);
		for (const part of [head, tail]) {
			for (const line of part.split('\n').filter(l => l.length > 0)) {
				assert.ok(/^L\d{3}$/.test(line), `出现半行/碎片：${JSON.stringify(line)}`);
			}
		}
	});

	test('★ 陷阱①：超长首行（无换行）仍要切得出头部（不能因找不到行边界就放弃）', () => {
		const text = 'A'.repeat(LIMIT * 3);
		const r = buildExtractExcerpt(text, LIMIT, MARKER);
		assert.strictEqual(r.shouldSpill, true);
		assert.ok(r.inlineExcerpt.length <= LIMIT);
		assert.ok(r.inlineExcerpt.startsWith('A'), '头部不能为空');
	});

	test('★ 陷阱②：超长末行（尾部找不到换行）时尾部**不能为空**（否则等于退回只给头部）', () => {
		const text = `${makeLines(40)}\n${'B'.repeat(LIMIT * 3)}`;
		const r = buildExtractExcerpt(text, LIMIT, MARKER);
		assert.ok(r.inlineExcerpt.endsWith('B'), '尾部要保留末行的尾段');
		assert.ok(r.inlineExcerpt.length <= LIMIT);
	});

	test('★★ 标记必须自带落盘路径（缓存命中时不会再发通知，路径只能来自标记）', () => {
		const path = 'C:\\Users\\x\\.vssaros\\tmp\\web-extract-20260924-120000-000-001.txt';
		const r = buildExtractExcerpt(makeLines(500), LIMIT, spillMarkerWithPath(path));
		assert.ok(r.inlineExcerpt.includes(path), '路径必须在被缓存的那段文本里，否则命中时会"说有文件却没路径"');
	});

	test('落盘失败时的标记如实说"没能保存"，不假装有文件', () => {
		const marker = spillMarkerWithoutPath('no writable spill location');
		const r = buildExtractExcerpt(makeLines(500), LIMIT, marker);
		assert.ok(r.inlineExcerpt.includes('could NOT be saved'), r.inlineExcerpt.slice(0, 120));
		assert.ok(r.inlineExcerpt.includes('no writable spill location'));
	});

	// ─── 文件名与回收 ───────────────────────────────────────────────────

	test('文件名可排序、唯一，且被 isWebExtractSpillFile 认领', () => {
		const a = webExtractSpillFileName(new Date(2026, 8, 24, 12, 0, 0, 5), 1);
		const b = webExtractSpillFileName(new Date(2026, 8, 24, 12, 0, 0, 5), 2);
		assert.notStrictEqual(a, b, '同一毫秒内不同序号不得撞名');
		assert.ok(isWebExtractSpillFile(a), a);
		assert.ok(a.startsWith('web-extract-') && a.endsWith('.txt'), a);
	});

	test('★ isWebExtractSpillFile 只认自己的文件（不认 exec 落盘、也不认用户文件）', () => {
		assert.ok(isWebExtractSpillFile('web-extract-20260924-120000-005-001.txt'));
		assert.ok(!isWebExtractSpillFile('exec-20260924-120000-005-001.log'), 'exec 落盘不归本工具管');
		assert.ok(!isWebExtractSpillFile('important-notes.txt'));
		assert.ok(!isWebExtractSpillFile('web-extract-manual.txt'), '不符合命名规范的（用户手放的）不删');
	});

	test('★★ 回收：超龄删、超量删最旧，但**绝不碰别人的文件**', () => {
		const now = 1_000_000_000;
		const fresh = { name: webExtractSpillFileName(new Date(), 1), mtimeMs: now - 1000 };
		const stale = { name: webExtractSpillFileName(new Date(), 2), mtimeMs: now - SPILL_MAX_AGE_MS - 1 };
		const foreign = { name: 'exec-20260924-120000-005-001.log', mtimeMs: now - SPILL_MAX_AGE_MS - 1 };
		const userFile = { name: 'notes.txt', mtimeMs: 0 };

		assert.deepStrictEqual(selectWebExtractSpillFilesToDelete([fresh, stale, foreign, userFile], now), [stale.name]);
		assert.deepStrictEqual(selectWebExtractSpillFilesToDelete([fresh], now), []);
	});

	test('★ 回收：同批超过上限时删最旧的若干（保留最新的 SPILL_MAX_FILES 个）', () => {
		const now = 2_000_000_000;
		const files = Array.from({ length: SPILL_MAX_FILES + 3 }, (_, i) => ({
			name: webExtractSpillFileName(new Date(), i),
			mtimeMs: now - i,	// i 越大越旧
		}));
		const toDelete = selectWebExtractSpillFilesToDelete(files, now);
		assert.strictEqual(toDelete.length, 3);
		assert.ok(toDelete.includes(files[SPILL_MAX_FILES].name), '最旧的三个应被删');
		assert.ok(!toDelete.includes(files[0].name), '最新的不能被删');
	});

	// ─── 落盘通知 ───────────────────────────────────────────────────────

	test('★ 通知必须给出路径、可执行的取回方式，并劝阻重抓', () => {
		const msg = webExtractSpillNotice('C:\\tmp\\web-extract-x.txt', 123456, 'https://example.com/long');
		assert.ok(msg.includes('C:\\tmp\\web-extract-x.txt'));
		assert.ok(msg.includes('123456'), '要说明丢了多少');
		assert.ok(msg.includes('file_read with offset/limit'), '要给出可直接执行的方式');
		assert.ok(msg.includes('search_code'), '另一种检索方式');
		assert.ok(msg.includes('Do NOT call web_extract again'), '否则模型会重抓一遍，慢且拿不到更多');
	});

});
