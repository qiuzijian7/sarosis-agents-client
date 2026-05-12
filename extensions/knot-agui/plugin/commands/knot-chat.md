# Knot Chat

Initiate a conversation with a Knot AG-UI agent. The agent will respond with streaming text, display thinking steps, and invoke tools as needed.

## Instructions

1. Ensure the Knot AG-UI connection is configured (API Token and Endpoint)
2. Select a Knot agent from the model selector if multiple are available
3. Send your message — the agent will stream its response in real time
4. Tool calls and thinking steps are displayed inline

## Parameters

- **message** (required): The message to send to the Knot agent
- **agentId** (optional): Override the default agent ID
- **model** (optional): Specify a model variant within the agent
- **temperature** (optional): Sampling temperature (0.0–2.0)
