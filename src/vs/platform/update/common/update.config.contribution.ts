/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb, isWindows } from '../../../base/common/platform.js';
import { PolicyCategory } from '../../../base/common/policy.js';
import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'update',
	order: 15,
	title: localize('updateConfigurationTitle', "Update"),
	type: 'object',
	properties: {
		'update.mode': {
			type: 'string',
			enum: ['none', 'manual', 'start', 'default'],
			// ★★ 2026-10-30（VsSaros）：产品默认改成 **manual** —— 用户明确要求
			//   "启动时不要弹出升级提示"。`default` 会在启动 30s 后自动检查、每小时再查，
			//   Ready 后弹通知/徽章（用户看到的就是这类弹窗）✗。
			//
			// ⚠ 为什么不是改 `product.json` 的 `update` 段：那段是**没人读的死字段**
			//   （`IProductConfiguration` 里没有 update，`abstractUpdateService` 读的是
			//   configurationService 的 `update.mode`，默认值**只**来自这里）——
			//   2026-10-29 曾在 product.json 写过 `update.mode: manual`，真机日志仍然只有
			//   `update#setState idle` 而**没有** `update#ctor - manual checks only` ⇒ 从没生效过 ✗✗。
			//
			// 手动入口一个不少：帮助菜单「检查更新…」、VsSaros 菜单 →「系统与更新」面板
			// （`dshHarness.checkAppUpdates`）、以及 `upgradeApp()` 里的 `checkForUpdates(true)`。
			default: 'manual',
			scope: ConfigurationScope.APPLICATION,
			description: localize('updateMode', "Configure whether you receive automatic updates. Requires a restart after change. The updates are fetched from a Microsoft online service."),
			tags: ['usesOnlineServices'],
			enumDescriptions: [
				localize('none', "Disable updates."),
				localize('manual', "Disable automatic background update checks. Updates will be available if you manually check for updates."),
				localize('start', "Check for updates only on startup. Disable automatic background update checks."),
				localize('default', "Enable automatic update checks. Code will check for updates automatically and periodically.")
			],
			policy: {
				name: 'UpdateMode',
				category: PolicyCategory.Update,
				minimumVersion: '1.67',
				localization: {
					description: { key: 'updateMode', value: localize('updateMode', "Configure whether you receive automatic updates. Requires a restart after change. The updates are fetched from a Microsoft online service."), },
					enumDescriptions: [
						{
							key: 'none',
							value: localize('none', "Disable updates."),
						},
						{
							key: 'manual',
							value: localize('manual', "Disable automatic background update checks. Updates will be available if you manually check for updates."),
						},
						{
							key: 'start',
							value: localize('start', "Check for updates only on startup. Disable automatic background update checks."),
						},
						{
							key: 'default',
							value: localize('default', "Enable automatic update checks. Code will check for updates automatically and periodically."),
						}
					]
				},
			}
		},
		'update.channel': {
			type: 'string',
			default: 'default',
			scope: ConfigurationScope.APPLICATION,
			description: localize('updateMode', "Configure whether you receive automatic updates. Requires a restart after change. The updates are fetched from a Microsoft online service."),
			deprecationMessage: localize('deprecated', "This setting is deprecated, please use '{0}' instead.", 'update.mode')
		},
		'update.enableWindowsBackgroundUpdates': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			title: localize('enableWindowsBackgroundUpdatesTitle', "Enable Background Updates"),
			description: localize('enableWindowsBackgroundUpdates', "Enable to download and install new VS Code versions in the background."),
			included: isWindows && !isWeb
		},
		'update.showReleaseNotes': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('showReleaseNotes', "Show Release Notes after an update. The Release Notes are fetched from a Microsoft online service."),
			tags: ['usesOnlineServices'],
			agentsWindow: { default: false, readOnly: true },
		},
		'update.showPostInstallInfo': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('showPostInstallInfo', "Show a post-install update tooltip in the title bar instead of opening the release notes editor."),
			tags: ['usesOnlineServices']
		},
		'update.titleBar': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('updateTitleBar', "Show the update indicator in the title bar."),
			included: !isWeb
		}
	}
});
