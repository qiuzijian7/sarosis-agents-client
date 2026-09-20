/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 进程隔离传输工厂的运行时注册表。
 *
 * 为什么需要它：`agentTurnExecutor` 的 pi 门控拿不到 `IMainProcessService`（host 面
 * 不含 DI），而传输工厂依赖它 ⇒ 由有 DI 的装配点（agentStudio.contribution）在启动时
 * 注册，门控消费时读取。未注册（测试/无头环境）⇒ process 档静默回落进程内 + warn。
 */

import type { KernelProcTransportFactory } from './kernelProcTransport.js';

let registered: KernelProcTransportFactory | undefined;

export function registerKernelProcTransportFactory(factory: KernelProcTransportFactory): void {
	registered = factory;
}

export function getKernelProcTransportFactory(): KernelProcTransportFactory | undefined {
	return registered;
}

/** 测试用：清空注册（避免套件间串扰）。 */
export function clearKernelProcTransportFactory(): void {
	registered = undefined;
}
