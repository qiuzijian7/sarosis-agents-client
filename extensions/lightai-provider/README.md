# LightAI Provider（VsSaros 插件）

把腾讯光子内部 **LightAI**（aigclsp.com gemini-chat）接入 VsSaros 聊天，
形态对齐 `codebuddy-provider`：**标准 VS Code 扩展 + `vscode.lm` 接口 + 插件内自带配置**。

## 设计原则：零内核改动
本插件**不修改任何 VsSaros 内核代码**，依靠平台既有扩展点：

| 能力 | 平台机制（已存在，无需改动） |
|---|---|
| 成为聊天模型 Provider | `contributes.languageModelChatProviders`（vendor=`lightai`）；`languageModelsBridge.ts` 自动把 vendor 桥接为 `lm:lightai` |
| 出现在插件列表/详情页 | `contributes.chatPlugins`（指向 `./plugin`） |
| 插件内配置表单 | `contributes.configuration`；`pluginDetailEditorPane.ts::_getPluginConfigProperties` 通用读取并渲染（含保存按钮），**非 CodeBuddy 特例** |
| **插件详情页动作按钮** | 配置属性上声明 `x-action`（命令 id）/ `x-actionLabel`（按钮文案）→ 渲染为真按钮，点击即执行命令、不落盘配置。见下文 |
| 构建自动收录 | `build/lib/extensions.ts` 用 `glob.sync('extensions/*/package.json')` 自动发现 |

## 插件详情页按钮：`x-action` 约定

插件详情页原本没有通用按钮机制（`_renderConfigField` 只支持 string/number/boolean/array），
CodeBuddy 的登录按钮是内核里 `if (plugin.label === 'codebuddy-provider')` 的硬编码特例。

现已把该能力**通用化**（内核一处小改，所有插件受益）：任意插件在自己的
`contributes.configuration.properties` 里给属性加上 `x-action` 即可得到真按钮：

```json
"lightai.loginAction": {
    "type": "boolean",
    "default": false,
    "description": "触发浏览器登录…",
    "x-action": "lightai.login",
    "x-actionLabel": "登录（自动获取 Cookie / User ID）"
}
```

- 点击即 `commandService.executeCommand(x-action)`，**无需「保存设置」**
- 该属性**不写入配置**（不是真正的配置值），保存时被跳过
- 执行期间按钮禁用并显示「执行中…」，失败在配置区状态条提示

配套约定 **`x-readonly`**：声明后该属性以只读文本展示、不渲染输入框、不写回配置，
适合由插件自动维护的派生值。本插件的 `cookie`、`userId`、`appId`、`appName`、`bizId`、
`projectName` 均已标注，避免在详情页被误编辑。

### 迁移现状
- **CodeBuddy** 已迁移：登录 / 登出 / 刷新模型三个按钮改为 `x-action`，
  登录态与用户名改为 `x-readonly`；内核中的 `plugin.label === 'codebuddy-provider'`
  特例分支与 `codebuddyPluginDetailView.ts` 已删除。
- **Knot** 保留特例：其区块是异步状态组件（调 `knot.checkCli` 后动态渲染徽章与
  「安装 / 重新安装」文案），超出声明式约定能力，已在代码注释中说明理由。

## 可用模型自动发现

LightAI **没有**模型列表 API。两类模型走两条不同的发现路径：

| 类型 | 来源接口 | 发现方法 | 写入配置 |
|---|---|---|---|
| **聊天模型** | `/api/gemini/chat/send_message/{id}` | 哨兵模型探测（send_message 对 `model` 字段做枚举校验，非法值时 422 错误体里直接列合法值） | `lightai.models` |
| **图片生成模型** | 前端 JS bundle 硬编码 | 抓首页 → 找 JS bundle → 匹配 Google/Jimeng/OpenAIImage 分组的 children 提取 value | `lightai.imageModels` |

