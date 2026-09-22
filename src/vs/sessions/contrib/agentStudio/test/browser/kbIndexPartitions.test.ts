/*---------------------------------------------------------------------------------------------
 *  KB 全文索引 —— 「库 + 笔记两个分区都必须被索引」（回归测试）
 *
 *  背景（2026-09-22 真实故障）：
 *  用户 vault 里 `.kbkernel.json` 记录 `totalDocs: 1`，而磁盘上有 15 篇 md。
 *  后果链条：
 *      索引/文件名表残缺 → 笔记里的 `[[wikilink]]` 全部解析失败 →
 *      `LinkComponent` 对断链**裸 return**（点击完全静默）→
 *      用户只看到「点了没反应」，且出链面板只能显示未解码的原始 URI。
 *
 *  已用真实 vault 复现过「同一份数据跑 `KbFullTextIndex.build()` 得到 15 篇」
 *  ⇒ 构建逻辑本身正确，问题在**运行时拿到残缺索引**（缓存/时机）。
 *  本测试把「两个分区 + 子目录都必须进索引」钉死，防止该链路再次回归。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbIndexPartitions.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { KbFullTextIndex } from '../../browser/views/knowledgeBase/kbIndex.js';

/** 用 node fs 实现 `IFileService` 的最小面（resolve / readFile），喂给真实的 `KbFullTextIndex`。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFs(): any {
	const resolve = async (uri: URI) => {
		const p = uri.fsPath;
		const st = fs.statSync(p);
		const base = {
			resource: uri,
			name: path.basename(p),
			isDirectory: st.isDirectory(),
			isFile: st.isFile(),
			size: st.size,
			mtime: st.mtimeMs,
		};
		if (!st.isDirectory()) { return base; }
		const children = fs.readdirSync(p).map(name => {
			const cp = path.join(p, name);
			const cst = fs.statSync(cp);
			return {
				resource: URI.file(cp),
				name,
				isDirectory: cst.isDirectory(),
				isFile: cst.isFile(),
				size: cst.size,
				mtime: cst.mtimeMs,
			};
		});
		return { ...base, children };
	};
	const readFile = async (uri: URI) => ({ value: VSBuffer.fromString(fs.readFileSync(uri.fsPath, 'utf8')) });
	return { resolve, readFile };
}

suite('KB 索引：库 + 笔记两个分区都必须进索引（防「链接全断」回归）', () => {
	test('build 递归覆盖 库/笔记（含子目录）⇒ 文件名表可支撑 wikilink 解析', async () => {
		const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-index-'));
		try {
			fs.mkdirSync(path.join(vault, '库'), { recursive: true });
			fs.mkdirSync(path.join(vault, '笔记', '01_学习', 'AI_Agent'), { recursive: true });
			fs.writeFileSync(path.join(vault, '库', 'index.md'), '# index\n\n[[01 智能体是什么]]\n');
			fs.writeFileSync(path.join(vault, '笔记', '01_学习', 'AI_Agent', '01 智能体是什么.md'), '# 甲\n');
			fs.writeFileSync(path.join(vault, '笔记', '01_学习', 'AI_Agent', '02 智能体发展史.md'), '# 乙\n');

			const idx = new KbFullTextIndex(makeFs());
			await idx.build([
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ uri: URI.file(path.join(vault, '库')), section: 'library' as any },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ uri: URI.file(path.join(vault, '笔记')), section: 'notes' as any },
			]);

			const docs = idx.allDocs();
			assert.strictEqual(docs.length, 3, `应索引 3 篇（库 1 + 笔记 2，含子目录），实际 ${docs.length}`);

			const names = docs.map(d => d.name.replace(/\.(md|markdown)$/i, ''));
			assert.ok(names.includes('01 智能体是什么'), '★ 笔记分区必须进入文件名表 —— wikilink 解析完全依赖它');
			assert.ok(names.includes('index'), '库分区必须在索引里');

			const sectionByName = new Map(docs.map(d => [d.name, d.section]));
			assert.strictEqual(sectionByName.get('index.md'), 'library', '库分区归属正确');
			assert.strictEqual(sectionByName.get('01 智能体是什么.md'), 'notes', '笔记分区归属正确');
		} finally {
			fs.rmSync(vault, { recursive: true, force: true });
		}
	});
});
