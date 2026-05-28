CodeBuddy · OAuth 鉴权与模型调用逆向报告(权威版)
所有声明带 bundle 行号 + 原文引用。 版本:@tencent-ai/codebuddy-code v2.92.0(dist/codebuddy.js,15MB,esbuild bundle,变量名 mangled 但字符串字面量完整保留) 逆向时间:2026-04-20

核心结论
CodeBuddy 不是 CC 的外壳——它是独立产品:

自研 Harness(celljs/express + genie 自研框架),不依赖原版 CC
模型调用协议 = OpenAI Chat Completions API(不是 Anthropic Messages API)
认证类型 = cli-external-link——浏览器登录 + 轮询换 token,不是标准 OAuth redirect callback
支持跨多种部署场景:SaaS(copilot.tencent.com)、iOA(tencent.sso.*)、自托管、云托管、企业版
同一个 gateway 按 modelId 路由到 Claude / GPT / Gemini / GLM / DeepSeek 全家桶
1 · Endpoint 总览(实测)
主 endpoint(来自 product.json 等 product.*.json 配置文件)
{
  "endpoint":         "https://copilot.tencent.com",
  "stagingEndpoint":  "https://staging-copilot.tencent.com",
  "officialEndpoints": [
    "https://copilot.tencent.com",
    "https://staging-copilot.tencent.com",
    "https://www.codebuddy.ai",
    "https://staging-codebuddy.tencent.com"
  ]
}
Auth 配置(内嵌在 product.json.authentication,经 gzip 后存 ~/.codebuddy/local_storage/entry_604f...info)
"authentication": {
  "id":    "Tencent-Cloud.coding-copilot",
  "type":  "cli-external-link",
  "label": "TencentCloud",
  "attributes": {
    "usernameHeader":  "X-User-Id",
    "usernameEncode":  "URLEncode",
    "tokenHeader":     "Authorization",
    "tokenType":       "bearerToken",
    "prefixPath":      "/plugin",
    "startChatAfterCompleted": true,
    "internalDomain":    ["copilot.tencent.com", "staging-copilot.tencent.com",
                           "www.codebuddy.cn", "staging.codebuddy.cn"],
    "externalDomain":    ["www.codebuddy.ai", "staging-codebuddy.tencent.com"],
    "iOADomain":         ["tencent.sso.copilot.tencent.com", ...],
    "cloudHostedDomain": ["*.sso.copilot.tencent.com", "*.copilot.qq.com", ...]
  }
}
AuthenticationType 枚举(L1646 @55619)
ei.EXTERNAL_LINK     = "external-link"
ei.EXTERNAL_LINK_V2  = "external-link-v2"
ei.IDE_HOST          = "ide-host"
ei.CUSTOM_HOSTNAME   = "custom-hostname"
ei.CLI_EXTERNAL_LINK = "cli-external-link"    // ← 我们用的是这个
2 · OAuth 流程(cli-external-link)
核心思路
不是 redirect callback,是 CLI 轮询换 token:

CLI 向服务端申请一个 state(临时会话)→ 服务端返回 authUrl
CLI 用 open 打开浏览器,用户登录
浏览器登录完成,服务端将 token 绑定到 state
CLI 轮询 /auth/token?state=... 直到拿到 {accessToken, refreshToken, expiresAt}
OAuth endpoint 清单(都在 prefixPath = "/plugin" 下)
用途	HTTP	URL
申请 state / 获取 authUrl	POST	https://copilot.tencent.com/v2/plugin/auth/state?platform=<platform>
轮询换 token	GET	https://copilot.tencent.com/v2/plugin/auth/token?state=<state>
Token 刷新	POST	https://copilot.tencent.com/v2/plugin/auth/token/refresh
微信扫码换 token	POST	https://copilot.tencent.com/v2/auth/token/wxide?tmpCode=...
切换企业账号	POST	https://copilot.tencent.com/v2/plugin/login/enterprise/<enterpriseId>
获取账号列表	GET	https://copilot.tencent.com/v2/plugin/accounts
当前账号	GET	https://copilot.tencent.com/v2/plugin/login/account?state=...
证据逐条对应
申请 state(L139 @33844,L1608 @39606)

