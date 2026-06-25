# Hermes Agent Plugin Rules

## General Behavior

- Always verify the Hermes bridge process is running before sending messages.
- If the bridge is not running, auto-start it or prompt the user to run "Hermes: Start Agent Bridge".
- Respect the streaming nature of Hermes responses — forward deltas as they arrive.
- Display thinking/reasoning content distinctly from regular text output.
- Show tool invocations with clear progress indicators.

## Authentication

- API keys can be configured via `sessions.agentStudio.hermes.apiKey` or `~/.hermes/.env`.
- Provider-specific keys (e.g. `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) should be in `.env`.
- If authentication fails, guide the user to Settings → Hermes Agent or to edit `~/.hermes/.env`.

## Model Selection

- When multiple providers are configured, let the user choose from the provider list.
- Each provider may offer multiple models — use `hermes.selectModel` to choose.
- The default provider/model can be set in `sessions.agentStudio.hermes.provider` and `sessions.agentStudio.hermes.model`.

## Tool Execution

- Hermes has 70+ built-in tools across web, file, terminal, browser, and other categories.
- Tools are auto-discovered based on enabled toolsets and environment variables.
- Unsafe tools (terminal, file write) require user approval in the UI.
- Parallel safe-tool execution is supported for better performance.

## Error Handling

- On bridge process crash, attempt automatic restart.
- On API errors (401/403/429), suggest checking API key and rate limits.
- On tool execution errors, display the error and allow retry.
- On timeout, suggest increasing `hermes.timeout` or simplifying the request.

## Repository Management

- The Hermes source code is embedded in the plugin's `hermes/` directory.
- Use "Hermes: Upgrade Repository" to pull the latest changes from GitHub.
- Use "Hermes: Install Dependencies" to install/update Python dependencies after upgrading.
