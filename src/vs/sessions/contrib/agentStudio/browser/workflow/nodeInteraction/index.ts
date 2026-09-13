/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点交互声明框架（机制层）barrel。
 *
 * 只含**节点无关**的内容：类型（types）+ 纯函数（helpers）。
 * 逐节点声明在 `../nodeCatalog.ts`（唯一声明源）与 `../catalogNodes/<node>.ts`。
 *
 * 消费方（`workflowExecutionService.ts` / `nodeCatalog.ts` / 测试）直接 import 本目录。
 */
export * from './types.js';
export * from './helpers.js';