({data:{data:ec}} = await this.restOperations.post(
  `/v2${el}/auth/state?platform=${ea}`, {},
  {headers: {"X-No-Authorization":"true", "X-No-User-Id":"true",
             "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true"}}
))
if (ec?.authUrl) { ... }    // ← 服务端返回 authUrl,CLI 打开
轮询换 token(L1608 @45820)

({data:{data:ea}} = await this.restOperations.get(
  `/v2${this.prefixPath}/auth/token?state=${ei.state}`, {
    signal: el.abortController.signal,
    headers: {...el.traceSpan.requestHeaders,
              [HTTP_HEADER_NO_AUTHORIZATION]:"true", ...}
  }))
Token 刷新(L1608 @42197)

({data:{data:el}} = await this.restOperations.post(
  `/v2${this.prefixPath}/auth/token/refresh`, {},
  {headers: {...this.enterpriseHeaders(ei.auth),
             "X-Refresh-Token":     ei.auth.refreshToken,
             "X-Auth-Refresh-Source":"plugin",
             ...ea.traceSpan.requestHeaders}}
))
注意:refreshToken 通过 X-Refresh-Token 头传,body 为空(非标准 OAuth);而且 X-Auth-Refresh-Source: plugin 必带。

3 · 模型调用协议:OpenAI Chat Completions API
证据(L461 @~28000-34000,同一个 function body)
let ed = env[CODEBUDDY_BASE_URL] || settings.env[CODEBUDDY_BASE_URL]
let ep = auth.accessToken
let ef = await productManager.waitConfiguration()     // 拉取 product.*.json
let eh = ef.models?.find(m => m.id === modelId)

if (eh?.url)         ed = eh.url                      // 1. 优先用 model 自带 url
else if (!ed)        ed = ef.endpoint + "/v2"          // 2. 默认 = productConfig.endpoint + /v2
if (eh?.apiKey)      ep = eh.apiKey                    // 覆盖 apiKey

// 创建 OpenAI 客户端
let client = new OpenAI({
  baseURL: ed,
  apiKey:  ep,
  fetch:   this.axiosToFetchAdapter()
})
return new OpenAIChatCompletionsModel(client, modelId)
ensureChatCompletionsEndpoint(L461 @18672)
ensureChatCompletionsEndpoint(ei) {
  let ea = ei.replace(/\/+$/, "")
  return ea.endsWith("/chat/completions") ? ea : `${ea}/chat/completions`
}
createClient(L461 @31437)
createClient(ei, ea) {
  if (!ea) throw new eB.AuthenticationRequiredError
  return new ex.OpenAI({
    baseURL: ei,
    apiKey:  ea,
    fetch:   this.axiosToFetchAdapter()
  })
}
最终调用 URL
POST https://copilot.tencent.com/v2/chat/completions
不是 agent 幻觉的 /plugin/v1/messages。grep /plugin/v1、/plugin/chat 均零命中。

Body(标准 OpenAI Chat Completions)
{
  "model":       "glm-5.1-ioa",
  "messages":    [...],
  "stream":      true,
  "temperature": 1,
  "max_tokens":  48000,
  "reasoning_summary": "auto"   // 仅当 model.supportsReasoning && settings.alwaysThinkingEnabled
}
parseSSEChunk() 明确解析 OpenAI SSE(choices[].delta.content、finish_reason、reasoning_content、tool_calls)(L461 @18701)。

4 · 请求头构造(axiosToFetchAdapter,L461 @~25000)
// 总是设置
headers[CONVERSATION_ID_HEADER]         = session.id                         // x-conversation-id
headers[CONVERSATION_REQUEST_ID_HEADER] = session.conversationRequestId
headers[CONVERSATION_MESSAGE_ID_HEADER] = session.messageId                  // uuid
headers[REQUEST_ID_HEADER]              = session.messageId                  // x-request-id
headers[AGENT_INTENT]                   = "craft"
headers[IDE_TYPE_HEADER]                = ideType || "CodeBuddy"
headers[IDE_NAME_HEADER]                = platform
headers[IDE_VERSION_HEADER]             = platformVersion || "0.0.0"

