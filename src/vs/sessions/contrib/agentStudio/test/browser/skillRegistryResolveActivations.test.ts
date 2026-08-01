/*---------------------------------------------------------------------------------------------
 *  Unit tests for SkillRegistry.resolveActivations — 技能加载策略回归测试。
 *
 *  Focus: 验证「渐进披露」下所有激活技能统一以 user placement 注入（不再内联 system prompt），
 *  尤其是修复后的关键不变量：
 *    - required（agent 配置强制加载）技能必须返回且 placement === 'user'
 *    - activation === 'always' 技能必须返回且 placement === 'user'
 *  并覆盖 auto（关键词命中/未命中）、explicit（/skill）、manual、disabled 分支。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { SkillRegistry } from '../../browser/skillRegistryService.js';
import type { ISkillDefinition, ISkillActivationContext } from '../../common/skills.js';

// ── 最小 mock：让 reload() 在磁盘扫描全部失败/空跑，且不抛错 ────────────────
// reload() 会先 _skills.clear()，随后 stat/resolve/readFile 全部抛错被 catch；
// 末尾把所有 _runtimeSkills 合并回 _skills（L435-437），故 registerSkill 注入的技能稳定保留。
const noopLog = {
	info() { }, warn() { }, trace() { }, error() { }, debug() { },
} as any;

const mockFileService = {
	stat: async () => { throw new Error('no dir'); },
	resolve: async () => { throw new Error('no dir'); },
	readFile: async () => { throw new Error('no file'); },
} as any;

const mockEnv = {
	appRoot: undefined,
	userRoamingDataHome: URI.file('/tmp/empty-roaming'),
} as any;

const mockLifecycle = {
	fireBatchEvent: async () => { },
} as any;

const mockWfStorage = {
	getWorkflows: async () => [],
	onDidChangeWorkflows: () => ({ dispose() { } }),
} as any;

const mockConfig = {
	getValue: () => false,
} as any;

const mockWorkspace = {} as any;

function makeRegistry(): SkillRegistry {
	return new SkillRegistry(
		mockFileService, mockEnv, noopLog, mockLifecycle, mockWfStorage, mockConfig, mockWorkspace,
	);
}

function makeSkill(overrides: Partial<ISkillDefinition>): ISkillDefinition {
	return {
		id: 'skill-1',
		name: 'Demo Skill',
		description: 'A demo skill for testing',
		activation: 'manual',
		prompt: 'do the thing',
		source: 'user',
		...overrides,
	} as ISkillDefinition;
}

suite('SkillRegistry.resolveActivations (加载策略 / placement=user)', () => {

	let registry: SkillRegistry;

	setup(async () => {
		registry = makeRegistry();
		// 等待初始 reload 完成：_skills 此时为空（磁盘扫描全部失败）
		await registry.whenReady();
	});

	test('required 技能被强制注入且 placement === "user"', async () => {
		registry.registerSkill(makeSkill({ id: 'req-1', activation: 'manual' }));
		const ctx: ISkillActivationContext = {
			agentId: 'test-agent',
			userMessage: 'do something',
			required: ['req-1'],
			explicit: [],
		};
		const inj = await registry.resolveActivations(ctx);
		const ids = inj.map(i => i.skill.id);
		assert.ok(ids.includes('req-1'), 'required skill must be injected regardless of activation');
		const req = inj.find(i => i.skill.id === 'req-1')!;
		assert.strictEqual(req.placement, 'user', 'required skill must use user placement (Phase 1 渐进披露)');
	});

	test('activation === "always" 技能被注入且 placement === "user"', async () => {
		registry.registerSkill(makeSkill({ id: 'always-1', activation: 'always' }));
		const inj = await registry.resolveActivations({ agentId: 'test-agent', userMessage: 'hi', required: [], explicit: [] });
		const always = inj.find(i => i.skill.id === 'always-1');
		assert.ok(always, 'always skill must be injected every turn');
		assert.strictEqual(always!.placement, 'user', 'always skill must use user placement');
	});

	test('auto 技能：关键词命中则注入（placement=user），未命中则不注入', async () => {
		registry.registerSkill(makeSkill({ id: 'auto-1', activation: 'auto', match: ['review', 'refactor'] }));
		registry.registerSkill(makeSkill({ id: 'auto-miss', activation: 'auto', match: ['deploy'] }));

		const hit = await registry.resolveActivations({ agentId: 'test-agent', userMessage: 'please review the code', required: [], explicit: [] });
		assert.ok(hit.some(i => i.skill.id === 'auto-1'), 'auto skill with matched keyword must be injected');
		assert.ok(!hit.some(i => i.skill.id === 'auto-miss'), 'auto skill without keyword match must NOT be injected');
		for (const i of hit) {
			assert.strictEqual(i.placement, 'user', 'auto-injected skill must use user placement');
		}
	});

	test('explicit（/skill）技能被注入（placement=user）', async () => {
		registry.registerSkill(makeSkill({ id: 'exp-1', activation: 'manual' }));
		const inj = await registry.resolveActivations({ agentId: 'test-agent', userMessage: 'x', required: [], explicit: ['exp-1'] });
		const exp = inj.find(i => i.skill.id === 'exp-1');
		assert.ok(exp, 'explicit skill must be injected');
		assert.strictEqual(exp!.placement, 'user');
	});

	test('manual 技能未显式选择时不注入', async () => {
		registry.registerSkill(makeSkill({ id: 'manual-1', activation: 'manual' }));
		const inj = await registry.resolveActivations({ agentId: 'test-agent', userMessage: 'x', required: [], explicit: [] });
		assert.ok(!inj.some(i => i.skill.id === 'manual-1'), 'manual skill without explicit/required/auto must NOT be injected');
	});

	test('enabled === false 的技能永不注入', async () => {
		registry.registerSkill(makeSkill({ id: 'disabled-1', activation: 'always', enabled: false }));
		registry.registerSkill(makeSkill({ id: 'disabled-req', activation: 'manual', enabled: false }));
		const inj = await registry.resolveActivations({ agentId: 'test-agent', userMessage: 'x', required: ['disabled-req'], explicit: [] });
		assert.ok(!inj.some(i => i.skill.id === 'disabled-1'), 'disabled always skill must NOT be injected');
		assert.ok(!inj.some(i => i.skill.id === 'disabled-req'), 'disabled required skill must NOT be injected (enabled gate wins)');
	});

	test('所有返回的注入 placement 均为 "user"（无 system placement 残留）', async () => {
		registry.registerSkill(makeSkill({ id: 'req-1', activation: 'manual' }));
		registry.registerSkill(makeSkill({ id: 'always-1', activation: 'always' }));
		registry.registerSkill(makeSkill({ id: 'auto-1', activation: 'auto', match: ['review'] }));
		registry.registerSkill(makeSkill({ id: 'exp-1', activation: 'manual' }));
		const ctx: ISkillActivationContext = {
			agentId: 'test-agent',
			userMessage: 'please review it',
			required: ['req-1'],
			explicit: ['exp-1'],
		};
		const inj = await registry.resolveActivations(ctx);
		assert.ok(inj.length >= 4, `expected all 4 activation kinds injected, got ${inj.length}`);
		for (const i of inj) {
			assert.strictEqual(i.placement, 'user', `skill ${i.skill.id} must use user placement`);
		}
	});
});
