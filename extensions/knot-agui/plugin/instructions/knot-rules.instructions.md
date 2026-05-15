# Knot AG-UI Plugin Rules

## General Behavior

- When using Knot agents, always verify the connection is authenticated before sending messages.
- If the Knot API returns an error, display a clear message and suggest checking the API token configuration.
- Respect the streaming nature of AG-UI responses — do not buffer the entire response before displaying.

## Authentication

- The Knot API Token must be configured in `sessions.agentStudio.knot.token`.
- Team tokens require a username (`sessions.agentStudio.knot.user`).
- If authentication fails, guide the user to Settings → Knot to reconfigure.

## Agent Selection

- When multiple agents are available, let the user choose from the agent list.
- Agents are configured in `sessions.agentStudio.knot.agents` with id, name, and models.
- If no agents are listed, suggest refreshing the agent list.

## Error Handling

- On `RUN_ERROR` events, display the error message and suggest retrying.
- On network errors, check if the API endpoint is reachable.
- On authentication errors (401/403), prompt the user to update their token.

## Streaming Protocol

- AG-UI events follow the standard SSE format with `data:` prefixed lines.
- The `[DONE]` sentinel marks the end of a stream.
- Tool calls may be interleaved with text and thinking content.
