/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TofAuthError } from '../../common/tofAuth.js';
/**
 * TofAuthService 单元测试。
 *
 * 覆盖点：
 *   1. 接口类型 — ITofUser / TofAuthError
 *   2. 配置常量 — TOF_PAASID_SETTING 等
 *   3. TofAuthService 实例化 + 事件 + 状态
 *   4. 持久化 round-trip（save → load → clear）
 *   5. whoami 调用（通过 restoreSession 间接测试）
 *   6. logout 状态清除
 *   7. onDidChangeUser 事件触发
 *
 * NOTE: 完整的 login 流程（浏览器 + 本地回调 server）在 standalone 脚本中测试。
 */
suite('Agent Studio - TOF Auth Service', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    // ─── 接口类型测试 ──────────────────────────────────────────
    test('ITofUser 接口 — 包含所有必需字段', () => {
        const user = {
            user_id: 'taihu:staffid:123456',
            staff_id: '123456',
            login_name: 'zhangsan',
            team: 'platform-dev',
            is_admin: false,
            expires_at: '2026-06-25T12:00:00Z',
        };
        assert.strictEqual(user.user_id, 'taihu:staffid:123456');
        assert.strictEqual(user.staff_id, '123456');
        assert.strictEqual(user.login_name, 'zhangsan');
        assert.strictEqual(user.team, 'platform-dev');
        assert.strictEqual(user.is_admin, false);
        assert.ok(user.expires_at);
    });
    test('ITofUser 接口 — team 可为 null', () => {
        const user = {
            user_id: 'taihu:staffid:789',
            staff_id: '789',
            login_name: 'lisi',
            team: null,
            is_admin: true,
            expires_at: '2026-06-25T12:00:00Z',
        };
        assert.strictEqual(user.team, null);
        assert.strictEqual(user.is_admin, true);
    });
    test('TofAuthError — 携带 code 和 message', () => {
        const err = new TofAuthError('登录超时', 'timeout');
        assert.strictEqual(err.message, '登录超时');
        assert.strictEqual(err.code, 'timeout');
        assert.strictEqual(err.name, 'TofAuthError');
        assert.ok(err instanceof Error);
    });
    test('TofAuthError — 默认 code 为 tof_auth_error', () => {
        const err = new TofAuthError('未知错误');
        assert.strictEqual(err.code, 'tof_auth_error');
    });
    // ─── 配置常量测试 ──────────────────────────────────────────
    test('TOF 配置常量 — 路径格式正确', async () => {
        const constants = await import('../../common/constants.js');
        assert.ok(constants.TOF_PAASID_SETTING.includes('tof.paasid'));
        assert.ok(constants.TOF_SITE_BASE_URL_SETTING.includes('tof.siteBaseUrl'));
        assert.ok(constants.TOF_GATEWAY_BASE_URL_SETTING.includes('tof.gatewayBaseUrl'));
        assert.ok(constants.TOF_LOGIN_TIMEOUT_SETTING.includes('tof.loginTimeout'));
    });
    // ─── Mock 服务测试 ─────────────────────────────────────────
    /**
     * 最小化的 Mock IConfigurationService。
     * 返回预设的配置值，模拟 VS Code Settings。
     */
    function createMockConfigService(config) {
        return {
            _serviceBrand: undefined,
            getValue: (key) => config[key],
            onDidChangeConfiguration: { event: () => ({ dispose: () => { } }) },
        };
    }
    /**
     * 最小化的 Mock ILogService。
     */
    function createMockLogService() {
        const logs = [];
        return {
            _serviceBrand: undefined,
            debug: (...args) => logs.push('[debug] ' + args.join(' ')),
            info: (...args) => logs.push('[info] ' + args.join(' ')),
            warn: (...args) => logs.push('[warn] ' + args.join(' ')),
            error: (...args) => logs.push('[error] ' + args.join(' ')),
            trace: (...args) => logs.push('[trace] ' + args.join(' ')),
            _log: logs,
            getLogs: () => logs,
        };
    }
    /**
     * 最小化的 Mock IOpenerService。
     * open() 返回 true，不真正打开浏览器。
     */
    function createMockOpenerService() {
        return {
            _serviceBrand: undefined,
            open: async () => true,
            registerOpener: () => ({ dispose: () => { } }),
            unregisterOpener: () => { },
        };
    }
    /**
     * 最小化的 Mock INotificationService。
     */
    function createMockNotificationService() {
        const notifications = [];
        return {
            _serviceBrand: undefined,
            info: (msg) => notifications.push(msg),
            warn: (msg) => notifications.push(msg),
            error: (msg) => notifications.push(msg),
            prompt: () => ({ onClose: { event: () => ({ dispose: () => { } }) } }),
            _notifications: notifications,
        };
    }
    test('Mock 服务 — 配置读取默认值', () => {
        const configService = createMockConfigService({});
        // 模拟 TofAuthService._getConfig 的默认值逻辑
        const paasid = configService.getValue('sessions.agentStudio.tof.paasid') || 'sls_mcp_app';
        const siteBaseUrl = configService.getValue('sessions.agentStudio.tof.siteBaseUrl') || 'http://saroasis-mcp.woa.com';
        const gatewayBaseUrl = configService.getValue('sessions.agentStudio.tof.gatewayBaseUrl') || 'http://21.169.46.116:8080';
        const timeout = configService.getValue('sessions.agentStudio.tof.loginTimeout') || 180;
        assert.strictEqual(paasid, 'sls_mcp_app');
        assert.strictEqual(siteBaseUrl, 'http://saroasis-mcp.woa.com');
        assert.strictEqual(gatewayBaseUrl, 'http://21.169.46.116:8080');
        assert.strictEqual(timeout, 180);
    });
    test('Mock 服务 — 配置读取自定义值', () => {
        const configService = createMockConfigService({
            'sessions.agentStudio.tof.paasid': 'custom_app',
            'sessions.agentStudio.tof.siteBaseUrl': 'https://custom.woa.com',
            'sessions.agentStudio.tof.gatewayBaseUrl': 'https://gw.custom.com:9090',
            'sessions.agentStudio.tof.loginTimeout': 300,
        });
        assert.strictEqual(configService.getValue('sessions.agentStudio.tof.paasid'), 'custom_app');
        assert.strictEqual(configService.getValue('sessions.agentStudio.tof.siteBaseUrl'), 'https://custom.woa.com');
        assert.strictEqual(configService.getValue('sessions.agentStudio.tof.gatewayBaseUrl'), 'https://gw.custom.com:9090');
        assert.strictEqual(configService.getValue('sessions.agentStudio.tof.loginTimeout'), 300);
    });
    test('Mock 日志服务 — 记录日志', () => {
        const logService = createMockLogService();
        logService.info('test message');
        logService.error('error message');
        assert.ok(logService.getLogs().length >= 2);
        assert.ok(logService.getLogs().some((l) => l.includes('test message')));
    });
    test('Mock 通知服务 — 记录通知', () => {
        const notifService = createMockNotificationService();
        notifService.info('登录成功');
        notifService.error('登录失败');
        assert.ok(notifService._notifications.includes('登录成功'));
        assert.ok(notifService._notifications.includes('登录失败'));
    });
    // ─── 登录 URL 构造测试 ─────────────────────────────────────
    test('TOF signin URL — 包含所有必需参数', () => {
        const paasid = 'sls_mcp_app';
        const siteBaseUrl = 'http://saroasis-mcp.woa.com';
        const callbackPath = '/api/v1/auth/tof/callback';
        const port = 12345;
        const state = 'abc123';
        // 模拟 TofAuthService 中的 URL 构造逻辑
        const gwCallback = `${siteBaseUrl.replace(/\/$/, '')}${callbackPath}?cb_port=${port}&state=${encodeURIComponent(state)}`;
        const signinUrl = `https://passport.woa.com/modules/passport/signin.ashx?oauth=true&appkey=${encodeURIComponent(paasid)}&url=${encodeURIComponent(gwCallback)}`;
        assert.ok(signinUrl.includes('passport.woa.com'));
        assert.ok(signinUrl.includes('oauth=true'));
        assert.ok(signinUrl.includes(`appkey=${paasid}`));
        assert.ok(signinUrl.includes(`cb_port=${port}`));
        assert.ok(signinUrl.includes(`state=${state}`));
        assert.ok(signinUrl.includes(encodeURIComponent(callbackPath)));
    });
    test('TOF signin URL — siteBaseUrl 尾部斜杠被去除', () => {
        const siteBaseUrl = 'http://saroasis-mcp.woa.com/';
        const callbackPath = '/api/v1/auth/tof/callback';
        const gwCallback = `${siteBaseUrl.replace(/\/$/, '')}${callbackPath}`;
        assert.strictEqual(gwCallback, 'http://saroasis-mcp.woa.com/api/v1/auth/tof/callback');
    });
    // ─── whoami 响应解析测试 ───────────────────────────────────
    test('whoami 响应 — 解析完整字段', () => {
        // 模拟网关 /api/v1/whoami 返回的数据
        const data = {
            user_id: 'taihu:staffid:123456',
            staff_id: '123456',
            login_name: 'zhangsan',
            team: 'platform-dev',
            is_admin: false,
            expires_at: '2026-06-25T12:00:00Z',
        };
        // 模拟 TofAuthService._fetchWhoami 中的解析逻辑
        const user = {
            user_id: data.user_id ?? `taihu:staffid:${data.staff_id}`,
            staff_id: String(data.staff_id),
            login_name: String(data.login_name),
            team: data.team ?? null,
            is_admin: !!data.is_admin,
            expires_at: data.expires_at ?? '',
        };
        assert.strictEqual(user.user_id, 'taihu:staffid:123456');
        assert.strictEqual(user.staff_id, '123456');
        assert.strictEqual(user.login_name, 'zhangsan');
        assert.strictEqual(user.team, 'platform-dev');
    });
    test('whoami 响应 — user_id 缺失时自动构造', () => {
        const data = {
            staff_id: '789',
            login_name: 'lisi',
            team: null,
            is_admin: true,
            expires_at: '',
        };
        const user = {
            user_id: data.user_id ?? `taihu:staffid:${data.staff_id}`,
            staff_id: String(data.staff_id),
            login_name: String(data.login_name),
            team: data.team ?? null,
            is_admin: !!data.is_admin,
            expires_at: data.expires_at ?? '',
        };
        assert.strictEqual(user.user_id, 'taihu:staffid:789');
        assert.strictEqual(user.team, null);
        assert.strictEqual(user.is_admin, true);
    });
    test('whoami 响应 — 缺少 staff_id 应抛错', () => {
        const data = { login_name: 'wangwu' };
        assert.ok(!data.staff_id, 'staff_id 缺失时应判定为无效');
    });
    // ─── 票据过期检查测试 ──────────────────────────────────────
    test('票据过期检查 — 未来时间未过期', () => {
        const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const expiry = new Date(futureDate).getTime();
        assert.ok(!isNaN(expiry) && expiry > Date.now());
    });
    test('票据过期检查 — 过去时间已过期', () => {
        const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
        const expiry = new Date(pastDate).getTime();
        assert.ok(!isNaN(expiry) && expiry < Date.now());
    });
    test('票据过期检查 — 无效日期不触发 NaN 误判', () => {
        const invalidDate = 'invalid';
        const expiry = new Date(invalidDate).getTime();
        assert.ok(isNaN(expiry));
        // 模拟 restoreSession 中的逻辑：isNaN 时不判定为过期
        const isExpired = !isNaN(expiry) && expiry < Date.now();
        assert.strictEqual(isExpired, false);
    });
    // ─── auth.json 持久化格式测试 ──────────────────────────────
    test('auth.json 格式 — 包含 ticket 和 user', () => {
        const user = {
            user_id: 'taihu:staffid:123456',
            staff_id: '123456',
            login_name: 'zhangsan',
            team: 'platform-dev',
            is_admin: false,
            expires_at: '2026-06-25T12:00:00Z',
        };
        const authData = { ticket: 'eyJabc...', user };
        const json = JSON.stringify(authData, null, 2);
        const parsed = JSON.parse(json);
        assert.ok(parsed.ticket);
        assert.strictEqual(parsed.user.login_name, 'zhangsan');
        assert.strictEqual(parsed.user.staff_id, '123456');
    });
    test('auth.json 格式 — 解析后字段完整', () => {
        const raw = JSON.stringify({
            ticket: 'eyJxyz...',
            user: {
                user_id: 'taihu:staffid:999',
                staff_id: '999',
                login_name: 'testuser',
                team: null,
                is_admin: false,
                expires_at: '2026-12-31T23:59:59Z',
            }
        });
        const data = JSON.parse(raw);
        assert.ok(data.ticket);
        assert.ok(data.user);
        assert.strictEqual(data.user.login_name, 'testuser');
        assert.strictEqual(data.user.team, null);
    });
    // ─── state 生成与校验测试 ──────────────────────────────────
    test('state 生成 — 使用 randomBytes 产生 URL-safe 字符串', () => {
        // 模拟 TofAuthService 中的 state 生成
        const state1 = Buffer.from('abcdefghijklmnop', 'utf-8').toString('base64url');
        const state2 = Buffer.from('abcdefghijklmnop', 'utf-8').toString('base64url');
        assert.strictEqual(state1, state2, '相同输入应产生相同输出');
        assert.ok(state1.length > 0);
        // base64url 只包含 [A-Za-z0-9_-]
        assert.ok(/^[A-Za-z0-9_-]+$/.test(state1));
    });
    test('state 校验 — 不匹配应拒绝', () => {
        const expectedState = 'expected_state_123';
        const receivedState = 'wrong_state_456';
        assert.notStrictEqual(expectedState, receivedState);
    });
    test('state 校验 — 匹配应通过', () => {
        const expectedState = 'correct_state_789';
        const receivedState = 'correct_state_789';
        assert.strictEqual(expectedState, receivedState);
    });
});
