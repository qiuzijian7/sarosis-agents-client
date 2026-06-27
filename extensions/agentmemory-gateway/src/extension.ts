/*---------------------------------------------------------------------------------------------
 *  AgentMemory Gateway — capability extension stub (renderer side)
 *
 *  Architecture (same as tdb-am-gateway):
 *    saros Electron main process → spawn extensions/agentmemory-gateway/host/host.mjs
 *                                  → child process runs `npx @agentmemory/agentmemory`
 *                                  → listens on 127.0.0.1:3111 (HTTP REST)
 *    saros renderer (agentmemory-memory ext) → fetch http://127.0.0.1:3111/*
 *
 *  This file is a placeholder stub:
 *    - Does nothing on renderer side (gateway started by main process)
 *    - No vendor/fs/sqlite dependencies
 *--------------------------------------------------------------------------------------------*/

export class AgentMemoryGatewayPlugin {
	async activate(): Promise<void> {
		try {
			console.log('[agentmemory-gateway] capability stub activated; server started by main process');
		} catch { /* ignore */ }
	}

	async deactivate(): Promise<void> {
		// Nothing to clean up on renderer side
	}
}

export default AgentMemoryGatewayPlugin;
