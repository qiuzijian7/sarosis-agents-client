/*---------------------------------------------------------------------------------------------
 *  LightAI Provider — 腾讯光子内部 LightAI（aigclsp.com）**图像生成**模型提供者
 *
 *  以标准 VS Code 扩展形态接入（`vscode.lm.registerLanguageModelChatProvider`），
 *  **不修改 VsSaros 内核**：VsSaros 的 languageModelsBridge 会自动把 vendor `lightai`
 *  桥接成 `lm:lightai` provider；VsSaros 侧按 `supportsImageGen` 分流后，
 *  这些模型只出现在「模型文生图」节点，经 `lightai.generateImage` 命令调用。
 *
 *  ⚠️ 本扩展仅暴露图像生成模型（lightai.imageModels），不提供聊天模型：
 *     `provideLanguageModelChatResponse` 为守卫实现，选中即报错。
 *
 *  ⚠️ 网络约束：LightAI 上游按来源 IP 白名单，仅接受腾讯办公网请求。
 *     该扩展运行在 VsSaros 所在机器上，因此本机需处于办公网。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { createModelInfo, parseModelsConfig, getDefaultTokenLimits } from '@saros/shared';
import { fetchCredentials, resolveUserId, parseKParams, type LightAICredentials } from './browserLogin';
import { LightAIStatusView, LIGHTAI_VIEW_ID } from './statusView';
import { discoverFloodModels } from './modelDiscovery';
import { generateFloodImage, generateFloodVideo, generateFloodModel3D, generateFloodAudio, pingFlood } from './floodGen';

const VENDOR = 'lightai';
const LOG = '[LightAI]';

// ─── 配置读取 ────────────────────────────────────────────────────────────────

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`lightai.${key}`, fallback);
}

/**
 * 三类生成模型清单（由「获取模型信息」自动发现写入，见 modelDiscovery.discoverFloodModels）。
 * 模型 ID 即 lightflood 前端注册表的 appValue：
 *   picture_* → 图片（picture_banana_2 / picture_gpt_image_2 / picture_seedream_50 / picture_midjourney_8_2 …）
 *   video_*   → 视频（video_minimax_h3 / video_hunyuan …）
 *   model_*   → 3D（model_hunyuan_3_5 …）
 */
function getList(key: 'imageModels' | 'videoModels' | 'model3dModels' | 'audioModels', fallback: string[]): string[] {
	const value = cfg<unknown>(key, fallback);
	if (Array.isArray(value)) {
		const list = value.filter((v): v is string => typeof v === 'string' && !!v);
		return list.length > 0 ? list : fallback;
	}
	return parseModelsConfig(value) ?? fallback;
}

function getConfiguredImageModelNames(): string[] {
	return getList('imageModels', [
		'picture_banana_2',
		'picture_gpt_image_2',
		'picture_seedream_50',
		'picture_midjourney_8_2',
	]);
}

function getConfiguredVideoModelNames(): string[] {
	return getList('videoModels', ['video_minimax_h3', 'video_hunyuan']);
}

function getConfiguredModel3DNames(): string[] {
	return getList('model3dModels', ['model_hunyuan_3_5']);
}

function getConfiguredAudioModelNames(): string[] {
	return getList('audioModels', ['audio_speech_28', 'seed_audio_1']);
}

// ─── 凭据存取与自动获取（testConnection 等复用）─────────────────────────────

async function saveCredentials(creds: LightAICredentials): Promise<void> {
	const target = vscode.ConfigurationTarget.Global;
	const conf = vscode.workspace.getConfiguration();
	await conf.update('lightai.cookie', creds.cookie, target);
	await conf.update('lightai.userId', creds.userId, target);

	// 顺带用 k 参数回填应用/项目上下文（app_id / app_name / product_id / product_name），
	// 这样「所有参数信息」一次性就位，无需手工填写。
	// 自动发现三类生成模型（从 lightflood 前端 bundle 解析，无模型列表 API）
	const found = await discoverFloodModels();
	if (found) {
		if (found.image.length > 0) { await conf.update('lightai.imageModels', found.image, target); }
		if (found.video.length > 0) { await conf.update('lightai.videoModels', found.video, target); }
		if (found.model3d.length > 0) { await conf.update('lightai.model3dModels', found.model3d, target); }
		if (found.audio.length > 0) { await conf.update('lightai.audioModels', found.audio, target); }
	}

	const kp = parseKParams(cfg<string>('k', ''));
	if (kp.appId) { await conf.update('lightai.appId', kp.appId, target); }
	if (kp.appName) { await conf.update('lightai.appName', kp.appName, target); }
	if (kp.bizId) { await conf.update('lightai.bizId', kp.bizId, target); }
	if (kp.projectName) { await conf.update('lightai.projectName', kp.projectName, target); }
}