图片生成走独立队列接口（`/banana/accounts_queue/*` 等），无法用哨兵探测；只能从前端硬编码提取。
聊天模型哨兵法实测可拿到 3 个：gemini-3.5-flash / gemini-3.1-pro-preview / gemini-3-flash-preview。
图片模型抓到 4 个：gemini-3.1-flash-image / gemini-3-pro-image / doubao-seedream-5-0-260128 / gpt-image-2。

**登录成功后自动执行**两条发现路径；也可命令 `LightAI: 刷新可用模型` 手动刷新。

> 为什么不解析前端 JS 拿聊天模型：JS bundle 里 gemini_35_flash（下划线）是前端内部标识（用于图标/路由），实测发送会 422，且会混入其它应用的模型（GLM/GPT/Claude/豆包 等，当前应用实际不可用）。

## 图片生成模型如何进入「模型文生图」节点

VsSaros 的图像生成节点按 `provider.models.some(m => m.supportsImageGen)` 过滤。
而 LM bridge（`languageModelsBridge.ts`）原本只推断 `supportsReasoning` / `supportsImages`，
**从不设置 `supportsImageGen`** —— 所以任何通过 `vscode.lm` 注册的 provider 的图片模型都进不了该节点。

已补齐这条链路（内核，通用化）：
1. `languageModelsBridge.ts::listModels()` 用共享的 `inferImageGen()` 推断并输出 `supportsImageGen`，
   与已有的 reasoning/vision 推断保持同一套模式。
2. `llmBridge.ts::inferImageGen()` 关键词表补 `nano[-_]?banana` 与通用 `image`
   （原表只有 `gpt-image` / `hunyuan_image` 等特例，`gemini-*-image` 识别不到）。

扩展侧：`provideLanguageModelChatInformation()` 同时返回聊天模型与图片模型
（VS Code LM API 无法区分二者，只能平铺），由 VsSaros 按 `supportsImageGen` 分流：
- 图像生成节点：只显示 4 个图片模型
- 聊天节点：显示全部（图片模型带 detail 提示「请在模型文生图节点使用」）

误用保护：`resolveModelId()` 检测到请求的是图片模型时回退到聊天模型，
不会把图片模型 id 转给 `send_message`（上游枚举校验会 422）。

> 分类验证（12 个样本）：3 个聊天 + 8 个其它厂商聊天模型全部 false；4 个图片模型全部 true，无误判。

## 目录结构
```
extensions/lightai-provider/
├── package.json            # 扩展清单：vendor / chatPlugins / configuration（lightai.*）
├── plugin/plugin.json      # 插件清单（插件详情页展示）
├── src/extension.ts        # LightAIChatProvider 实现 + 凭据存取/登录编排 + 状态栏
├── src/browserLogin.ts     # Playwright 持久化上下文获取 Cookie + /api/user/check 解析 userId + k 参数解析
├── src/statusView.ts       # 侧边栏面板（登录/登出按钮 + 参数一览）
├── src/vscode-shims.d.ts   # 补齐 LanguageModelThinkingPart 与 Role.System（proposed API）
├── tsconfig.json
└── dist/extension.cjs.js   # esbuild 产物（仅 require("vscode")，共享库已内联）
```

## 构建
```powershell
cd extensions\lightai-provider
node ..\..\node_modules\typescript\bin\tsc -p ./
node ..\..\node_modules\esbuild\bin\esbuild src/extension.ts --bundle --format=cjs `
  --platform=node --external:vscode --outfile=dist/extension.cjs.js --sourcemap
