/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare class EmployeeChatPanel {
	constructor(opts: {
		onSendMessage: (text: string) => void;
		onCancelExecution: () => void;
		onToggleCollapse: () => void;
	});
	readonly element: HTMLElement;
	setEmployee(employee: any): void;
	setMessages(messages: any[]): void;
	addMessage(message: any): void;
	updateMessage(messageId: string, updates: any): void;
	setSending(sending: boolean): void;
	setProviders(providers: any[]): void;
	setModels(models: any[]): void;
	setCurrentProvider(provider: string): void;
	setCurrentModel(model: string): void;
	focusInput(): void;
	layout(width: number, height: number): void;
	dispose(): void;
}
