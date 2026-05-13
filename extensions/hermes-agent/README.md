# Hermes Agent Extension for Sarosis

> Autonomous AI agent plugin with 28+ model providers, 70+ tools, memory, planning and execution capabilities.

## Architecture

```
extensions/hermes-agent/
├── package.json                    # Extension manifest (agentCapabilities + chatPlugins)
├── plugin/                         # Chat Plugin declarations
│   ├── plugin.json                 # Plugin metadata
│   ├── agents/hermes-agent.md      # Agent persona & capabilities
│   ├── commands/hermes-chat.md     # Chat command definition
│   ├── instructions/hermes-rules.instructions.md  # Behavior rules
│   └── skills/hermes-agent/SKILL.md  # Skill description
├── src/                            # TypeScript source
│   ├── extension.ts                # IAgentCapabilityPlugin (4 capabilities)
│   ├── hermesBridge.ts             # JSON-RPC bridge to Python process
│   ├── hermesModelProvider.ts      # IModelProvider (28+ providers)
│   ├── hermesExecutionProvider.ts  # IExecutionProvider (AIAgent loop)
│   ├── hermesToolProvider.ts       # IToolProvider (70+ tools)
│   ├── hermesMemoryProvider.ts     # IMemoryProvider (built-in + 9 plugins)
│   ├── hermesSettingsEditorInput.ts
│   ├── hermesSettingsEditorPane.ts # Full settings UI
│   ├── hermes_bridge_server.py     # Python JSON-RPC server
│   └── media/
│       └── hermesSettingsEditorPane.css
├── hermes/                         # Hermes Agent source code (git-linked)
│   └── README.md                   # Setup/upgrade instructions
└── setup_hermes_source.sh          # Source code clone/link script
```

## Capabilities

| Capability | Provider | Priority | Description |
|------------|----------|----------|-------------|
| **Model** | hermes-agent | 50 | 28+ model providers (Anthropic, OpenRouter, Gemini, etc.) |
| **Execution** | hermes-agent | 80 | AIAgent.run_conversation() autonomous loop |
| **Tool** | hermes-agent | 90 | 70+ built-in tools (web, files, terminal, browser, etc.) |
| **Memory** | hermes-agent | 70 | Built-in file memory + 9 plugin providers |

## Setup

### 1. Clone Hermes Agent Source

```bash
cd extensions/hermes-agent
./setup_hermes_source.sh
```

Or link to an existing checkout:

```bash
HERMES_AGENT_SRC=G:/CustomWorkspaces/AIProjects/Hermes-Agent ./setup_hermes_source.sh
```

### 2. Install Python Dependencies

```bash
pip install -e ./hermes
```

### 3. Configure API Key

Either:
- Set in Settings → Hermes Agent → API Key
- Or create `~/.hermes/.env` with `ANTHROPIC_API_KEY=...` (or your provider's key)

### 4. Start Using

The bridge auto-starts when the plugin activates. Select a provider and model in the settings, then start chatting.

## Bridge Architecture

The plugin communicates with hermes-agent via a JSON-RPC bridge over stdio:

```
TypeScript (Plugin)
    ↕ stdio JSON-RPC
Python (hermes_bridge_server.py)
    ↕ direct imports
AIAgent + ToolRegistry + Providers
```

### Supported RPC Methods

| Method | Description |
|--------|-------------|
| `list_providers` | List available model providers |
| `list_models` | List models for a provider |
| `chat.stream` | Stream a chat conversation |
| `list_tools` | List available tools |
| `execute_tool` | Execute a single tool |
| `memory.load_context` | Load memory context |
| `memory.write` | Write a memory entry |
| `memory.search` | Search memories |
| `upgrade_repo` | Pull latest code from git |
| `install_deps` | Install Python dependencies |
| `shutdown` | Graceful shutdown |

## Upgrading Hermes Agent

1. Use "Hermes: Upgrade Repository" command (git pull)
2. Use "Hermes: Install Dependencies" command (pip install)
3. Use "Hermes: Restart" command to restart the bridge

## Configuration

All settings are in `sessions.agentStudio.hermes.*` namespace:

| Setting | Default | Description |
|---------|---------|-------------|
| `pythonPath` | `python3` | Python interpreter path |
| `hermesHome` | `~/.hermes` | Config directory |
| `hermesSourcePath` | `hermes/` | Source code path |
| `provider` | (from config) | Default model provider |
| `model` | (from config) | Default model ID |
| `apiKey` | (from .env) | API key |
| `baseUrl` | (provider default) | Custom API endpoint |
| `enabledToolsets` | (all) | Enabled toolsets |
| `disabledToolsets` | (none) | Disabled toolsets |
| `maxIterations` | `90` | Max agent loop iterations |
| `memoryProvider` | (built-in) | Memory provider plugin |
| `autoStart` | `true` | Auto-start bridge |
| `timeout` | `300000` | Request timeout (ms) |
| `streaming` | `true` | Enable streaming |
