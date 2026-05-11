export declare class EmployeeChatPanel {
    constructor(opts: {
        onSendMessage: (text: string) => void;
        onCancelExecution: () => void;
    });
    element: HTMLElement;
    setEmployee(employee: any | null): void;
    setMessages(messages: any[]): void;
    addMessage(message: any): void;
    clearMessages(): void;
    setAutoOrchestrate(enabled: boolean): void;
    setWebSearchEnabled(enabled: boolean): void;
    setProvider(provider: string): void;
    setModel(model: string): void;
    dispose(): void;
}
