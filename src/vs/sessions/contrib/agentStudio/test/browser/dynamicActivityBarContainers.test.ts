/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `DynamicActivityBarContainers` 的行为网：注册/注销真的落到**全局 ViewContainer / View 注册表**上，
 * 且注销会把 pinned 存储里的残留擦掉（`sessions/contrib/agentStudio/browser/dynamicActivityBarContainers.ts`）。
 *
 * 为什么值得测：图标"点了不出现 / 消失了又复活 / 双注册把工作台带崩"这三类问题，根因都在这两条缝上，
 * 而它们此前只被 dsh 侧的**源码守卫**间接覆盖（那个守卫只看源码文本，不看行为）。
 * 本用例直接驱动真实注册表，所以它能抓到"幂等守卫被删掉"这类改动（重复注册视图会当场抛错）。
 *
 * 运行：`node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/dynamicActivityBarContainers.test.ts`
 */

import assert from 'assert';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../../workbench/common/views.js';
import type { ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import type { ViewPaneContainer } from '../../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { DynamicActivityBarContainers, IDynamicActivityBarContainerOptions } from '../../browser/dynamicActivityBarContainers.js';

const ACTIVITY_KEY = 'workbench.activity.pinnedViewlets2';
const AGENTSESSION_KEY = 'workbench.agentsession.pinnedViewlets2';

const MODULE_CONTAINER = 'test.dyn.module';
const FOREIGN_CONTAINER = 'test.dyn.foreign';
const MODULE_VIEW = 'test.dyn.module.view';

/** 只实现本封装用到的 get/store；scope/target 与内存里唯一那份存储无关。 */
class FakeStorage {
	private readonly _map = new Map<string, string>();
	constructor(seed: Record<string, string> = {}) {
		for (const [key, value] of Object.entries(seed)) {
			this._map.set(key, value);
		}
	}
	get(key: string): string | undefined { return this._map.get(key); }
	store(key: string, value: string): void { this._map.set(key, value); }
	raw(key: string): string | undefined { return this._map.get(key); }
}

const silentLog = {
	info() { }, warn() { }, error() { }, debug() { }, trace() { }, dispose() { },
} as unknown as ILogService;

/** 占位构造描述符：本套用例只关心注册表里的登记结果，从不实例化容器/视图。 */
const fakeContainerCtor = () => ({ ctor: class { }, args: [] }) as unknown as SyncDescriptor<ViewPaneContainer>;
const fakeViewCtor = () => ({ ctor: class { }, args: [] }) as unknown as SyncDescriptor<ViewPane>;

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

/**
 * 注册表是**全局**的，用例之间必须清干净（否则残留会让"双注册"用例失去意义）。
 * `test.dyn.foreign` 故意占用与模块容器**同一个视图 id**，用来做"静态注册残留"的场景。
 */
const OWNED = [
	{ containerId: MODULE_CONTAINER, viewId: MODULE_VIEW },
	{ containerId: FOREIGN_CONTAINER, viewId: MODULE_VIEW },
];

function cleanup(): void {
	for (const { containerId, viewId } of OWNED) {
		const container = viewContainersRegistry.get(containerId);
		if (!container) {
			continue;
		}
		const view = viewsRegistry.getView(viewId);
		if (view) {
			viewsRegistry.deregisterViews([view], container);
		}
		viewContainersRegistry.deregisterViewContainer(container);
	}
}

/** 模拟"别人先注册了这个视图"（静态注册残留 / 上一次没清干净）。 */
function registerForeign(): void {
	const container = viewContainersRegistry.registerViewContainer({
		id: FOREIGN_CONTAINER,
		title: { value: '外来容器', original: 'Foreign' },
		icon: ThemeIcon.fromId('symbol-misc'),
		ctorDescriptor: fakeContainerCtor(),
		storageId: FOREIGN_CONTAINER,
		order: 0,
	}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });
	viewsRegistry.registerViews([{
		id: MODULE_VIEW,
		name: { value: '外来视图', original: 'Foreign View' },
		ctorDescriptor: fakeViewCtor(),
		canToggleVisibility: false,
		canMoveView: false,
		order: 0,
	}], container);
}

function optionsOf(overrides: Partial<IDynamicActivityBarContainerOptions> = {}): IDynamicActivityBarContainerOptions {
	return {
		containerId: MODULE_CONTAINER,
		title: { value: '画布', original: 'Canvas' },
		icon: ThemeIcon.fromId('symbol-misc'),
		order: 115,
		containerCtorDescriptor: fakeContainerCtor(),
		viewId: MODULE_VIEW,
		viewCtorDescriptor: fakeViewCtor(),
		...overrides,
	};
}

