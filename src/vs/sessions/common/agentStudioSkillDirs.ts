/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 中立层门面（重构 5.4，2026-10-17）：`agentStudio/common/skillEcosystemDirs.ts` 是纯函数
//（技能目录解析），dshHarness 不该依赖 agentStudio（反向依赖 ✗）。真源还在 agentStudio/common
//（1 处 import 不动 ⇒ 不引入风险 ✓）；这里 re-export 做中立层的门面 ✓。
export * from '../contrib/agentStudio/common/skillEcosystemDirs.js';
