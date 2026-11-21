#!/usr/bin/env node
// check-home-item-registry.mjs ★ 开始页统一注册表守卫（2026-11-21）
//
// 为什么必须有：开始页「工作台」网格下曾经有两套独立注册源（catalog 页 / Better Sidebar tab），
// UI 先合并成一张网格，但身份、可见性、打开链路和排序仍各走各的。统一 HomeItemRegistry 落地后，
// 这个守卫把「一个 registry / 一个投影 / 一个打开 / 一个排序字段」钉成静态契约，
// 防止以后有人再加第二份名单或把字符串前缀散回渲染层。
//
// 跑法：node dsh-plugins/check-home-item-registry.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let problems = 0;
const fail = msg => { problems++; console.log(`  ✗ ${msg}`); };
const ok = msg => console.log(`  ✔ ${msg}`);
const ck = (condition, msg) => { if (!condition) { fail(msg); } };

const host = read('dsh-plugins/vssaros-workbenches/lib/client.js');
const state = read('dsh-plugins/vssaros-workbenches/lib/state.js');
const test = read('dsh-plugins/vssaros-workbenches/test/run-workbenches-check.mjs');

// ── ① 统一描述符 / registry / 投影 / 打开 / 排序必须在场 ──────────────────
for (const [token, why] of [
	['function homeItemKey(kind, id)', '身份前缀必须由 registry 统一生成'],
	['function homeItemOfCatalogPage(page)', 'catalog 来源的 adapter'],
	['function homeItemOfTabDescriptor(descriptor)', 'Better Sidebar 来源的 adapter'],
	['function selectHomeItems(items, surface = \'start\')', '单一可见性投影'],
	['function createHomeItemRegistry(service, betterSidebar)', '两个来源合成一张表'],
	['function getHomeItemRegistry(service, betterSidebar)', '单一 registry 入口'],
	['function migrateHomeItemOrder(saved, availableKeys)', '旧双字段惰性迁移'],
	['const openHomeItem = (item, surface = \'right-tab\')', '单一打开入口'],
	['HOME_ITEM_ORDER_FIELD', '单一排序字段'],
]) {
	ck(host.includes(token), `宿主缺「${token}」（${why}）`);
}

