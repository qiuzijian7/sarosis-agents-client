/*---------------------------------------------------------------------------------------------
 *  LightAI 自动登录：基于 Playwright 持久化上下文读取会话 Cookie
 *
 *  为什么不用「读取浏览器 Cookie 库 + 解密」：
 *    新版 Chrome（127+）的 cookie 采用 App-Bound Encryption（加密值前缀 v20），
 *    解密需要绕过 Chrome 的应用绑定保护（正是该机制要防的窃 cookie 行为），
 *    既不稳定也不应当实现。
 *
 *  Playwright 方案：由我们启动受控浏览器实例，`context.cookies()` 通过 CDP 向浏览器
 *  自身的 Cookie 管理器查询，可**合法**取得 httpOnly Cookie，无需任何解密。
 *
 *  使用持久化上下文（launchPersistentContext）把登录态落盘：
 *    - 首次：以有头模式打开，用户手动完成 Oasis/QQ 登录，会话写入 profile
 *    - 之后：直接读取 profile 中的 Cookie，无需任何交互（真正的「自动获取」）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { chromium, type BrowserContext } from 'playwright-core';

const LOG = '[LightAI][login]';

export interface LightAICredentials {
	/** 形如 "sessionid=xxx; uid=yyy" */
	cookie: string;
	/** 企微邮箱，对应请求头 x-user-id */
	userId: string;
	sessionId: string;
	openId: string;
}

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`lightai.${key}`, fallback);
}

/**
 * 解析 URL 里的 k 参数，回填应用/项目上下文。
 * k 是 base64，内容形如：
 *   app_id=137&app_name=智能对话&product_id=73&product_name=萨罗斯GR项目
 * 与 billing_info / 请求头的 app_id、biz_id、project_name 一一对应。
 */
export function parseKParams(k: string): {
	appId?: string;
	appName?: string;
	bizId?: string;
	projectName?: string;
} {
	const b64 = (k || '').split('&')[0].trim(); // 去掉尾部 &lang=zh_CN 等
	if (!b64) {
		return {};
	}
	let raw = '';
	try {
		raw = Buffer.from(b64.replace(/%3D/gi, '='), 'base64').toString('utf-8');
	} catch {
		return {};
	}
	const params = new URLSearchParams(raw);
	const pick = (name: string) => params.get(name) ?? undefined;
	return {
		appId: pick('app_id'),
		appName: pick('app_name'),
		bizId: pick('product_id'),
		projectName: pick('product_name'),
	};
}

/** LightAI 登录入口 URL（lightflood 智能编排站；Cookie 为 .aigclsp.com 域级共享）。 */
function entryUrl(): string {
	const base = cfg<string>('floodApiBase', 'https://lightai-lightflood-v1-sd.aigclsp.com').replace(/\/+$/, '');
	return `${base}/flow?lang=zh_CN`;
}

function launchOptions(): {
	headless: boolean;
	channel?: string;
	executablePath?: string;
	args: string[];
} {
	const channel = (cfg<string>('browserChannel', 'chrome') || '').trim();
	const executablePath = (cfg<string>('browserPath', '') || '').trim();
	return {
		headless: false,
		channel: executablePath ? undefined : channel || undefined,
		executablePath: executablePath || undefined,
		// 降低被识别为自动化的概率，避免登录页拦截
		args: ['--disable-blink-features=AutomationControlled'],
	};
}

/**
 * 把会话 Cookie 以「持久型」（带 expires）重新写回 profile。
 *
 * 必要性：若服务端下发的是会话级 Cookie（无过期时间），关闭浏览器后不会落盘，
 * 下次无头启动就读不到，「自动」会退化成每次都要重新登录。这里显式补上过期时间，
 * 保证 profile 中始终留有一份可读的会话。
 *
 * 注意：这只是让浏览器继续携带该 Cookie，并不延长服务端会话的有效期；
 * 服务端过期后 /api/user/check 会失败，届时自动提示重新登录。
 */
async function persistCookies(
	context: BrowserContext,
	sessionId: string,
	openId: string,
): Promise<void> {
	const domain = cfg<string>('cookieDomain', '.aigclsp.com') || '.aigclsp.com';
	const days = cfg<number>('cookiePersistDays', 30);
	const expires = Math.floor(Date.now() / 1000) + Math.max(1, days) * 24 * 3600;
	try {
		await context.addCookies([
			{ name: 'sessionid', value: sessionId, domain, path: '/', expires },
			{ name: 'uid', value: openId, domain, path: '/', expires },
		]);
	} catch (e) {
		console.warn(`${LOG} 持久化 Cookie 失败（不影响本次使用）：${(e as Error).message}`);
	}
}