function hasCredentials(): boolean {
	return !!cfg<string>('cookie', '') && !!cfg<string>('userId', '');
}

/**
 * 自动获取凭据：首次需用户在弹出的浏览器中登录一次，
 * 之后会话持久化在扩展的 profile 目录，后续全程无交互。
 */
async function autoAcquireCredentials(context: vscode.ExtensionContext): Promise<LightAICredentials | undefined> {
	const profileDir = path.join(context.globalStorageUri.fsPath, 'browser-profile');
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(profileDir));
	} catch {
		/* 目录已存在，忽略 */
	}

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'LightAI：正在获取登录凭据',
			cancellable: true,
		},
		async (progress, token) => {
			if (token.isCancellationRequested) {
				return undefined;
			}
			try {
				const creds = await fetchCredentials(profileDir, (msg) =>
					progress.report({ message: msg }),
				);
				await saveCredentials(creds);
				return creds;
			} catch (err) {
				const msg = (err as Error).message || String(err);
				console.error(`${LOG} 自动获取凭据失败: ${msg}`);
				vscode.window.showErrorMessage(`LightAI 获取凭据失败：${msg}`, '查看设置').then((pick) => {
					if (pick === '查看设置') {
						vscode.commands.executeCommand('workbench.action.openSettings', 'lightai');
					}
				});
				return undefined;
			}
		},
	);
}

/** 凭据已存在时，用 /api/user/check 校验并自动纠正 userId（Cookie 过期则提示重新登录）。 */
async function validateAndFixUserId(): Promise<void> {
	const cookie = cfg<string>('cookie', '');
	if (!cookie) {
		return;
	}
	try {
		const info = await resolveUserId(cookie);
		if (info.userId && info.userId !== cfg<string>('userId', '')) {
			await vscode.workspace
				.getConfiguration()
				.update('lightai.userId', info.userId, vscode.ConfigurationTarget.Global);
			console.log(`${LOG} 已自动同步 userId=${info.userId}`);
		}
	} catch (e) {
		console.warn(`${LOG} 校验 Cookie 失败（可能需要重新登录）：${(e as Error).message}`);
		vscode.window
			.showWarningMessage('LightAI 登录态已失效，是否重新登录？', '重新登录')
			.then((pick) => {
				if (pick === '重新登录') {
					vscode.commands.executeCommand('lightai.login');
				}
			});
	}
}

// ─── Provider ───────────────────────────────────────────────────────────────

class LightAIProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	dispose(): void {
		this._onDidChange.dispose();
	}

	notifyModelsChanged(): void {
		this._onDidChange.fire();
	}

	// ---- 模型列表 ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		// 未配置 cookie / userId 时不暴露模型（对齐 CodeBuddy 未登录行为）
		if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
			console.log(`${LOG} 未配置 cookie/userId，不暴露模型`);
			return [];
		}

		const limits = getDefaultTokenLimits();

		// 三类生成模型全部来自 lightflood（lightai.imageModels / videoModels /
		// model3dModels，由「获取模型信息」自动发现写入）。VS Code 的 LM API 无法
		// 区分品类，本 provider 平铺全部模型，由 VsSaros 侧按前缀推断能力分流：
		//   picture_* → supportsImageGen →「模型文生图」节点
		//   video_*   → supportsVideoGen →「模型文生视频」节点
		//   model_*   → supportsModelGen →「3D 模型生成」节点
		// 若在聊天节点被误选，provideLanguageModelChatResponse 的守卫会显式报错。
		// 注意：createModelInfo 的第 4 个参数就是 detail（readonly，只能构造时传入）
		const info = (id: string, label: string) =>
			createModelInfo(id, '', VENDOR, label, limits, { supportsImages: false, supportsToolCall: false });
		return [
			...getConfiguredImageModelNames().map(id => info(id, '图片生成模型（请在「模型文生图」节点中使用）')),
			...getConfiguredVideoModelNames().map(id => info(id, '视频生成模型（请在「模型文生视频」节点中使用）')),
			...getConfiguredModel3DNames().map(id => info(id, '3D 模型生成（请在「3D 模型生成」节点中使用）')),
			...getConfiguredAudioModelNames().map(id => info(id, '音频生成模型（请在「模型文生音频」节点中使用）')),
		];
	}

	// ---- 对话（守卫）----

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		_messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		_progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		_token: vscode.CancellationToken,
	): Promise<void> {
		// 本扩展仅提供图像生成模型：上游 `/api/gemini/chat/send_message*` 系列端点
		// 只接受聊天模型枚举，图片模型会被 422 拒绝。聊天需求请使用其它 provider；
		// 图片生成走 `lightai.generateImage` 命令（VsSaros 的「模型文生图」节点）。
		throw new Error(
			`LightAI 模型 "${model.id}" 是图片生成模型，不支持聊天。` +
				`请在「模型文生图」节点中使用，或在聊天节点选择其它 Provider 的聊天模型。`,
		);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const raw =
			typeof text === 'string'
				? text
				: text.content
						.map((p) => ((p as unknown as { value?: string })?.value ?? ''))
						.join('');
		// 粗略估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token
		const cjk = (raw.match(/[\u4e00-\u9fa5]/g) || []).length;
		const rest = raw.length - cjk;
		return Math.ceil(cjk + rest / 4);
	}
}