// ── ② 渲染层不得再拼两份名单 / 自己查 items ─────────────────────────────
for (const [pattern, why] of [
	[/const wbItems = orderedWb\.map\(/, '不得再单独构造工作台名单'],
	[/const toolItems = orderedTools\.map\(/, '不得再单独构造工具名单'],
	[/const items = \[\.\.\.wbItems, \.\.\.toolItems\]/, '不得在渲染层合并两份名单'],
	[/items\.find\(entry => entry\.itemKey === key\)/, '左侧栏锚点不得依赖渲染闭包里的 items'],
	[/saveHomeOrder\(service, HOME_(WB|TOOL)_ORDER_FIELD/, '排序不得再写旧的双字段'],
]) {
	ck(!pattern.test(host), `宿主仍有旧接线：${why}`);
}
ck(/globalThis\.__vssarosOpenHomeAnchor = \(key, surface\) => openHomeItem\(registry\.get\(key\), surface\)/.test(host),
	'左侧栏锚点必须经 registry.get 走统一打开入口');
ck(/selectHomeItems\(allItems, 'start'\)/.test(host), '开始页必须使用单一投影函数');
ck(/migrateHomeItemOrder\(saved, itemKeys\)/.test(host), '排序必须走统一字段迁移');

// ── ③ 宿主承载 tab 按 origin 排除，元数据由注册方提供 ────────────────────
ck(/function isHostOwnedTab\(descriptor\)/.test(host), '必须有按 origin 排除宿主承载 tab 的判据');
ck((host.match(/vssarosOwner: HOME_ITEM_OWNER/g) || []).length >= 2,
	'catalog adapter 与图片资源 tab 都必须声明 vssarosOwner');
ck(/toolEntriesOf\(betterSidebar\)[\s\S]{0,300}isHostOwnedTab/.test(host),
	'兼容入口也必须复用同一个宿主 tab 判据');
ck(/function toolViewOf\(descriptor\)/.test(host), '工具元数据必须有单一归一函数');
ck(!/const TOOL_META\s*=/.test(host), '不得再维护按 tab id 硬编码的展示名单（TOOL_META 已下线）');
ck(/function guideIconOf\(source\)/.test(host), '图标必须由两来源共用的关键字规则推断');
ck(/String\(descriptor\.title \|\| descriptor\.id\)/.test(host), '工具标题必须来自注册方 descriptor');
ck(!/moreOnly/.test(host) && !/descriptor\.shortcut/.test(host), '不得保留已无消费方的 moreOnly / shortcut 死字段');

// ── ③b surface 落地：左侧栏锚点 / 右栏 nativeTab 都走统一投影 ───────────
ck(/open\(item\.key, 'left-anchor'\)/.test(host), '左侧栏锚点必须带 left-anchor surface');
ck(/selectHomeItems\(getHomeItemRegistry\(service, betterSidebar\)\.snapshot\(\), 'nativeTab'\)/.test(host),
	'右栏 tab 适配器必须消费同一个 nativeTab 投影');
ck(/selectHomeItems\(\[item\], 'anchor'\)/.test(host), '左侧栏锚点渲染必须走统一 anchor 投影');
ck(/function homeAnchorHost\(\)/.test(host), '锚点容器必须有兜底定位（不能只认 [data-sidebar-left]）');
ck(/data-slot=/.test(host), '锚点必须优先注入官方侧栏真实根 [data-slot="sidebar"]');
ck(/function ensureHomeAnchorObserver\(\)/.test(host), '锚点观察器必须能在首帧 DOM 未就绪后自愈');
ck(/globalThis\.__vssarosHomeItemRegistry = registry/.test(host), '注册表必须在模块加载时建立，不能依赖开始页挂载');
ck(/position:fixed;left:8px;bottom:8px/.test(host), '找不到左栏容器时必须挂可见浮层，保证点击后看得见');
ck(/homeAnchorStoreDisabled/.test(host), '锚点存储失败时必须统一回退到内存，读写同源');
ck(!/ev\.detail === 0/.test(host), 'anchor 点击不得被 detail=0 判据吞掉');
ck(/function homeAnchorSlot\(/.test(host), '锚点列表必须插到左栏上部，不能 append 到 sidebar 根末尾');
ck(/slot\.parent\.insertBefore\(box, before\)/.test(host), '锚点容器位置必须自愈，避免落到 overflow:hidden 的底部');
ck(/card\.classList\.toggle\('is-anchored', added\)/.test(host), '图钉点击必须同步给即时视觉反馈');
ck(!/if \(surface !== 'right-tab'/.test(host), '左侧栏锚点不得因 surface 强制降级，必须与开始页同链路打开');
ck(/ico\.textContent = '◈'/.test(host), '锚点条目不得裸露 icon 形状名');
ck(/is-pinned/.test(host), '图钉必须有可见的已固定状态类，不能只靠 aria-pressed 属性');
ck(/guideIcon\(anchored \? 'check' : 'pin'\)/.test(host), '已固定图钉必须换成对勾图标');
ck(/pin\.classList\.toggle\('is-pinned', added\)/.test(host), '点击必须同步切换图钉状态类');
ck(/function hideOfficialSidebarRowsForAnchors\(/.test(host), '宿主侧必须兜底隐藏左栏官方三行');
ck(/try \{ installHomeAnchorBridge\(\); \} catch/.test(host), '模块加载即安装左栏桥，不能只依赖开始页挂载');
ck(/cached\.snap !== src\.snap \|\| cached\.tabsStamp !== src\.tabsStamp/.test(host),
	'registry 缓存必须按来源签名自动失效，不能只靠组件订阅');
ck(/## 4\.2 开始页统一注册表（HomeItemRegistry）/.test(read('doc/workbench-development-standard.md')),
	'规范正文必须登记统一注册表架构');

// ── ④ 单一排序字段落地到状态层与测试 ──────────────────────────────────
ck(/homeItemOrder: \[\]/.test(state), 'emptyState 必须包含 homeItemOrder');
ck(/'homeItemOrder'\]/.test(state) || /'homeItemOrder'/.test(state), 'validateState 必须校验 homeItemOrder');
ck(/state\.homeItemOrder = order/.test(host), '旧页签迁移必须同步写统一排序字段');
ck(/统一 HomeItemRegistry/.test(test), '必须有统一注册表的端到端回归用例');
ck(/新增工具无需改任何硬编码名单/.test(test), '必须回归「新增工具零名单」判据');

if (problems === 0) {
	ok('开始页统一注册表：两个 adapter / 一个投影 / 一个打开 / 一个排序字段');
}
console.log(problems === 0
	? '\n[check-home-item-registry] ✓ 通过'
	: `\n[check-home-item-registry] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
