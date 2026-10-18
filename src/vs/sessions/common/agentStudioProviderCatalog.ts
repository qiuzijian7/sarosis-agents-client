/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 中立层门面（重构 5.4，2026-10-17）：`agentStudio/common/providerCatalog.ts` 是纯数据
//（`BUILTIN_PROVIDER_IDENTITIES`——内置 provider 清单），dshHarness 不该依赖 agentStudio
//（反向依赖 ✗）。真源还在 agentStudio/common（1 处 import 不动 ⇒ 不引入风险 ✓）；这里 re-export
// 做中立层的门面，dshHarness 改指这里 ⇒ 反向依赖解开 ✓。将来退役 agentStudio 时把真源搬过来 ✓。
export * from '../contrib/agentStudio/common/providerCatalog.js';
