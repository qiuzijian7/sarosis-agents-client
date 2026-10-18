/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 中立层门面（重构 5.4，2026-10-17）：`sarosPaths` 是纯 common 数据（路径常量 + 解析），
// dshHarness 不该依赖 agentStudio（反向依赖 ✗——5.4 的清单要解开的就是这个）。
// 真源还在 agentStudio/common（43 处 import 不动 ⇒ 不引入风险 ✓）；这里 re-export 做中立层的门面，
// dshHarness 改指这里 ⇒ dshHarness 不再依赖 agentStudio ✓。
// 将来退役 agentStudio 时，把真源搬过来、这个文件改成真源本体（import 方不用再改 ✓）。
export * from '../contrib/agentStudio/common/sarosPaths.js';
