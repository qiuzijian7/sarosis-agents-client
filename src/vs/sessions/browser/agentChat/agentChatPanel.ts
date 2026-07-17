import { AgentChatPanelHeader } from './agentChatPanel.header.js';

/**
 * AgentChatPanel — thin composition root.
 * Chain: AgentChatPanel -> AgentChatPanelHeader -> AgentChatPanelSend -> ... -> AgentChatPanelBase.
 * @see agentChatPanel.base.ts and agentChatPanel.toolCards.ts for implementation.
 */
export class AgentChatPanel extends AgentChatPanelHeader {
}
