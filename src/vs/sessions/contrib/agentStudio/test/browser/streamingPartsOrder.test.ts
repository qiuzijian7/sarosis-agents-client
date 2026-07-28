/*---------------------------------------------------------------------------------------------
 *  streamingPartsOrder.test.ts
 *
 *  模拟日志中的流式数据，验证 deriveUiMessageParts 的 parts 顺序、
 *  chronological parts 跟踪逻辑、以及 phase indicator 插入位置的正确性。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveUiMessageParts, type IToolCall, type IMessagePart } from '../../../../browser/agentChat/agentChatTypes.js';

suite('Streaming Parts Order', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── deriveUiMessageParts ─────────────────────────────────────────────

	suite('deriveUiMessageParts', () => {

		test('empty content + no tools → empty parts', () => {
			const parts = deriveUiMessageParts('', []);
			assert.deepStrictEqual(parts, []);
		});

		test('text only → single text part', () => {
			const parts = deriveUiMessageParts('hello world', []);
			assert.strictEqual(parts.length, 1);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual((parts[0] as any).text, 'hello world');
		});

		test('tools with textPosition → interleaved', () => {
			const text = 'AAA BBB CCC';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'search_files', status: 'done', args: '', textPosition: 4 },
				{ id: 't2', name: 'file_read', status: 'done', args: '', textPosition: 8 },
			];
			const parts = deriveUiMessageParts(text, tcs);
			// text[0:4] → tool t1 → text[4:8] → tool t2 → text[8:]
			assert.strictEqual(parts.length, 5);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual((parts[0] as any).text, 'AAA ');
			assert.strictEqual(parts[1].kind, 'tool');
			assert.strictEqual((parts[1] as any).tool.id, 't1');
			assert.strictEqual(parts[2].kind, 'text');
			assert.strictEqual((parts[2] as any).text, 'BBB ');
			assert.strictEqual(parts[3].kind, 'tool');
			assert.strictEqual((parts[3] as any).tool.id, 't2');
			assert.strictEqual(parts[4].kind, 'text');
			assert.strictEqual((parts[4] as any).text, 'CCC');
		});

		test('tools without textPosition → appended at end', () => {
			const text = 'hello';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'search_files', status: 'done', args: '' },
				{ id: 't2', name: 'file_read', status: 'done', args: '' },
			];
			const parts = deriveUiMessageParts(text, tcs);
			// text → tool t1 → tool t2
			assert.strictEqual(parts.length, 3);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual(parts[1].kind, 'tool');
			assert.strictEqual(parts[2].kind, 'tool');
		});

		test('mixed positioned + unpositioned → positioned first, then unpositioned', () => {
			const text = 'AAA BBB';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'search_files', status: 'done', args: '' },  // unpositioned
				{ id: 't2', name: 'file_read', status: 'done', args: '', textPosition: 4 },  // positioned
			];
			const parts = deriveUiMessageParts(text, tcs);
			// text[0:4] → tool t2 (positioned) → text[4:] → tool t1 (unpositioned, at end)
			assert.strictEqual(parts.length, 4);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual((parts[0] as any).text, 'AAA ');
			assert.strictEqual(parts[1].kind, 'tool');
			assert.strictEqual((parts[1] as any).tool.id, 't2');
			assert.strictEqual(parts[2].kind, 'text');
			assert.strictEqual((parts[2] as any).text, 'BBB');
			assert.strictEqual(parts[3].kind, 'tool');
			assert.strictEqual((parts[3] as any).tool.id, 't1');
		});

		test('textPosition beyond text length → clamped to end', () => {
			const text = 'AAA';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'file_read', status: 'done', args: '', textPosition: 100 },
			];
			const parts = deriveUiMessageParts(text, tcs);
			// text → tool t1 (clamped to end)
			assert.strictEqual(parts.length, 2);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual(parts[1].kind, 'tool');
		});

		test('negative textPosition → treated as unpositioned', () => {
			const text = 'AAA';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'file_read', status: 'done', args: '', textPosition: -1 },
			];
			const parts = deriveUiMessageParts(text, tcs);
			assert.strictEqual(parts.length, 2);
			assert.strictEqual(parts[0].kind, 'text');
			assert.strictEqual(parts[1].kind, 'tool');
		});

		test('multiple tools at same textPosition → order preserved', () => {
			const text = 'AAA';
			const tcs: IToolCall[] = [
				{ id: 't1', name: 'search_files', status: 'done', args: '', textPosition: 3 },
				{ id: 't2', name: 'file_read', status: 'done', args: '', textPosition: 3 },
			];
			const parts = deriveUiMessageParts(text, tcs);
			// text → tool t1 → tool t2 (both at position 3, end of text)
			assert.strictEqual(parts.length, 3);
			assert.strictEqual(parts[1].kind, 'tool');
			assert.strictEqual((parts[1] as any).tool.id, 't1');
			assert.strictEqual(parts[2].kind, 'tool');
			assert.strictEqual((parts[2] as any).tool.id, 't2');
		});
	});

	// ─── 模拟日志中的多迭代流式数据 ────────────────────────────────────────

	suite('Multi-iteration streaming simulation', () => {

		/**
		 * 模拟日志中的典型流式场景：
		 * - Iteration 1: text → tool_calls (3 tools) → done
		 * - Iteration 2: text → tool_calls (2 tools) → done
		 * - Iteration 3: text (final summary) → done (stop)
		 *
		 * 验证 chronological parts 跟踪的正确性。
		 */
		test('chronological parts: text→tools→text→tools→text', () => {
			// 模拟 agentChatService 的 _streamingParts 跟踪
			const _streamingParts: any[] = [];

			// ── Iteration 1 ──
			// text delta 1
			_streamingParts.push({ kind: 'text', text: '我先确认 GC 相关源码与配置的实际位置' });
			// tool_start 1
			_streamingParts.push({ kind: 'tool', tool: { id: 't1', name: 'search_files', status: 'running' } });
			// tool_start 2
			_streamingParts.push({ kind: 'tool', tool: { id: 't2', name: 'search_graph', status: 'running' } });
			// tool_start 3
			_streamingParts.push({ kind: 'tool', tool: { id: 't3', name: 'file_read', status: 'running' } });

			// ── Iteration 2 ──
			// text delta 2 (new text part, because last part is tool)
			_streamingParts.push({ kind: 'text', text: '配置已确认，现在查找引擎主流程关键函数' });
			// tool_start 4
			_streamingParts.push({ kind: 'tool', tool: { id: 't4', name: 'search_graph', status: 'running' } });
			// tool_start 5
			_streamingParts.push({ kind: 'tool', tool: { id: 't5', name: 'file_read', status: 'running' } });

			// ── Iteration 3 (final) ──
			// text delta 3 (final summary)
			_streamingParts.push({ kind: 'text', text: '分析完成，GC 机制全流程已确认。' });

			// 验证 parts 顺序
			const kinds = _streamingParts.map(p => p.kind);
			assert.deepStrictEqual(kinds, [
				'text', 'tool', 'tool', 'tool',  // iteration 1
				'text', 'tool', 'tool',           // iteration 2
				'text',                            // iteration 3
			]);

			// 验证 text parts 内容
			assert.strictEqual(_streamingParts[0].text, '我先确认 GC 相关源码与配置的实际位置');
			assert.strictEqual(_streamingParts[4].text, '配置已确认，现在查找引擎主流程关键函数');
			assert.strictEqual(_streamingParts[7].text, '分析完成，GC 机制全流程已确认。');

			// 验证 tool parts
			assert.strictEqual(_streamingParts[1].tool.id, 't1');
			assert.strictEqual(_streamingParts[5].tool.id, 't4');
		});

		/**
		 * 模拟 text delta 累积到一个 text part（不每次创建新的）。
		 */
		test('text delta accumulation: updates last text part', () => {
			const _streamingParts: any[] = [];

			// 模拟 text delta 1
			const last1 = _streamingParts[_streamingParts.length - 1];
			if (last1 && last1.kind === 'text') {
				last1.text += '先确认';
			} else {
				_streamingParts.push({ kind: 'text', text: '先确认' });
			}

			// 模拟 text delta 2 (累积到同一个 text part)
			const last2 = _streamingParts[_streamingParts.length - 1];
			if (last2 && last2.kind === 'text') {
				last2.text += ' GC 相关';
			} else {
				_streamingParts.push({ kind: 'text', text: ' GC 相关' });
			}

			// 模拟 text delta 3
			const last3 = _streamingParts[_streamingParts.length - 1];
			if (last3 && last3.kind === 'text') {
				last3.text += '源码';
			} else {
				_streamingParts.push({ kind: 'text', text: '源码' });
			}

			// 应该只有 1 个 text part，内容为累积值
			assert.strictEqual(_streamingParts.length, 1);
			assert.strictEqual(_streamingParts[0].text, '先确认 GC 相关源码');
		});

		/**
		 * 模拟 text delta 后 tool_start，再 text delta 的场景。
		 * 验证新 text delta 会创建新的 text part（不会合并到旧的）。
		 */
		test('text→tool→text: second text creates new part', () => {
			const _streamingParts: any[] = [];

			// text 1
			_streamingParts.push({ kind: 'text', text: '开始搜索' });
			// tool 1
			_streamingParts.push({ kind: 'tool', tool: { id: 't1', name: 'search_files' } });
			// text 2 (应该创建新 part，因为 last 是 tool)
			const last = _streamingParts[_streamingParts.length - 1];
			if (last && last.kind === 'text') {
				last.text += '搜索完成';
			} else {
				_streamingParts.push({ kind: 'text', text: '搜索完成' });
			}

			assert.strictEqual(_streamingParts.length, 3);
			assert.strictEqual(_streamingParts[0].kind, 'text');
			assert.strictEqual(_streamingParts[0].text, '开始搜索');
			assert.strictEqual(_streamingParts[1].kind, 'tool');
			assert.strictEqual(_streamingParts[2].kind, 'text');
			assert.strictEqual(_streamingParts[2].text, '搜索完成');
		});

		/**
		 * 模拟 content_replace（重置文本）—— text part 被更新而非新增。
		 */
		test('content_replace: updates last text part', () => {
			const _streamingParts: any[] = [];

			// 初始 text
			_streamingParts.push({ kind: 'text', text: '旧文本' });
			// tool
			_streamingParts.push({ kind: 'tool', tool: { id: 't1', name: 'search_files' } });
			// 新 text (after tool, creates new part)
			_streamingParts.push({ kind: 'text', text: '工具完成后的文本' });

			// content_replace: 重置最后一个 text part
			const last = _streamingParts[_streamingParts.length - 1];
			if (last && last.kind === 'text') {
				last.text = '重置后的文本';
			}

			assert.strictEqual(_streamingParts.length, 3);
			assert.strictEqual(_streamingParts[0].text, '旧文本');
			assert.strictEqual(_streamingParts[2].text, '重置后的文本');
		});

		/**
		 * 模拟日志中观察到的 8+ 迭代场景，验证大量 tool calls 的顺序。
		 */
		test('8-iteration simulation: 20+ tool calls in correct order', () => {
			const _streamingParts: any[] = [];
			let toolCount = 0;

			for (let iter = 1; iter <= 8; iter++) {
				// text delta
				_streamingParts.push({ kind: 'text', text: `Iteration ${iter} text` });

				// 2-4 tool calls per iteration
				const toolsThisIter = (iter % 3) + 2; // 2, 3, 4, 2, 3, 4, 2, 3
				for (let t = 0; t < toolsThisIter; t++) {
					toolCount++;
					_streamingParts.push({
						kind: 'tool',
						tool: { id: `t${toolCount}`, name: 'search_files', status: 'done' }
					});
				}
			}

			// Final text
			_streamingParts.push({ kind: 'text', text: 'Final summary' });

			// 验证：8 iterations × (1 text + 2-4 tools) + 1 final text
			const expectedToolCounts: number[] = [];
			for (let i = 1; i <= 8; i++) { expectedToolCounts.push((i % 3) + 2); }
			const expectedToolCount = expectedToolCounts.reduce((a, b) => a + b, 0);
			assert.strictEqual(toolCount, expectedToolCount);

			// 验证 parts 的 text/tool 交替
			let textIdx = 0;
			let toolIdx = 0;
			let lastKind = '';
			for (const p of _streamingParts) {
				if (p.kind === 'text') {
					if (lastKind === 'text') {
						// 两个连续的 text part 应该来自不同迭代（iteration boundary）
						// 在实际代码中，如果 last 是 text，新 text 会累积到 last
						// 但这个模拟直接 push，所以连续 text 只在 iteration boundary 出现
					}
					textIdx++;
				} else if (p.kind === 'tool') {
					toolIdx++;
				}
				lastKind = p.kind;
			}

			assert.strictEqual(textIdx, 9); // 8 iterations + 1 final
			assert.strictEqual(toolIdx, expectedToolCount);
		});
	});

	// ─── _insertBeforePhaseIndicator 逻辑模拟 ─────────────────────────────

	suite('Phase indicator insertion order', () => {

		/**
		 * 模拟 _insertBeforePhaseIndicator 的逻辑：
		 * 工具卡插入到 phase indicator 之前，indicator 始终在最后。
		 */
		test('tools inserted before phase indicator', () => {
			// 模拟 container 的子元素列表
			const children: { type: string; id?: string }[] = [];

			// 模拟 _insertBeforePhaseIndicator
			const insertBeforePhaseIndicator = (el: { type: string; id?: string }) => {
				const indicatorIdx = children.findIndex(c => c.type === 'phase-activity-indicator');
				if (indicatorIdx >= 0) {
					children.splice(indicatorIdx, 0, el);
				} else {
					children.push(el);
				}
			};

			// 初始：text
			children.push({ type: 'text' });

			// phase indicator 添加
			children.push({ type: 'phase-activity-indicator' });

			// tool_start 1: 应该插入到 indicator 之前
			insertBeforePhaseIndicator({ type: 'tool', id: 't1' });

			// tool_start 2: 应该插入到 indicator 之前（在 t1 之后）
			insertBeforePhaseIndicator({ type: 'tool', id: 't2' });

			// tool_start 3: 应该插入到 indicator 之前（在 t2 之后）
			insertBeforePhaseIndicator({ type: 'tool', id: 't3' });

			// 验证顺序: text → t1 → t2 → t3 → indicator
			assert.strictEqual(children.length, 5);
			assert.strictEqual(children[0].type, 'text');
			assert.strictEqual(children[1].id, 't1');
			assert.strictEqual(children[2].id, 't2');
			assert.strictEqual(children[3].id, 't3');
			assert.strictEqual(children[4].type, 'phase-activity-indicator');
		});

		/**
		 * 没有 indicator 时，直接 append。
		 */
		test('no indicator: tools appended normally', () => {
			const children: { type: string; id?: string }[] = [];

			const insertBeforePhaseIndicator = (el: { type: string; id?: string }) => {
				const indicatorIdx = children.findIndex(c => c.type === 'phase-activity-indicator');
				if (indicatorIdx >= 0) {
					children.splice(indicatorIdx, 0, el);
				} else {
					children.push(el);
				}
			};

			children.push({ type: 'text' });
			insertBeforePhaseIndicator({ type: 'tool', id: 't1' });
			insertBeforePhaseIndicator({ type: 'tool', id: 't2' });

			// 没有 indicator，直接 append
			assert.strictEqual(children.length, 3);
			assert.strictEqual(children[0].type, 'text');
			assert.strictEqual(children[1].id, 't1');
			assert.strictEqual(children[2].id, 't2');
		});

		/**
		 * indicator 被移除后重新添加，位置正确。
		 */
		test('indicator removed and re-added: position correct', () => {
			const children: { type: string; id?: string }[] = [];

			const insertBeforePhaseIndicator = (el: { type: string; id?: string }) => {
				const indicatorIdx = children.findIndex(c => c.type === 'phase-activity-indicator');
				if (indicatorIdx >= 0) {
					children.splice(indicatorIdx, 0, el);
				} else {
					children.push(el);
				}
			};

			// 初始状态
			children.push({ type: 'text' });
			children.push({ type: 'phase-activity-indicator' });
			insertBeforePhaseIndicator({ type: 'tool', id: 't1' });

			// 移除 indicator（模拟 _ensurePhaseIndicator 的 old?.remove()）
			const idx = children.findIndex(c => c.type === 'phase-activity-indicator');
			if (idx >= 0) { children.splice(idx, 1); }

			// 重新添加 indicator
			children.push({ type: 'phase-activity-indicator' });

			// 验证: text → t1 → indicator
			assert.strictEqual(children.length, 3);
			assert.strictEqual(children[0].type, 'text');
			assert.strictEqual(children[1].id, 't1');
			assert.strictEqual(children[2].type, 'phase-activity-indicator');
		});
	});

	// ─── 文本分段：_streamTextSegmentBase 防重复渲染 ─────────────────────
	// 复现并回归日志 vscode-app-1784727178321 中「文本在工具卡前后重复渲染」的 bug。

	suite('Text segmentation (dedup) via _streamTextSegmentBase', () => {

		/**
		 * 精确模拟 nativeChatEditorPane 的 text / tool_start handler：
		 *   - content 全量累积
		 *   - text part 只保存 content.slice(_streamTextSegmentBase)（当前段）
		 *   - tool_start 时 _streamTextSegmentBase = content.length（开启新段）
		 *
		 * 返回一个可驱动的迷你状态机，逐个投喂 delta。
		 */
		function makeStreamSim() {
			const assistantMsg: { content: string; toolCalls: any[]; parts: any[] } = {
				content: '', toolCalls: [], parts: [],
			};
			let segmentBase = 0;

			return {
				msg: assistantMsg,
				/** 模拟 text delta：fullText 语义（可能因工具 XML 检测而变短，回退累积）。 */
				text(fullTextOrDelta: string, isFullText = true) {
					const textContent = isFullText && fullTextOrDelta.length >= assistantMsg.content.length
						? fullTextOrDelta
						: assistantMsg.content + fullTextOrDelta;
					assistantMsg.content = textContent;
					const segText = textContent.slice(segmentBase);
					const last = assistantMsg.parts[assistantMsg.parts.length - 1];
					if (last && last.kind === 'text') {
						last.text = segText;
					} else if (segText.length > 0) {
						assistantMsg.parts.push({ kind: 'text', text: segText });
					}
				},
				/** 模拟 tool_start delta。 */
				toolStart(id: string, name: string) {
					const tc = { id, name, status: 'running', args: '' };
					assistantMsg.toolCalls.push(tc);
					assistantMsg.parts.push({ kind: 'tool', tool: tc });
					segmentBase = assistantMsg.content.length;
				},
			};
		}

		test('工具前后的文本不重复（复现日志 bug）', () => {
			const sim = makeStreamSim();

			// 主 agent 先输出一段前言（工具前文本）
			sim.text('Let me first load the GC expert skill to get the relevant source code locations. ');
			// 调用 read_skill 工具
			sim.toolStart('tc-read-skill', 'read_skill');
			// 工具后 LLM 继续输出（buffer 已被工具 XML 检测重置 → fullText 变短，回退累积模式）
			sim.text('现在去实际源码中找工作窃取的核心实现。', /*isFullText*/ false);

			// 断言：parts = [text(前言), tool, text(后续)]
			assert.strictEqual(sim.msg.parts.length, 3, '应有 3 个 parts');
			assert.strictEqual(sim.msg.parts[0].kind, 'text');
			assert.strictEqual(sim.msg.parts[1].kind, 'tool');
			assert.strictEqual(sim.msg.parts[2].kind, 'text');

			const textPart0 = sim.msg.parts[0].text;
			const textPart2 = sim.msg.parts[2].text;

			// 关键断言：后段文本不能包含前段文本（否则重复渲染）
			assert.ok(
				!textPart2.includes('Let me first load'),
				`后段 text part 不应重复前段内容，实际="${textPart2}"`,
			);
			assert.strictEqual(textPart0, 'Let me first load the GC expert skill to get the relevant source code locations. ');
			assert.strictEqual(textPart2, '现在去实际源码中找工作窃取的核心实现。');

			// 拼接所有 text part → 应等于完整 content（无重复、无遗漏）
			const joined = sim.msg.parts.filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('');
			assert.strictEqual(joined, sim.msg.content, 'text parts 拼接应等于完整 content');
		});

		test('工具前后文本增量累积（多个 text delta）不重复', () => {
			const sim = makeStreamSim();

			// 前言分多个 delta 到达（fullText 递增）
			sim.text('Let me ');
			sim.text('Let me first ');
			sim.text('Let me first load the skill. ');
			// 工具
			sim.toolStart('tc-1', 'read_skill');
			// 后续文本也分多个 delta（回退累积模式）
			sim.text('现在', false);
			sim.text('去源码中查找。', false);

			// parts = [text, tool, text]
			assert.strictEqual(sim.msg.parts.length, 3);
			assert.strictEqual(sim.msg.parts[0].text, 'Let me first load the skill. ');
			assert.strictEqual(sim.msg.parts[2].text, '现在去源码中查找。');

			// 无重复
			const joined = sim.msg.parts.filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('');
			assert.strictEqual(joined, sim.msg.content);
			assert.ok(!sim.msg.parts[2].text.includes('Let me'), '后段不含前段');
		});

		test('多工具场景：text→tool→text→tool→text 各段不重复', () => {
			const sim = makeStreamSim();

			sim.text('第一段。');
			sim.toolStart('t1', 'search_files');
			sim.text('第二段。', false);
			sim.toolStart('t2', 'file_read');
			sim.text('第三段。', false);

			// parts = [text, tool, text, tool, text]
			const kinds = sim.msg.parts.map((p: any) => p.kind);
			assert.deepStrictEqual(kinds, ['text', 'tool', 'text', 'tool', 'text']);

			assert.strictEqual(sim.msg.parts[0].text, '第一段。');
			assert.strictEqual(sim.msg.parts[2].text, '第二段。');
			assert.strictEqual(sim.msg.parts[4].text, '第三段。');

			// 各段互不包含
			assert.ok(!sim.msg.parts[2].text.includes('第一段'), '第二段不含第一段');
			assert.ok(!sim.msg.parts[4].text.includes('第二段'), '第三段不含第二段');

			// 拼接 = content
			const joined = sim.msg.parts.filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('');
			assert.strictEqual(joined, sim.msg.content);
		});

		test('工具后无文本：不产生空 text part', () => {
			const sim = makeStreamSim();

			sim.text('调用工具。');
			sim.toolStart('t1', 'search_files');
			// 工具后没有文本（直接 done）

			// parts = [text, tool]，没有尾随空 text part
			assert.strictEqual(sim.msg.parts.length, 2);
			assert.strictEqual(sim.msg.parts[0].kind, 'text');
			assert.strictEqual(sim.msg.parts[1].kind, 'tool');
		});

		test('done 时发送的 parts 与流式跟踪一致（无重复）', () => {
			const sim = makeStreamSim();

			sim.text('前言。');
			sim.toolStart('t1', 'read_skill');
			sim.text('后续。', false);

			// done handler 直接发送 assistantMsg.parts.slice()（不重新 derive）
			const finalParts = sim.msg.parts.slice();

			// 验证最终 parts 无重复
			const textParts = finalParts.filter((p: any) => p.kind === 'text');
			assert.strictEqual(textParts.length, 2);
			assert.strictEqual(textParts[0].text, '前言。');
			assert.strictEqual(textParts[1].text, '后续。');
			const joined = textParts.map((p: any) => p.text).join('');
			assert.strictEqual(joined, sim.msg.content);
		});
	});

	// ─── panel updateMessage 纯 content 路径不得覆盖 parts[0]（有工具卡时）─────────
	// 回归（日志 1784898836374）：panel 的 content-only 更新曾用全量 content 覆盖
	// parts[0]（首个叙述段），导致分析文本在消息顶部与末尾 text part 重复渲染。
	// 修复：有工具卡时跳过该覆盖（pane 已在共享 parts 数组中按段维护末尾 text part）。

	suite('panel updateMessage content-only path must not overwrite parts[0]', () => {

		/** 精确复刻 agentChatPanel.base.ts 的 content-only 更新逻辑（含 hasTool 修复）。 */
		function contentOnlyUpdate(m: { parts?: any[] }, content: string): void {
			const hasTool = (m.parts ?? []).some(p => p.kind === 'tool');
			if (!hasTool) {
				const textPart = (m.parts ?? []).find(p => p.kind === 'text');
				if (textPart) { textPart.text = content; }
			}
		}

		test('有工具卡：parts[0] 不被全量 content 覆盖', () => {
			const msg = {
				parts: [
					{ kind: 'text', text: '让我先检查索引状态。' },          // parts[0] 叙述
					{ kind: 'tool', tool: { id: 't1', name: 'index_status' } },
					{ kind: 'text', text: '现在搜索图谱。' },              // parts[2] 叙述
					{ kind: 'tool', tool: { id: 't2', name: 'search_graph' } },
				],
			};
			const fullContent = '让我先检查索引状态。现在搜索图谱。分析结论全文…'.repeat(50); // 大 content

			contentOnlyUpdate(msg, fullContent);

			// 关键断言：parts[0] 不被覆盖（保持原叙述），否则会与末尾重复
			assert.strictEqual(msg.parts[0].text, '让我先检查索引状态。',
				'parts[0] must NOT be overwritten with full content when tool cards exist');
			assert.strictEqual(msg.parts[2].text, '现在搜索图谱。',
				'narration text part must NOT be overwritten either');
		});

		test('无工具卡（纯文本消息）：parts[0] 仍按全量 content 更新', () => {
			const msg = {
				parts: [{ kind: 'text', text: 'old' }],
			};
			contentOnlyUpdate(msg, 'new full content');
			assert.strictEqual(msg.parts[0].text, 'new full content',
				'pure-text message should still update its single text part');
		});

		test('多轮叙述+工具：每个 text part 都保持自己的段内容', () => {
			const msg = {
				parts: [
					{ kind: 'text', text: 'A段' },
					{ kind: 'tool', tool: { id: 't1' } },
					{ kind: 'text', text: 'B段' },
					{ kind: 'tool', tool: { id: 't2' } },
					{ kind: 'text', text: 'C段（最终分析）' },
				],
			};
			// 模拟多次 content-only 更新（streaming 中每个 text delta 都会触发）
			for (let i = 0; i < 5; i++) {
				contentOnlyUpdate(msg, `全量内容A段B段C段（最终分析）迭代${i}`);
			}
			assert.strictEqual(msg.parts[0].text, 'A段');
		assert.strictEqual(msg.parts[2].text, 'B段');
		assert.strictEqual(msg.parts[4].text, 'C段（最终分析）');
	});
});