// auth (L461 @~29500, L145 @3350)
if (env.CODEBUDDY_API_KEY_DISABLED != set) {
  let apiKey = settings.env[CODEBUDDY_API_KEY] || env[CODEBUDDY_API_KEY] ||
               model.apiKey || session.auth.accessToken
  headers[API_KEY_HEADER]       = apiKey                      // X-API-Key
  headers[HttpHeaders.AUTHORIZATION] = `Bearer ${apiKey}`
}
await IOAUtils.applyIOADefaultHeaders(headers, settings)      // iOA 场景附加

// 企业版还有(L1608 @~23000)
headers[HTTP_HEADER_USER_ID]         = account.uid             // X-User-Id
headers[HTTP_HEADER_ENTERPRISE_ID]   = account.enterpriseId    // X-Enterprise-Id
headers[HTTP_HEADER_DEPARTMENT_INFO] = account.departmentFullName  // X-Department-Info
headers[HTTP_HEADER_TENANT_ID]       = enterpriseId            // X-Tenant-Id
headers[HTTP_HEADER_DOMAIN]          = URI.parse(endpoint).authority
Header 常量索引(L1608 @89181 / L1608 @29768)
X-User-Id           X-Enterprise-Id      X-Department-Info
X-Tenant-Id         X-Domain              X-Refresh-Token
X-IDE-Name          X-IDE-Version         X-API-Key
X-Product-Version   X-Model-ID            X-Request-Id
X-Conversation-Id   X-Conversation-Request-Id
X-Conversation-Message-Id
5 · Token 存储
核心路径(L1461 @90867)
getHomeDir() {
  let ei = process.env.CODEBUDDY_CONFIG_DIR
  return ei && ei.trim() !== ""
    ? ei
    : path.join(homedir(), ".codebuddy")
}
→ 默认 ~/.codebuddy,可通过 CODEBUDDY_CONFIG_DIR 覆盖。

FileAuthenticationStorage(L139 @14158 / L139 @15518)
class FileAuthenticationStorage {
  initialize() { this.initializeWatcher() }
  async priority() { return AuthenticationStoragePriority.Normal }
  async store(ei) {
    let ea = await this.getAuthSavePath()
    let el = dirname(ea)
    if (!existsSync(el)) mkdirSync(el, {recursive: true})
    // ... 序列化 session 并写入
  }
}
local_storage entry 命名(L635 @9483)
let eI = "local_storage"
let eR = "entry_"
let ex = ".info"
→ 文件路径:~/.codebuddy/local_storage/entry_<sha256_short>.info

实测文件内容(本机 ~/.codebuddy/local_storage/)
entry_3bab4ce6...info (5 字节)    → "iOA"                                认证模式标识
entry_933d5543...info (29 字节)   → "https://copilot.tencent.com"         当前 endpoint
entry_d43e9699...info (103 字节)  → [{"userId":"...","data":{"__modelType":"default"}}]
entry_577d7335...info (124 字节)  → {"<random-key>":{"timestamp":...,"value":{},"creator":"<uuid>"}}
entry_604f48c9...info (97KB)      → gzip+base64,解压后 251KB,内容是完整的 product config + session(含 token)
解压 entry_604f48c9 方法
node -e "
const fs=require('fs'),zlib=require('zlib');
const s=JSON.parse(fs.readFileSync('entry_604f48c944053e01d9546675443286c1.info','utf8'));
console.log(zlib.gunzipSync(Buffer.from(s,'base64')).toString())"
解压后包含:

$schema, productName, productConfigPathEnv, productConfigEnv
完整 authentication.attributes(含上面列出的 prefixPath / tokenHeader / domains)
models 全量列表(所有 -ioa 模型)
commitMessage, config, links, completion 等配置
注意:当前本机这个 entry 里 accessToken: "" 是空的(用户未用 Bearer 登录而是走 iOA)——iOA 场景下 token 可能走其他存储路径(待验证)。

6 · 认证优先级(L139 @34531-34950)
getAuthSourceInfo() 按顺序查找 token 来源:

1. process.env.CODEBUDDY_AUTH_TOKEN          → {type:"env",          source:"CODEBUDDY_AUTH_TOKEN"}
2. settings.apiKeyHelper (可执行命令)         → {type:"apiKeyHelper", source:<cmd>}
3. process.env.CODEBUDDY_API_KEY             → {type:"env",          source:"CODEBUDDY_API_KEY"}
4. session.account.nickname (登录)           → {type:"login",        nickname, enterpriseName}
5. 否则                                       → {type:"none"}
apiKeyHelper(L481 @13630)
Settings 里可以配置 apiKeyHelper(可执行命令),每 300 秒(默认)执行一次拿回 token:

async executeHelperScript() {
  let ei = await this.settingsManager.get("apiKeyHelper")
  if (!ei || typeof ei !== "string") return null
  let ea = PathUtils.resolveFilePathToWorkDir(ei)
  let ec = await this.shellService.execute({command: ea, ...})
  return ec.stdout.trim()
}
TTL 由 CODEBUDDY_CODE_API_KEY_HELPER_TTL_MS 控制(默认 300000ms)。

ENV 变量总览(L682 @34429,L346)
CODEBUDDY_AUTH_TOKEN                  // Bearer token
CODEBUDDY_API_KEY                     // API key
CODEBUDDY_API_KEY_DISABLED            // 关闭 API key 模式
CODEBUDDY_BASE_URL                    // 覆盖 endpoint
CODEBUDDY_CONFIG_DIR                  // 覆盖 ~/.codebuddy
CODEBUDDY_CUSTOM_HEADERS              // 附加自定义 header(换行分隔)
CODEBUDDY_SKIP_INTERNAL_HEADERS       // 删除内部 header
CODEBUDDY_CODE_API_KEY_HELPER_TTL_MS  // apiKeyHelper 缓存 TTL
CODEBUDDY_MODEL                       // 默认模型 id
CODEBUDDY_SMALL_FAST_MODEL            // lite 模型
CODEBUDDY_BIG_SLOW_MODEL              // reasoning 模型
CODEBUDDY_CODE_SUBAGENT_MODEL         // 子 agent 模型
CODEBUDDY_INTERNET_ENVIRONMENT        // 网络环境标识
CODEBUDDY_DISABLE_INPROCESS_TEAMMATES // 禁用进程内 Teammates
CODEBUDDY_CODE_SUBAGENT_MODEL         // subagent 模型
MAX_THINKING_TOKENS                   // reasoning 模型最大 thinking token
CODEBUDDY_DEBUG_REQUEST               // 打印请求 body
CODEBUDDY_STREAM_TIMEOUT_MS           // 流超时(默认 600000)
CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS      // 首 token 超时(默认 600000)
7 · 多部署场景(域判断,认证类型分 4 种)
"internalDomain":    [copilot.tencent.com,  www.codebuddy.cn, ...]      // 腾讯内网 SaaS
"externalDomain":    [www.codebuddy.ai,     staging-codebuddy.tencent.com]  // 公网用户
"iOADomain":         [tencent.sso.copilot.tencent.com, ...]             // 腾讯 iOA SSO
"cloudHostedDomain": [*.sso.copilot.tencent.com, *.copilot.qq.com, ...] // 私有云部署
CodeBuddy 在启动时根据当前 endpoint 匹配所属场景,走不同的认证流程:

internal / external → 浏览器 login
iOA → 企业 SSO(tencent.sso.*)
cloudHosted → 私有云专属认证
本机实测 entry_3bab4ce6...info = "iOA",说明当前是 iOA 模式。

8 · 关键函数位置索引
功能	Bundle 位置
ModelProviderImpl.getModel(模型调用入口)	L461 @31437
createClient(new OpenAI)	L461 @31437
ensureChatCompletionsEndpoint	L461 @18672
parseSSEChunk(OpenAI SSE 解析)	L461 @18701
axiosToFetchAdapter(header 注入)	L461 @~22500
OAuth getAuthUrl / fetchToken	L1608 @39606, L1608 @45820
OAuth refresh token	L1608 @42197,L1608 @56913
FileAuthenticationStorage	L139 @14158-15518
CliCustomTokenAuthenticationStorageImpl	L139 @28606-29315
getAuthSourceInfo	L139 @34531-34950
apiKeyHelper 执行	L481 @13630
local_storage entry 命名	L635 @9483
PathUtils.getHomeDir	L1461 @90867
ACC_PRODUCT_CONFIG_V3/V2 读取	L139 @15334-28670
Authentication type 枚举	L1646 @55619
prefixPath 属性	L1608 @49127
9 · MCP OAuth(与 CodeBuddy 自身 auth 无关,但同文件出现)
L381 @4710-13959 是 MCP client 连接 MCP Server 时的 OAuth(走标准 RFC8252 + PKCE,有 code_verifier / code_challenge)。这不是 CodeBuddy 登录腾讯 copilot 用的,不要混淆。

