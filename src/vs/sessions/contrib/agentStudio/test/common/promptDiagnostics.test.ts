/*---------------------------------------------------------------------------------------------
 *  提示词诊断（promptDiagnostics）单元测试
 *
 *  这套日志的价值全在「归因正确」上，因此重点覆盖：
 *   - 指纹与 forkContext 同源（不得另写 hash）
 *   - frozenChanged / volatileChanged 严格区分（volatile 变化不是缓存断裂）
 *   - unexplained：前缀变了但无段可解释（裸 push / 拼接顺序）—— 最需要警惕的情形
 *   - 日志级别：只有前缀断裂才 warn（否则 warn 会被稀释成噪音）
 *   - 富化统计：failed 与 empty 必须分开（改前 catch{} 静默是本次要修的核心盲区）
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	snapshotPromptPrefix,
	diffPromptPrefix,
	formatPromptPrefixLog,
	formatEnrichmentLog,
	summarizeProviderError,
	probeToolGuidance,
	formatToolSchemaDiagLog,
	TOOL_GUIDANCE_PROBES,
	type IEnrichTagStat,
} from '../../common/promptDiagnostics.js';

const snap = (stable: string, context: string, vol: string, segs?: Array<{ name: string; text: string }>) =>
	snapshotPromptPrefix({ stable, context, volatile: vol, segments: segs });

suite('promptDiagnostics', () => {

	suite('snapshotPromptPrefix', () => {
		test('各层指纹独立且确定（同输入同指纹）', () => {
			const a = snap('S', 'C', 'V');
			const b = snap('S', 'C', 'V');
			assert.strictEqual(a.frozenFp, b.frozenFp);
			assert.strictEqual(a.stableFp, b.stableFp);
			assert.strictEqual(a.contextFp, b.contextFp);
			assert.strictEqual(a.volatileFp, b.volatileFp);
		});

		test('不同内容 → 不同指纹', () => {
			assert.notStrictEqual(snap('S1', 'C', 'V').stableFp, snap('S2', 'C', 'V').stableFp);
			assert.notStrictEqual(snap('S', 'C1', 'V').contextFp, snap('S', 'C2', 'V').contextFp);
		});

		test('★ frozen 指纹对 stable/context 内容互换敏感（不是两个指纹相加）', () => {
			// 若实现写成 fp(stable)+fp(context)，互换后 frozenFp 会相同 —— 那是错的
			assert.notStrictEqual(snap('AAA', 'BBB', '').frozenFp, snap('BBB', 'AAA', '').frozenFp);
		});

		test('volatile 不影响 frozen 指纹（它不进冻结前缀）', () => {
			assert.strictEqual(snap('S', 'C', 'V1').frozenFp, snap('S', 'C', 'V2').frozenFp);
		});

		test('段指纹与字符数逐段记录；空段列表不崩', () => {
			const s = snap('S', 'C', 'V', [{ name: 'persona', text: 'abc' }, { name: 'tools', text: 'defgh' }]);
			assert.strictEqual(s.segments.length, 2);
			assert.strictEqual(s.segments[0].name, 'persona');
			assert.strictEqual(s.segments[0].chars, 3);
			assert.strictEqual(s.segments[1].chars, 5);
			assert.strictEqual(snap('S', 'C', 'V').segments.length, 0);
		});

		test('chars 如实记录（供与 Tiered prompt 日志交叉核对）', () => {
			const s = snap('12345', '123', '1');
			assert.strictEqual(s.stableChars, 5);
			assert.strictEqual(s.contextChars, 3);
			assert.strictEqual(s.volatileChars, 1);
		});
	});

	suite('diffPromptPrefix', () => {
		test('无 prev（首轮）→ 全部为 false/空，不误报断裂', () => {
			const d = diffPromptPrefix(undefined, snap('S', 'C', 'V'));
			assert.strictEqual(d.frozenChanged, false);
			assert.strictEqual(d.volatileChanged, false);
			assert.strictEqual(d.unexplained, false);
			assert.deepStrictEqual(d.tiersChanged, []);
		});

		test('完全相同 → 无变化', () => {
			const d = diffPromptPrefix(snap('S', 'C', 'V'), snap('S', 'C', 'V'));
			assert.strictEqual(d.frozenChanged, false);
			assert.strictEqual(d.volatileChanged, false);
		});

		test('★ 只有 volatile 变 → volatileChanged=true 但 frozenChanged=false', () => {
			const d = diffPromptPrefix(snap('S', 'C', 'V1'), snap('S', 'C', 'V2'));
			assert.strictEqual(d.frozenChanged, false, 'volatile 变化不得报成前缀断裂');
			assert.strictEqual(d.volatileChanged, true);
		});

		test('stable 变 → tiersChanged 含 stable', () => {
			const d = diffPromptPrefix(snap('S1', 'C', 'V'), snap('S2', 'C', 'V'));
			assert.strictEqual(d.frozenChanged, true);
			assert.deepStrictEqual([...d.tiersChanged], ['stable']);
		});

		test('两层同时变 → tiersChanged 含两者', () => {
			const d = diffPromptPrefix(snap('S1', 'C1', 'V'), snap('S2', 'C2', 'V'));
			assert.deepStrictEqual([...d.tiersChanged], ['stable', 'context']);
		});

		test('段级归因：changed 带前后字符数', () => {
			const prev = snap('AB', 'C', 'V', [{ name: 'persona', text: 'A' }, { name: 'tools', text: 'B' }]);
			const next = snap('AAB', 'C', 'V', [{ name: 'persona', text: 'AA' }, { name: 'tools', text: 'B' }]);
			const d = diffPromptPrefix(prev, next);
			assert.strictEqual(d.frozenChanged, true);
			assert.strictEqual(d.segmentsChanged.length, 1);
			assert.strictEqual(d.segmentsChanged[0].name, 'persona');
			assert.strictEqual(d.segmentsChanged[0].fromChars, 1);
			assert.strictEqual(d.segmentsChanged[0].toChars, 2);
			assert.strictEqual(d.unexplained, false, '有段可解释则不算 unexplained');
		});

		test('段级归因：added / removed', () => {
			const prev = snap('A', 'C', 'V', [{ name: 'persona', text: 'A' }]);
			const next = snap('AB', 'C', 'V', [{ name: 'persona', text: 'A' }, { name: 'mcp', text: 'B' }]);
			const d1 = diffPromptPrefix(prev, next);
			assert.deepStrictEqual([...d1.segmentsAdded], ['mcp']);
			assert.deepStrictEqual([...d1.segmentsRemoved], []);
			const d2 = diffPromptPrefix(next, prev);
			assert.deepStrictEqual([...d2.segmentsRemoved], ['mcp']);
		});

		test('★★ unexplained：前缀变了但所有登记段全等（裸 push / 拼接顺序）', () => {
			const segs = [{ name: 'persona', text: 'A' }];
			const prev = snap('A', 'C', 'V', segs);
			// stable 多了未登记内容 → 段指纹全等，但 frozen 变了
			const next = snap('A + UNREGISTERED', 'C', 'V', segs);
			const d = diffPromptPrefix(prev, next);
			assert.strictEqual(d.frozenChanged, true);
			assert.strictEqual(d.segmentsChanged.length, 0);
			assert.strictEqual(d.unexplained, true, '不可归因的漂移必须被标出');
		});

		test('（控制组）前缀未变时 unexplained 恒为 false', () => {
			const d = diffPromptPrefix(snap('S', 'C', 'V1'), snap('S', 'C', 'V2'));
			assert.strictEqual(d.unexplained, false);
		});
	});

	suite('formatPromptPrefixLog', () => {
		test('首行契约：[PromptFingerprint] + 四个指纹 + chars + segments', () => {
			const s = snap('S', 'C', 'V', [{ name: 'a', text: 'x' }]);
			const { text, level } = formatPromptPrefixLog(s, undefined, 'session=abc (baseline)');
			const head = text.split('\n')[0];
			assert.ok(head.startsWith('[PromptFingerprint] frozen='), head);
			assert.ok(head.includes('stable=') && head.includes('context=') && head.includes('volatile='), head);
			assert.ok(head.includes('chars: stable=1'), head);
			assert.ok(head.includes('segments=1'), head);
			assert.ok(head.endsWith('session=abc (baseline)'), head);
			assert.strictEqual(level, 'info', '基线不应 warn');
		});

		test('★ 只有前缀断裂才 warn（否则 warn 被稀释成噪音）', () => {
			const prev = snap('S1', 'C', 'V');
			const next = snap('S2', 'C', 'V');
			const warnCase = formatPromptPrefixLog(next, diffPromptPrefix(prev, next));
			assert.strictEqual(warnCase.level, 'warn');
			assert.ok(warnCase.text.includes('FROZEN PREFIX CHANGED'));
			assert.ok(warnCase.text.includes('cache will MISS'));

			const volOnly = snap('S1', 'C', 'V2');
			const infoCase = formatPromptPrefixLog(volOnly, diffPromptPrefix(prev, volOnly));
			assert.strictEqual(infoCase.level, 'info', 'volatile 变化是预期，不得 warn');
			assert.ok(infoCase.text.includes('does not break cache'));
		});

		test('断裂时列出段级明细（changed / added / removed）', () => {
			const prev = snap('A', 'C', 'V', [{ name: 'persona', text: 'A' }, { name: 'gone', text: 'G' }]);
			const next = snap('AAB', 'C', 'V', [{ name: 'persona', text: 'AA' }, { name: 'mcp', text: 'B' }]);
			const { text } = formatPromptPrefixLog(next, diffPromptPrefix(prev, next));
			assert.ok(text.includes('changed: persona (1 → 2 chars)'), text);
			assert.ok(text.includes('added:   mcp'), text);
			assert.ok(text.includes('removed: gone'), text);
		});

		test('unexplained 时给出具体排查方向（pushSeg / 拼接顺序）', () => {
			const segs = [{ name: 'persona', text: 'A' }];
			const prev = snap('A', 'C', 'V', segs);
			const next = snap('A+X', 'C', 'V', segs);
			const { text } = formatPromptPrefixLog(next, diffPromptPrefix(prev, next));
			assert.ok(text.includes('UNEXPLAINED'), text);
			assert.ok(text.includes('pushSeg'), '必须指出裸 push 这个具体原因');
		});

		test('明细行统一缩进（便于 grep 与人读）', () => {
			const prev = snap('S1', 'C', 'V');
			const next = snap('S2', 'C', 'V');
			const rest = formatPromptPrefixLog(next, diffPromptPrefix(prev, next)).text.split('\n').slice(1);
			assert.ok(rest.length > 0);
			for (const l of rest) { assert.ok(l.startsWith('  '), l); }
		});
	});

	suite('formatEnrichmentLog', () => {
		const stat = (tagName: string, over: Partial<IEnrichTagStat> = {}): IEnrichTagStat =>
			({ tagName, chars: 0, failed: false, empty: true, ...over });

		test('首行契约：[PromptEnrich] + 长度变化 + 三类计数', () => {
			const { text, level } = formatEnrichmentLog(
				[stat('user_info', { chars: 100, empty: false }), stat('git_status')],
				200, 300,
			);
			const head = text.split('\n')[0];
			assert.ok(head.startsWith('[PromptEnrich] 200 → 300 chars (+100)'), head);
			assert.ok(head.includes('1 emitted, 1 empty, 0 failed'), head);
			assert.strictEqual(level, 'info');
		});

		test('★★ failed 与 empty 严格区分（本次要修的核心盲区）', () => {
			const { text, level } = formatEnrichmentLog([
				stat('rules', { chars: 50, empty: false }),
				stat('git_status'),                                    // 合法留白
				stat('project_context', { failed: true, error: 'ENOENT: no such file' }),
			], 100, 150);
			assert.strictEqual(level, 'warn', '有 provider 失败必须 warn');
			assert.ok(text.includes('1 emitted, 1 empty, 1 failed'));
			assert.ok(text.includes('empty:   git_status'), '空产出单独一行、不算失败');
			assert.ok(text.includes('⚠ FAILED: project_context — ENOENT: no such file'), text);
		});

		test('emitted 明细按字符数降序（先看大头）', () => {
			const { text } = formatEnrichmentLog([
				stat('a', { chars: 10, empty: false }),
				stat('b', { chars: 900, empty: false }),
				stat('c', { chars: 500, empty: false }),
			], 0, 1410);
			assert.ok(text.includes('emitted: b=900, c=500, a=10'), text);
		});

		test('多个失败各占一行（失败不折叠）', () => {
			const { text } = formatEnrichmentLog([
				stat('x', { failed: true, error: 'e1' }),
				stat('y', { failed: true, error: 'e2' }),
			], 10, 10);
			assert.strictEqual(text.split('\n').filter((l) => l.includes('FAILED')).length, 2);
		});

		test('失败但无 message 时不输出 undefined', () => {
			const { text } = formatEnrichmentLog([stat('x', { failed: true })], 10, 10);
			assert.ok(text.includes('(no message)'));
			assert.ok(!text.includes('undefined'));
		});

		test('全部为空 → info 级且不输出 emitted 行', () => {
			const { text, level } = formatEnrichmentLog([stat('a'), stat('b')], 10, 10);
			assert.strictEqual(level, 'info');
			assert.ok(!text.includes('emitted:'));
			assert.ok(text.includes('0 emitted, 2 empty, 0 failed'));
		});

		test('空 stats 不崩', () => {
			const { text, level } = formatEnrichmentLog([], 10, 10);
			assert.strictEqual(level, 'info');
			assert.ok(text.startsWith('[PromptEnrich] 10 → 10 chars (+0)'));
		});
	});

	suite('summarizeProviderError', () => {
		test('Error 取 message；折叠换行（防长堆栈刷日志）', () => {
			assert.strictEqual(summarizeProviderError(new Error('line1\n  line2')), 'line1 line2');
		});

		test('无 message 的 Error 回退到 name', () => {
			const e = new Error('');
			e.name = 'WeirdError';
			assert.strictEqual(summarizeProviderError(e), 'WeirdError');
		});

		test('非 Error 值也能转（不抛）', () => {
			assert.strictEqual(summarizeProviderError('plain string'), 'plain string');
			assert.strictEqual(summarizeProviderError(42), '42');
			assert.strictEqual(summarizeProviderError(null), 'null');
		});

		test('超长截断并加省略号', () => {
			const out = summarizeProviderError(new Error('x'.repeat(500)));
			assert.ok(out.length <= 201, `实际 ${out.length}`);
			assert.ok(out.endsWith('…'));
		});
	});

	/**
	 * probeToolGuidance —— 「关键引导文案是否真的送达模型」。
	 *
	 * 用途（日志 1787384463685）：模型不遵守 description 时，先排除
	 *   ① 文案没进 tools schema ② 被截断 ③ 工具被折叠成桥接
	 * 三种情形，再判定「模型就是不听」。此前只能靠 toolsSchemaTokens 差值间接推断。
	 */
	suite('probeToolGuidance / formatToolSchemaDiagLog', () => {
		/** 造一个含全部探针文案的 description。 */
		const fullDesc = (tool: string) => {
			const hits = TOOL_GUIDANCE_PROBES.filter(p => p.tool === tool).map(p => p.probe);
			return `desc for ${tool}. ${hits.join(' ... ')} ... tail`;
		};

		test('探针全部命中 → level=info，且逐工具输出 YES', () => {
			const tools = [
				{ name: 'file_read', description: fullDesc('file_read') },
				{ name: 'execute_code', description: fullDesc('execute_code') },
				{ name: 'terminal', description: fullDesc('terminal') },
			];
			const r = probeToolGuidance(tools);
			assert.ok(r.every(x => x.present && x.probes.every(p => p.hit)), JSON.stringify(r));
			const { text, level } = formatToolSchemaDiagLog(r, 46, 13912);
			assert.strictEqual(level, 'info');
			assert.ok(text.startsWith('[ToolSchemaDiag] tools=46 schemaTok=13912 |'), text);
			assert.ok(!text.includes('NO'), text);
		});

		test('★ 工具在场但探针 miss → warn（文案被丢或被截断，这是真缺陷）', () => {
			const tools = [
				{ name: 'file_read', description: 'Read a file.' }, // 缺全部探针
				{ name: 'execute_code', description: fullDesc('execute_code') },
				{ name: 'terminal', description: fullDesc('terminal') },
			];
			const { text, level } = formatToolSchemaDiagLog(probeToolGuidance(tools), 46, 13000);
			assert.strictEqual(level, 'warn');
			assert.ok(text.includes('probeHint=NO'), text);
			assert.ok(text.includes('a guidance probe MISSED while the tool IS present'), text);
		});

		test('★ 工具不在场（被折叠）→ ABSENT 且保持 info（问题在折叠策略，非文案）', () => {
			const { text, level } = formatToolSchemaDiagLog(probeToolGuidance([{ name: 'search_code', description: 'x' }]), 30, 9000);
			assert.strictEqual(level, 'info', '折叠是策略结果，不该报 warn');
			assert.ok(text.includes('file_read: ABSENT(folded or disabled)'), text);
			assert.ok(text.includes('execute_code: ABSENT'), text);
		});

		test('★ 截断模拟：description 末尾被裁 → 末段探针 miss 而首段命中', () => {
			// COMMAND SHAPE 段在 description 末尾，最容易被截断
			const tools = [{ name: 'execute_code', description: 'long prefix without the tail guidance' }];
			const r = probeToolGuidance(tools);
			const ec = r.find(x => x.tool === 'execute_code')!;
			assert.strictEqual(ec.present, true);
			assert.strictEqual(ec.probes.every(p => !p.hit), true);
			assert.strictEqual(formatToolSchemaDiagLog(r, 40, 12000).level, 'warn');
		});

        test('descChars 如实反映实际发送长度（用于对比本地源码长度）', () => {
			const desc = 'x'.repeat(1234);
			const r = probeToolGuidance([{ name: 'file_read', description: desc }]);
			assert.strictEqual(r.find(x => x.tool === 'file_read')!.descChars, 1234);
		});

		test('description 缺失 / 非字符串不崩', () => {
			const r = probeToolGuidance([{ name: 'file_read' }, { name: 'terminal', description: undefined }]);
			assert.strictEqual(r.find(x => x.tool === 'file_read')!.descChars, 0);
			assert.strictEqual(r.find(x => x.tool === 'file_read')!.present, true, '有 name 即算在场');
		});

		test('空 tools 列表 → 全部 ABSENT，不抛', () => {
			const r = probeToolGuidance([]);
			assert.ok(r.length >= 3);
			assert.ok(r.every(x => !x.present));
			assert.strictEqual(formatToolSchemaDiagLog(r, 0, 0).level, 'info');
		});

		test('探针表覆盖三个关键工具（新增引导文案时应在此登记）', () => {
			const tools = new Set(TOOL_GUIDANCE_PROBES.map(p => p.tool));
			assert.ok(tools.has('file_read'));
			assert.ok(tools.has('execute_code'));
			assert.ok(tools.has('terminal'));
		});
	});
});
