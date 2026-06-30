# Agent ConfigHTML 打包上传测试用例

## 测试目标

验证 Agent 上传/下载时，ConfigHTML（MD 源文件 + 渲染 HTML + 样式）能正确打包、传输、安装。

## 测试环境

- 客户端: VsSarosis (sarosis-agents-client)
- 服务端: saros-marketplace (http://21.6.92.5:3040)
- 测试 Agent: `coder` (有 configMd 配置)

---

## TC-01: 打包含 ConfigHTML 的 Agent（preparePack）

**前置**: Agent `coder` 已配置 `configMd.mdPath = "config.md"`

**步骤**:
1. 调用 `agentInstaller.preparePack('coder')`
2. 检查临时目录内容

**预期**:
```
tmpDir/
├── manifest.json     # files 包含 html/index.html, config/config.md
├── agent.json        # files.html 字段存在
├── AGENTS.md         # (如已有)
├── config/
│   └── config.md     # MD 源文件
└── html/
    ├── index.html     # 渲染后的 HTML
    └── styles.css     # (如有自定义样式)
```

**验证 manifest.json**:
- `files` 数组包含 `config/config.md` 和 `html/index.html`
- `htmlFiles.entry = "html/index.html"`
- `htmlFiles.assets` 包含其他 html 文件

---

## TC-02: 上传含 HTML 的 Agent 包到服务端

**前置**: TC-01 通过，服务端可达

**步骤**:
1. 调用 `marketplaceService.publish('coder', 'agent', { version: '1.1.0' })`
2. 检查服务端响应

**预期**:
- HTTP 201 Created
- 返回 `{ version: "1.1.0", sha256: "...", size: ... }`
- 服务端 `data/assets/agent/{packageId}/1.1.0/package.tar.gz` 存在
- 服务端 DB `package_versions.manifest` 包含 `htmlFiles` 字段

---

## TC-03: 下载含 HTML 的 Agent 包

**前置**: TC-02 完成

**步骤**:
1. 调用 `marketplaceService.download('agent-coder', '1.1.0', 'agent')`

**预期**:
- 下载成功
- 解压后包含 `html/` 目录和 `config/` 目录
- `manifest.json` 中 `htmlFiles` 字段完整

---

## TC-04: 安装含 HTML 的 Agent 包（install）

**前置**: TC-03 通过

**步骤**:
1. AgentInstaller.install() 执行
2. 检查本地安装目录

**预期**:
- `~/.saros/agents/html/agent-coder/` 目录存在
- `~/.saros/agents/html/agent-coder/index.html` 文件存在
- `~/.saros/agents/html/agent-coder/styles.css` 文件存在（如有）
- Agent 定义中 `configMd.htmlInstallDir` 指向安装目录
- Agent 定义中 `configMd.htmlPath` = "index.html"

---

## TC-05: 无 ConfigHTML 的 Agent 打包（兼容性）

**前置**: Agent `tester` 无 configMd 配置

**步骤**:
1. 调用 `agentInstaller.preparePack('tester')`

**预期**:
- manifest.json 中无 `htmlFiles` 字段
- 临时目录无 `html/` 和 `config/` 目录
- 其余行为与之前一致（向后兼容）

---

## TC-06: 安装无 HTML 的旧版本 Agent（兼容性）

**前置**: 下载不含 `htmlFiles` 的旧版本包

**步骤**:
1. AgentInstaller.install() 执行

**预期**:
- 不创建 HTML 安装目录
- Agent 定义中 `configMd.htmlInstallDir` 为 undefined
- 不报错（向后兼容）

---

## TC-07: 升级含 HTML 的 Agent

**前置**: 已安装 v1.0.0（无 HTML），服务端有 v1.1.0（含 HTML）

**步骤**:
1. 调用 `marketplaceService.download('agent-coder', '1.1.0', 'agent')`

**预期**:
- 安装成功
- `~/.saros/agents/html/agent-coder/` 目录被创建
- Agent 定义中 `configMd.htmlInstallDir` 被更新
- 旧版本数据被覆盖（如有）

---

## TC-08: 卸载含 HTML 的 Agent

**前置**: 已安装含 HTML 的 Agent

**步骤**:
1. 调用 `marketplaceService.uninstall('agent-coder', 'agent')`

**预期**:
- `~/.saros/agents/html/agent-coder/` 目录被删除
- Agent 定义从 custom-agents.json 移除
- installed-packages.json 记录被清除

---

## TC-09: HTML 文件含中文/特殊字符

**前置**: Agent 的 config.md 含中文内容

**步骤**:
1. 打包 → 上传 → 下载 → 安装

**预期**:
- 所有环节中文不乱码
- HTML 文件内容完整

---

## TC-10: HTML 文件含子目录结构

**前置**: Agent 的 html 目录结构为:
```
html/
├── index.html
├── assets/
│   ├── logo.png
│   └── dashboard.png
└── styles/
    └── main.css
```

**步骤**:
1. 打包 → 上传 → 下载 → 安装

**预期**:
- 子目录结构保持完整
- 所有文件正确复制到安装目录
