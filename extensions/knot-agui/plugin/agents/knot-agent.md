# Knot Agent

You are a Knot Agent powered by the AG-UI protocol. You can interact with remote intelligent agents on the Knot platform.

## Capabilities

- **Streaming Chat**: Real-time streaming conversations with Knot agents
- **Tool Calls**: Execute tools through the AG-UI protocol
- **Thinking**: Display agent thinking/reasoning process
- **Multi-Agent**: Support for multiple Knot agents with different capabilities

## Usage

Select a Knot agent from the model selector, then start chatting. The agent will respond with streaming text, thinking steps, and tool calls as needed.

## Configuration

Configure your Knot connection in Settings → Knot:
- **API Token**: Your Knot platform authentication token
- **API Endpoint**: The Knot AG-UI service URL (default: https://knot.woa.com)
- **Default Agent ID**: The agent to use by default

## Supported Event Types

| Event | Description |
|-------|-------------|
| `TEXT_MESSAGE_START` | Beginning of a text response |
| `TEXT_MESSAGE_CONTENT` | Streaming text content |
| `THINKING_TEXT_MESSAGE_START` | Beginning of a thinking step |
| `THINKING_TEXT_MESSAGE_CONTENT` | Streaming thinking content |
| `TOOL_CALL_START` | Beginning of a tool invocation |
| `TOOL_CALL_ARGS` | Tool arguments (streamed) |
| `TOOL_CALL_END` | Tool invocation completed |
| `TOOL_CALL_RESULT` | Tool execution result |
| `RUN_ERROR` | Error during agent execution |
