# Hermes Chat

Start a conversation with the Hermes Agent. The agent uses its configured model provider and tool set to respond autonomously.

## Instructions

1. Ensure Hermes Agent bridge is running (auto-starts by default)
2. Select a model provider and model in Settings or via the model selector
3. Send your message — Hermes will plan, reason, and execute tools as needed
4. Tool calls and thinking steps are displayed inline

## Parameters

- **message** (required): The message to send to the Hermes agent
- **provider** (optional): Override the default model provider
- **model** (optional): Override the default model ID
- **temperature** (optional): Sampling temperature (0.0–2.0)
- **maxIterations** (optional): Maximum tool-calling iterations (default 90)