```
或随整体构建：`npm run compile-extensions-build`（会自动发现本扩展）。

## 配置（插件详情页 / 设置搜索 `lightai`）
| 配置项 | 说明 |
|---|---|
| `lightai.endpoint` | LightAI base URL |
| `lightai.cookie` | 登录会话 Cookie（`sessionid=xxx; uid=xxx`），**过期需重填** |
| `lightai.userId` | 企微邮箱（请求头 `x-user-id`） |
| `lightai.appId` / `bizId` / `appName` / `projectName` / `userType` / `company` | 应用与计费上下文 |
| `lightai.models` | 可用模型列表（默认 `gemini-3.5-flash`） |
| `lightai.enableThought` / `enableSearch` | 深度思考 / 联网搜索 |
| `lightai.timeout` / `k` | 超时（ms） / referer 用的 k 参数 |

也可运行命令 **LightAI: 测试连接** 验证 cookie 是否有效。

## 登录按钮（点击才触发）

**浏览器只在点击「登录」时才会启动**，激活插件不会自动拉起浏览器。

登录入口如下（**全部零内核改动**）：

| 入口 | 位置 | 点击次数 |
|---|---|---|
| **插件详情页** | 插件详情 → Configuration → **「登录（自动获取 Cookie / User ID）」按钮** | 1 次 |
| **侧边栏 LightAI 面板** | 资源管理器侧边栏 → `LIGHTAI` 折叠面板，含「登录 / 登出 / 打开设置」按钮与参数一览 | 1 次 |
| **状态栏** | 右下角 `$(sign-in) LightAI: 登录`，点击即登录；登录后显示 `$(check) LightAI: <邮箱>` | 1 次 |
| **命令面板** | `LightAI: 登录（自动获取 Cookie 与 User ID）` / `LightAI: 登出` / `LightAI: 打开状态面板` | 1 次 |

插件详情页的按钮由**内核通用机制 `x-action`** 提供（见下），本插件只需声明，无需内核特例。

点击登录后一次性抓取并写入：
- `cookie`（sessionid + uid，来自浏览器）
- `userId`（`/api/user/check` 返回的 username）
- `appId` / `appName` / `bizId` / `projectName`（从 URL 的 `k` 参数 base64 解析：
  `app_id=137&app_name=智能对话&product_id=73&product_name=萨罗斯GR项目`）

流程：
1. 点击「登录」→ 无头读取已存 profile（有会话则秒完成，不弹窗）
2. 无会话 → 弹出浏览器，完成 Oasis/QQ 登录（**仅需一次**）
3. 自动写入全部参数并刷新面板、状态栏与模型列表

> 若希望在激活时自动登录，可开启 `lightai.autoLoginOnActivate`（默认关闭）。

> `context.cookies()` 通过 CDP 向浏览器自身查询，可合法取得 httpOnly Cookie。
> 会话保存在扩展的 `globalStorage/browser-profile` 目录，跨 VS Code 重启保留。
> 服务端会话过期时会自动提示重新登录。

### 为什么不用「读取浏览器 Cookie 库 + 解密」
新版 Chrome（127+）Cookie 采用 **App-Bound Encryption**（加密值前缀 `v20`），
解密需绕过 Chrome 的应用绑定保护——正是该机制要防御的窃 Cookie 行为，既不稳定也不应实现。
Playwright 方案由我们启动受控浏览器，走官方接口读取，合法且稳定。

### 手动兜底
若自动登录不可用，仍可手动填写（`lightai.cookie` / `lightai.userId`）：
1. 浏览器登录 LightAI
2. F12 → Network → 选中任意 `aigclsp.com` 请求
3. 复制 Request Headers 的 `cookie` 与 `x-user-id`

## 协议要点（抓包确认）
- 建会话：`POST /api/gemini/chat/create_conversation` → `{id}`
- 发消息：`POST /api/gemini/chat/send_message/{id}` → SSE：`{"text","thought"}` … `{"done":true}`
- `thought:true` 的块以 `LanguageModelThinkingPart` 呈现，其余以 `LanguageModelTextPart` 呈现

## 已知限制
- **单轮**：LightAI 的 `send_message` 只接收单条 `text`，历史由服务端按 conversation_id 维护；
  本插件把 system 提示拼在最前 + 最后一条用户消息，保证单轮可用。
- **网络白名单**：LightAI 上游只接受腾讯办公网来源 IP。插件运行在 VsSaros 所在机器，
  因此**本机必须处于办公网**（放 AnyDev 等云主机会返回「没有访问权限」）。
- Cookie 会过期，过期后模型列表为空且不暴露，重填即可恢复。