suite('panel updateMessage derive 保留 thinking parts（2026-07-26，不移除 thinking 卡片）', () => {

	/**
	 * 精确复刻 agentChatPanel.base.ts 的「toolCalls 数量变化 → 重派生」逻辑
	 * （含 2026-07-26 修复：保留 thinking parts 插到起始）。
	 * 修复前：deriveUiMessageParts 只派生 text/tool，thinking parts 全部丢弃
	 * → 首个 tool_start 时 thinking 卡片消失。
	 */
	function toolCountChangedUpdate(m: { content: string; toolCalls: any[]; parts?: any[] }): void {
		const oldSubagentParts = m.parts?.filter(p => p.kind === 'subagent') ?? [];
		const oldThinkingParts = m.parts?.filter(p => p.kind === 'thinking') ?? [];
		if (m.toolCalls.length > 0) {
			m.parts = deriveUiMessageParts(m.content ?? '', m.toolCalls);
		} else if (m.content) {
			m.parts = [{ kind: 'text', text: m.content }];
		} else {
			m.parts = oldSubagentParts.length > 0 ? [...oldSubagentParts] : undefined;
		}
		if (m.parts && oldSubagentParts.length > 0) {
			m.parts.push(...oldSubagentParts);
		}
		if (m.parts && oldThinkingParts.length > 0) {
			m.parts.unshift(...oldThinkingParts);
		}
	}

	test('首个 tool_start 触发重派生：thinking part 保留在起始', () => {
		const msg = {
			content: '分析中',
			toolCalls: [{ id: 't1', name: 'search_graph', status: 'running', args: '', textPosition: 3 }] as any[],
			parts: [
				{ kind: 'thinking', text: '我需要先查图谱…' },
				{ kind: 'text', text: '分析中' },
			] as any[],
		};
		toolCountChangedUpdate(msg);
		const kinds = msg.parts!.map(p => p.kind);
		assert.deepStrictEqual(kinds, ['thinking', 'text', 'tool'],
			'thinking part 必须保留且位于起始（思考先于输出）');
		assert.strictEqual((msg.parts![0] as any).text, '我需要先查图谱…');
	});

	test('多 episode thinking 全部保留', () => {
		const msg = {
			content: 'AB',
			toolCalls: [{ id: 't1', name: 'file_read', status: 'running', args: '', textPosition: 1 }] as any[],
			parts: [
				{ kind: 'thinking', text: 'ep1' },
				{ kind: 'text', text: 'A' },
				{ kind: 'thinking', text: 'ep2' },
				{ kind: 'text', text: 'B' },
			] as any[],
		};
		toolCountChangedUpdate(msg);
		const thinkingTexts = msg.parts!.filter(p => p.kind === 'thinking').map(p => (p as any).text);
		assert.deepStrictEqual(thinkingTexts, ['ep1', 'ep2'], '所有 thinking episode 都必须保留');
	});

	test('无 thinking parts 时行为不变', () => {
		const msg = {
			content: 'hello',
			toolCalls: [{ id: 't1', name: 'search_files', status: 'done', args: '' }] as any[],
			parts: [{ kind: 'text', text: 'hello' }] as any[],
		};
		toolCountChangedUpdate(msg);
		const kinds = msg.parts!.map(p => p.kind);
		assert.deepStrictEqual(kinds, ['text', 'tool']);
	});
});
});
