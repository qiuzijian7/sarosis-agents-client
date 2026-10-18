/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 中立层门面（重构 5.4，2026-10-17）：`agentStudio/common/constants.ts` 是纯常量（视图 id /
// 设置 id），dshHarness 不该依赖 agentStudio（反向依赖 ✗）。真源还在 agentStudio/common
//（5 处 import 不动 ⇒ 不引入风险 ✓）；这里 re-export 做中立层的门面，dshHarness 改指这里 ⇒
// dshHarness 不再依赖 agentStudio 的 constants ✓。将来退役 agentStudio 时把真源搬过来 ✓。
export * from '../contrib/agentStudio/common/constants.js';
