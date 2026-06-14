# Hermes Agent Provider

A reference VS Code extension that contributes a third-party LLM Chat Provider via the
upstream `chatProvider` proposed API. It bridges the Hermes Python backend
(`hermes-webui-studio`) into the chat box's provider picker without any main-repo
import or rebuild.

## How it works

1. The extension activates on startup and calls
   `vscode.lm.registerLanguageModelChatProvider("hermes", provider)`.
2. The provider talks to a local OpenAI-compatible HTTP endpoint
   (default `http://127.0.0.1:8765/v1/...`) for `/models` and `/chat/completions`.
3. The renderer-side bridge `LanguageModelsToAgentOSBridge` (in
   `src/vs/sessions/contrib/agentStudio/browser/languageModelsBridge.ts`) listens to
   `ILanguageModelsService.onDidChangeLanguageModels` and reflects this provider
   into `IAgentOSService.registerModelProvider(...)`, so the chat box's provider
   picker shows it automatically.

## Install for end-users (release exe)

This extension uses a proposed API. To allow it in a packaged build, it is
registered in `product.json#extensionEnabledApiProposals`:

```json
"extensionEnabledApiProposals": {
    "saros.hermes-agent-provider": ["chatProvider"]
}
```

After build, install the produced `.vsix` (or drop the folder into the user
extensions directory).

## Key contract — does NOT depend on the main repo

This extension only `import * as vscode from 'vscode'`. It does **not**
`import '../../../src/vs/...'`. That makes it a real VS Code extension that runs
exclusively in the ExtensionHost process and is portable to vanilla VS Code as
well (assuming the `chatProvider` proposed API is exposed there).