/** 从上下文 Cookie 中提取 LightAI 会话信息。 */
async function extractFromContext(context: BrowserContext): Promise<{ cookie: string; sessionId: string; openId: string } | undefined> {
	const cookies = await context.cookies();
	const pick = (name: string) =>
		cookies.find((c) => c.name === name && c.value);

	const sid = pick('sessionid');
	const uid = pick('uid');
	if (!sid?.value || !uid?.value) {
		return undefined;
	}
	return {
		cookie: `sessionid=${sid.value}; uid=${uid.value}`,
		sessionId: sid.value,
		openId: uid.value,
	};
}

/**
 * 调用 /api/user/check 解析用户信息（username 即 x-user-id），同时校验 Cookie 是否有效。
 * 该接口返回 { username, sessionid, openid }，因此 userId 可随 Cookie 一并自动获得。
 */
export async function resolveUserId(cookie: string): Promise<{ userId: string; sessionId: string; openId: string }> {
	const apiBase = (cfg<string>('apiBase', 'https://aigclsp.com') || '').replace(/\/+$/, '');
	const origin = cfg<string>('floodApiBase', 'https://lightai-lightflood-v1-sd.aigclsp.com').replace(/\/+$/, '');

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg<number>('timeout', 120000));
	try {
		const resp = await fetch(`${apiBase}/api/user/check`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: '*/*',
				origin,
				referer: `${origin}/`,
				cookie,
			},
			body: JSON.stringify({ perm: '*' }),
			signal: controller.signal,
		});
		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
		}
		const json = JSON.parse(text) as {
			code?: number;
			result?: { username?: string; sessionid?: string; openid?: string };
			message?: string;
		};
		if (json.code !== 0 || !json.result?.username) {
			throw new Error(`接口返回异常：${text.slice(0, 200)}`);
		}
		return {
			userId: json.result.username,
			sessionId: json.result.sessionid ?? '',
			openId: json.result.openid ?? '',
		};
	} finally {
		clearTimeout(timer);
	}
}

async function waitForLogin(
	context: BrowserContext,
	timeoutMs: number,
	onProgress?: (msg: string) => void,
): Promise<{ cookie: string; sessionId: string; openId: string }> {
	const deadline = Date.now() + timeoutMs;
	let lastPrompt = 0;
	while (Date.now() < deadline) {
		const found = await extractFromContext(context);
		if (found) {
			return found;
		}
		const now = Date.now();
		if (onProgress && now - lastPrompt > 5000) {
			lastPrompt = now;
			const left = Math.ceil((deadline - now) / 1000);
			onProgress(`等待登录完成…（剩余 ${left}s）`);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('登录超时，未能在浏览器中检测到 LightAI 会话 Cookie。');
}

/**
 * 自动获取凭据。
 *
 * 流程：
 *   1. 先以无头模式打开持久化 profile —— 若此前已登录，这里直接拿到 Cookie（零交互）
 *   2. 未拿到则改用有头模式重新打开，引导用户完成一次登录，登录成功后自动落盘
 *
 * @param profileDir 持久化用户数据目录（应放在扩展 globalStorage 下，跨重启保留）
 */
export async function fetchCredentials(
	profileDir: string,
	onProgress?: (msg: string) => void,
): Promise<LightAICredentials> {
	const url = entryUrl();
	const opts = launchOptions();
	const timeoutMs = Math.max(30, cfg<number>('loginTimeout', 300)) * 1000;

	const launch = async (headless: boolean) => {
		const context = await chromium.launchPersistentContext(profileDir, {
			...opts,
			headless,
		});
		try {
			const page = context.pages()[0] ?? (await context.newPage());
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
			const found = await waitForLogin(context, headless ? 15000 : timeoutMs, onProgress);
			// 交互式登录后立刻固化为持久型，保证下次无头启动可自动复用
			if (!headless) {
				await persistCookies(context, found.sessionId, found.openId);
			}
			return found;
		} finally {
			await context.close().catch(() => undefined);
		}
	};

	// 1) 无头快路径：profile 中已有有效会话时，无需任何交互
	try {
		onProgress?.('正在读取已保存的登录态…');
		const found = await launch(true);
		console.log(`${LOG} 复用已有会话（无交互）`);
		const info = await resolveUserId(found.cookie);
		return { ...found, userId: info.userId };
	} catch (e) {
		console.log(`${LOG} 无头读取未成功，转为交互式登录：${(e as Error).message}`);
	}

	// 2) 交互式登录：打开浏览器让用户完成 Oasis/QQ 登录，会话写入 profile
	onProgress?.('请在打开的浏览器窗口中完成 LightAI 登录…');
	const found = await launch(false);
	const info = await resolveUserId(found.cookie);
	console.log(`${LOG} 登录成功，已写入 profile`);
	return {
		cookie: found.cookie,
		sessionId: info.sessionId || found.sessionId,
		openId: info.openId || found.openId,
		userId: info.userId,
	};
}
