// 渠道端口（适配器接口）——插件与平台之间的唯一接缝（重构 2.3）。
//
// 平台适配器（feishu / telegram / loopback / …）实现这个接口；路由层（router.js）
// 只认这个接口，不知道任何平台细节。新平台 = 新适配器文件，路由零改动。
//
// 与 legacy `IBridgePlatform`（agentStudio/common/bridge/bridgeTypes.ts）的关系：
// 字段对齐（sessionKey / platform / messageId / userId / userName / content / replyCtx），
// 但**不 import** legacy 的 TS 类型（插件是纯 JS、独立安装，profile 里没有跨包解析路径）。

/**
 * @typedef {Object} ChannelInboundMessage 入站消息（IM → 插件）
 * @property {string} sessionKey  会话键 `chat:<platform>:<chatId>`（路由层的锚点）
 * @property {string} platform    平台 id（feishu / telegram / loopback / …）
 * @property {string} messageId   平台消息 id（去重/审计）
 * @property {string} userId      发送者 id
 * @property {string} userName    发送者显示名
 * @property {string} content     文本内容
 * @property {unknown} [replyCtx] 平台回包句柄（出站原样回传）
 */

/**
 * @typedef {Object} ChannelReplyCtx 出站句柄
 * @property {string} sessionKey
 * @property {unknown} [replyCtx]
 */

/**
 * @typedef {Object} ChannelAdapter 平台适配器
 * @property {string} id       平台 id
 * @property {string} name     显示名
 * @property {string} allowFrom 允许的用户 id（白名单；空 = 拒绝所有，fail-closed ✓）
 * @property {(handler: (msg: ChannelInboundMessage) => void) => void} start  开始接入站
 * @property {() => void} stop
 * @property {(ctx: ChannelReplyCtx, content: string) => Promise<void>} send  出站（文本）
 */

export const CHANNEL_PORT_VERSION = 1;