10 · SST 复用路径
方案 A:直接复用 CodeBuddy 登录态(需解压 entry_604f...info)
import { gunzipSync } from "zlib"
import { readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const ls = join(homedir(), ".codebuddy", "local_storage")
let token: string | null = null
for (const f of readdirSync(ls)) {
  try {
    const s = JSON.parse(readFileSync(join(ls, f), "utf8"))
    if (typeof s === "string" && s.startsWith("H4sI")) {   // gzip base64
      const data = JSON.parse(gunzipSync(Buffer.from(s, "base64")).toString())
      if (data?.session?.auth?.accessToken) {
        token = data.session.auth.accessToken
        break
      }
    }
  } catch {}
}

if (!token) throw new Error("请先用 `codebuddy /login`")

const resp = await fetch("https://copilot.tencent.com/v2/chat/completions", {
  method: "POST",
  headers: {
    "Authorization":    `Bearer ${token}`,
    "X-API-Key":        token,
    "X-Agent-Intent":   "craft",
    "X-IDE-Type":       "SST",
    "X-IDE-Name":       "sst-cli",
    "X-IDE-Version":    "0.0.1",
    "X-Conversation-Id": crypto.randomUUID(),
    "X-Request-Id":      crypto.randomUUID(),
    "Content-Type":     "application/json"
  },
  body: JSON.stringify({
    model:    "glm-5.1-ioa",
    messages: [...],
    stream:   true
  })
})
注意:iOA 模式下 accessToken 可能不在这个 entry 里,需要真机验证(当前本机 entry 里是空的)。

方案 B:独立实现 cli-external-link 流程
POST https://copilot.tencent.com/v2/plugin/auth/state?platform=<SST> → {state, authUrl}
open(authUrl) 让用户浏览器登录
轮询 GET /v2/plugin/auth/token?state=<state> 直到返回 {accessToken, refreshToken, expiresAt}
保存到 SST 自己的 ~/.sst/credentials.json
快过期时调用 POST /v2/plugin/auth/token/refresh,header X-Refresh-Token: <token>、X-Auth-Refresh-Source: plugin
当前阻塞:state 请求需要带一个 platform query 参数,目前只确认了 platform 是从 product.platform 或 authentication.attributes.platform 读的,具体合法值还没定位到(可能是 CLI 或 codebuddy-code,待实测)。

附录 · 模型清单(product.internal.json 全家桶)
# Anthropic
claude-sonnet-4.6 / 4.6-1m,   claude-4.5,   claude-haiku-4.5,
claude-opus-4.7 / 4.7-1m,     claude-opus-4.6 / 4.6-1m,   claude-opus-4.5

# OpenAI
gpt-5.4,  gpt-5.3-codex,  gpt-5.2 / 5.2-codex,
gpt-5.1 / 5.1-codex / 5.1-codex-max / 5.1-codex-mini

# Google
gemini-3.1-pro,  gemini-3.0-flash,  gemini-2.5-pro,  gemini-3.1-flash-lite

# 国产(-ioa 后缀走内部免费额度)
glm-5.1-ioa, glm-5.0-ioa, glm-5.0-turbo-ioa, glm-5v-turbo-ioa,
glm-4.6-ioa, glm-4.6v-ioa, glm-4.7-ioa,
deepseek-v3-2-volc-ioa,
minimax-m2.5-ioa, minimax-m2.7-ioa,
kimi-k2.5-ioa, kimi-k2-thinking,
hunyuan-2.0-thinking-ioa, hunyuan-chat,
hunyuan-image-v3.0-ioa, hunyuan-image-v2.0-general-edit-ioa
→ 这就是 SST 可以调用的全部模型池子。credit 价格从 x0.00(内部免费)到 x3.33(Claude Opus)不等。