suite('DynamicActivityBarContainers（图标动态注册 / 注销）', () => {
	let storage: FakeStorage;
	let containers: DynamicActivityBarContainers;

	setup(() => {
		cleanup();
		storage = new FakeStorage();
		containers = new DynamicActivityBarContainers(silentLog, storage as unknown as IStorageService);
	});

	teardown(cleanup);

	test('register：容器登记在 Sidebar 位置（ActivityBar 就是它），视图随之登记', () => {
		assert.strictEqual(containers.has(MODULE_CONTAINER), false);

		assert.strictEqual(containers.register(optionsOf()), true);

		assert.strictEqual(viewContainersRegistry.get(MODULE_CONTAINER)?.id, MODULE_CONTAINER);
		assert.ok(
			viewContainersRegistry.getViewContainers(ViewContainerLocation.Sidebar).some(c => c.id === MODULE_CONTAINER),
			'容器必须在 Sidebar 位置 —— ActivityBar 上的图标就是这个位置的容器',
		);
		assert.ok(viewsRegistry.getView(MODULE_VIEW), '容器内的视图必须跟着登记（否则图标点了是空的）');
		assert.deepStrictEqual([...containers.ids], [MODULE_CONTAINER]);
		assert.ok(containers.has(MODULE_CONTAINER));
	});

	test('重复 register 返回 false，且不重复登记视图（第二遍若真注册会当场抛错）', () => {
		const options = optionsOf();

		assert.strictEqual(containers.register(options), true);
		assert.strictEqual(containers.register(options), false, '已由本封装注册过 ⇒ 幂等跳过');
		assert.deepStrictEqual([...containers.ids], [MODULE_CONTAINER]);
	});

	test('视图 id 已被占用（静态注册残留）：跳过注册，且不留半截容器', () => {
		registerForeign();

		assert.strictEqual(containers.register(optionsOf()), false);

		assert.strictEqual(viewContainersRegistry.get(MODULE_CONTAINER), undefined,
			'不能留下一个没有视图的空容器（那就是"点了没反应"的图标）');
		assert.deepStrictEqual([...containers.ids], []);
		assert.strictEqual(viewsRegistry.getView(MODULE_VIEW)!.id, MODULE_VIEW, '外来视图不能被顶掉');
	});

	test('deregister：容器与视图双双从注册表移除；再调用返回 false', () => {
		containers.register(optionsOf());

		assert.strictEqual(containers.deregister(MODULE_CONTAINER), true);
		assert.strictEqual(viewContainersRegistry.get(MODULE_CONTAINER), undefined);
		// ⚠ View 注册表的 getView 用 null 表示"没有"（容器注册表用 undefined）——两者不通用。
		assert.strictEqual(viewsRegistry.getView(MODULE_VIEW), null);
		assert.deepStrictEqual([...containers.ids], []);
		assert.strictEqual(containers.deregister(MODULE_CONTAINER), false, '注销也要幂等');
	});

	test('deregister 清掉两个 pinned 键里的残留，其它条目毫发无损', () => {
		// 这正是"同名容器再次注册会复活且不再自动 pin"的成因：注销后存储里留着 visible:false 的死条目。
		storage = new FakeStorage({
			[ACTIVITY_KEY]: JSON.stringify([
				{ id: 'agentStudio.workspace', pinned: true, order: 10, visible: true },
				{ id: MODULE_CONTAINER, pinned: true, order: 115, visible: false },
			]),
			[AGENTSESSION_KEY]: JSON.stringify([{ id: MODULE_CONTAINER, pinned: true, order: 115, visible: false }]),
		});
		containers = new DynamicActivityBarContainers(silentLog, storage as unknown as IStorageService);

		containers.register(optionsOf());
		assert.strictEqual(containers.deregister(MODULE_CONTAINER), true);

		assert.deepStrictEqual(
			(JSON.parse(storage.raw(ACTIVITY_KEY)!) as { id: string }[]).map(e => e.id),
			['agentStudio.workspace'],
			`${ACTIVITY_KEY}：只应剔掉目标，别的容器不能动`,
		);
		assert.deepStrictEqual(JSON.parse(storage.raw(AGENTSESSION_KEY)!), [],
			`${AGENTSESSION_KEY}：唯一条目就是目标 ⇒ 剩下空数组`);
	});

	test('存储内容读不懂：注销照常成功，且不覆盖用户那份内容', () => {
		storage = new FakeStorage({ [ACTIVITY_KEY]: '{broken json' });
		containers = new DynamicActivityBarContainers(silentLog, storage as unknown as IStorageService);

		containers.register(optionsOf());

		assert.strictEqual(containers.deregister(MODULE_CONTAINER), true, '清理失败不能连累注销');
		assert.strictEqual(storage.raw(ACTIVITY_KEY), '{broken json', '绝不能把读不懂的内容当成空数组覆盖掉');
		assert.strictEqual(viewContainersRegistry.get(MODULE_CONTAINER), undefined);
	});
});