// ─── 激活 ────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
	const provider = new LightAIProvider();
	context.subscriptions.push(provider);

	// 关键：以 vendor `lightai` 注册标准 Language Model Provider。
	// VsSaros 的 languageModelsBridge 会自动发现并桥接为 `lm:lightai`。
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

	// 侧边栏状态面板（含登录按钮）。插件详情页的登录按钮是内核特例，
	// 为保持零内核改动，登录入口由扩展自带的 view 承载。
	const statusView = new LightAIStatusView();
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(LIGHTAI_VIEW_ID, statusView),
	);

	// 状态栏快捷入口：点击即登录
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'lightai.login';
	const updateStatusBar = (): void => {
		const loggedIn = hasCredentials();
		const user = cfg<string>('userId', '');
		statusBar.text = loggedIn ? `$(check) LightAI: ${user}` : '$(sign-in) LightAI: 登录';
		statusBar.tooltip = loggedIn
			? `LightAI 已登录（${user}），点击查看/登录`
			: '点击登录 LightAI（打开浏览器获取 Cookie 与 User ID）';
		statusBar.show();
	};
	updateStatusBar();
	context.subscriptions.push(statusBar);

	// 配置变更时刷新模型列表、面板与状态栏
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('lightai')) {
				provider.notifyModelsChanged();
				statusView.refresh();
				updateStatusBar();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.openSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', 'lightai');
		}),
	);

	// 一键登录：打开浏览器完成一次登录，自动抓取 Cookie / User ID / 应用与项目信息
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.login', async () => {
			const creds = await autoAcquireCredentials(context);
			if (creds) {
				provider.notifyModelsChanged();
				statusView.refresh();
				updateStatusBar();
				vscode.window.showInformationMessage(
					`LightAI 登录成功（${creds.userId}），已自动写入 Cookie、User ID 与应用/项目参数。`,
				);
			}
		}),
	);

	// 登出：清空凭据（保留浏览器 profile，便于下次静默复用）
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.logout', async () => {
			const target = vscode.ConfigurationTarget.Global;
			const conf = vscode.workspace.getConfiguration();
			await conf.update('lightai.cookie', '', target);
			await conf.update('lightai.userId', '', target);
			provider.notifyModelsChanged();
			statusView.refresh();
			updateStatusBar();
			vscode.window.showInformationMessage('LightAI 已登出。');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.showPanel', async () => {
			await vscode.commands.executeCommand('lightaiStatus.focus');
		}),
	);

	// 获取模型信息：从 lightflood 前端 bundle 重新发现三类生成模型
	//（lightflood 上新模型后无需更新插件；不重新登录，只拉取模型清单）
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.refreshModels', async () => {
			// 未登录时先给出明确提示，避免静默失败
			if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
				vscode.window
					.showWarningMessage('尚未登录 LightAI，请先点击「登录」获取凭据。', '登录')
					.then((pick) => {
						if (pick === '登录') {
							vscode.commands.executeCommand('lightai.login');
						}
					});
				return;
			}

			const target = vscode.ConfigurationTarget.Global;
			const conf = vscode.workspace.getConfiguration();

			const found = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'LightAI：正在获取模型信息…' },
				async () => discoverFloodModels(),
			);

			let updated = 0;
			const summary: string[] = [];
			if (found) {
				if (found.image.length > 0) {
					await conf.update('lightai.imageModels', found.image, target);
					updated++;
					summary.push(`图片 ${found.image.length}`);
				}
				if (found.video.length > 0) {
					await conf.update('lightai.videoModels', found.video, target);
					updated++;
					summary.push(`视频 ${found.video.length}`);
				}
				if (found.model3d.length > 0) {
					await conf.update('lightai.model3dModels', found.model3d, target);
					updated++;
					summary.push(`3D ${found.model3d.length}`);
				}
				if (found.audio.length > 0) {
					await conf.update('lightai.audioModels', found.audio, target);
					updated++;
					summary.push(`音频 ${found.audio.length}`);
				}
			}

			// 同步刷新：模型列表、侧边栏面板、状态栏
			provider.notifyModelsChanged();
			statusView.refresh();
			updateStatusBar();

			if (updated === 0) {
				vscode.window.showWarningMessage(
					'未能获取模型信息，已保留现有 lightai.imageModels / videoModels / model3dModels 配置。',
				);
				return;
			}

			vscode.window.showInformationMessage(
				`LightAI 模型信息已更新（${summary.join('、')} 个）：${[...(found?.image ?? []), ...(found?.video ?? []), ...(found?.model3d ?? [])].join(', ')}`,
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.testConnection', async () => {
			const cookie = cfg<string>('cookie', '');
			const userId = cfg<string>('userId', '');
			if (!cookie || !userId) {
				vscode.window.showWarningMessage('请先在设置中填写 lightai.cookie 与 lightai.userId。');
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'LightAI：正在测试连接…' },
				async () => {
					try {
						// 用 lightflood get_voucher 校验凭据与网络连通性
						const voucher = await pingFlood();
						if (voucher) {
							vscode.window.showInformationMessage(
								`LightAI 连接成功（用户 ${userId}，编排凭证已获取）。`,
							);
						} else {
							vscode.window.showErrorMessage('LightAI 连接失败：编排服务未返回凭证（Cookie 可能已过期）。');
						}
					} catch (err) {
						vscode.window.showErrorMessage(`LightAI 连接失败：${(err as Error).message}`);
					}
				},
			);
		}),
	);

	// 文生图：被 `lm:lightai` vendor provider 的 `generateImage` 通过 `${vendor}.generateImage`
	// 命令转发调用（见 languageModelsBridge.ts::LanguageModelVendorProvider.generateImage）。
	//
	// 全部走智能编排域（lightflood /api/task/create 异步任务队列），实现见 src/floodGen.ts：
	//   picture_banana_2       → foreign / Genai-banana2img（Nano Banana 2）
	//   picture_gpt_image_2    → foreign / microsoft_image-image_gen|edits
	//   picture_seedream_50    → volces_ark / image40_generate（即梦 5.0）
	//   picture_midjourney_8_2 → Midjoumey / text2img（Midjourney V8.2）
	// 统一轮询 /api/task/list_status 直至 status=2，结果为带签名的 COS https URL。
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.generateImage', async (params: {
			modelId: string;
			prompt: string;
			negativePrompt?: string;
			width?: number;
			height?: number;
			numImages?: number;
			quality?: string;
			imageInput?: string;
		}) => {
			if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
				throw new Error('LightAI 文生图：请先登录（cookie / userId 为空）');
			}
			const images = getConfiguredImageModelNames();
			if (!images.includes(params.modelId)) {
				throw new Error(
					`LightAI 文生图：模型 "${params.modelId}" 不在 lightai.imageModels 中。` +
					`当前可用：${images.join(', ')}。可执行「LightAI: 获取模型信息」刷新清单。`,
				);
			}
			return await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `LightAI：正在生成图片（${params.modelId}）…`,
					// 进度不可取消：中断轮询会导致已扣点的任务结果无法取回
					cancellable: false,
				},
				async () => await generateFloodImage(params),
			);
		}),
	);

	// 视频生成（智能编排域）。被 `lm:lightai` vendor 的 generateVideo 转发调用；
	// 也可由命令面板 / 其它扩展经 executeCommand('lightai.generateVideo', params) 调用。
	// 返回 { videos: [{ url, posterUrl? }] }。
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.generateVideo', async (params: {
			modelId: string;
			prompt?: string;
			imageInput?: string;
			duration?: number;
			resolution?: string;
			ratio?: string;
			width?: number;
			height?: number;
		}) => {
			if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
				throw new Error('LightAI 视频生成：请先登录（cookie / userId 为空）');
			}
			const videos = getConfiguredVideoModelNames();
			if (!videos.includes(params.modelId)) {
				throw new Error(
					`LightAI 视频生成：模型 "${params.modelId}" 不在 lightai.videoModels 中。` +
					`当前可用：${videos.join(', ')}。可执行「LightAI: 获取模型信息」刷新清单。`,
				);
			}
			return await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `LightAI：正在生成视频（${params.modelId}）…`, cancellable: false },
				async () => await generateFloodVideo(params),
			);
		}),
	);

	// 3D 模型生成（智能编排域，混元 3.5 图生/文生）。
	// 返回 { models: [{ url(glb), previewUrl? }] }。
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.generateModel3D', async (params: {
			modelId: string;
			prompt?: string;
			imageInput?: string;
			faceCount?: number | 'auto';
			enablePbr?: boolean;
		}) => {
			if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
				throw new Error('LightAI 3D 生成：请先登录（cookie / userId 为空）');
			}
			const models3d = getConfiguredModel3DNames();
			if (!models3d.includes(params.modelId)) {
				throw new Error(
					`LightAI 3D 生成：模型 "${params.modelId}" 不在 lightai.model3dModels 中。` +
					`当前可用：${models3d.join(', ')}。可执行「LightAI: 获取模型信息」刷新清单。`,
				);
			}
			return await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `LightAI：正在生成 3D 模型（${params.modelId}）…`, cancellable: false },
				async () => await generateFloodModel3D(params),
			);
		}),
	);

	// 音频生成（TTS 文生语音，智能编排域）。
	// 返回 { audios: [{ url }] }。
	context.subscriptions.push(
		vscode.commands.registerCommand('lightai.generateAudio', async (params: {
			modelId: string;
			prompt?: string;
			voiceId?: string;
			speed?: number;
			emotion?: string;
			sampleRate?: number;
		}) => {
			if (!cfg<string>('cookie', '') || !cfg<string>('userId', '')) {
				throw new Error('LightAI 音频生成：请先登录（cookie / userId 为空）');
			}
			const audios = getConfiguredAudioModelNames();
			if (!audios.includes(params.modelId)) {
				throw new Error(
					`LightAI 音频生成：模型 "${params.modelId}" 不在 lightai.audioModels 中。` +
					`当前可用：${audios.join(', ')}。可执行「LightAI: 获取模型信息」刷新清单。`,
				);
			}
			return await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `LightAI：正在生成音频（${params.modelId}）…`, cancellable: false },
				async () => await generateFloodAudio(params),
			);
		}),
	);

	// 激活时**不主动**拉起浏览器 —— 浏览器只在用户点击「登录」按钮时才启动。
	// 仅在已存在凭据时做一次后台校验并纠正 userId（纯网络请求，无浏览器、无弹窗）。
	if (hasCredentials()) {
		void validateAndFixUserId().then(() => {
			provider.notifyModelsChanged();
			statusView.refresh();
			updateStatusBar();
		});
	} else if (cfg<boolean>('autoLoginOnActivate', false)) {
		// 例外：用户显式开启「激活时自动登录」才自动拉起
		void autoAcquireCredentials(context).then((creds) => {
			if (creds) {
				provider.notifyModelsChanged();
				statusView.refresh();
				updateStatusBar();
			}
		});
	}

	console.log(`${LOG} provider activated (vendor=${VENDOR})`);
}

export function deactivate(): void {
	/* no-op */
}
