/*---------------------------------------------------------------------------------------------
 *  AgentMemory file server — lightweight JSONL persistence server.
 *
 *  This is NOT agentmemory + iii-engine. It's a ~60 line Node.js HTTP server
 *  that reads/writes JSONL files for the in-process AgentMemoryProvider.
 *
 *  All smart algorithms (BM25, Vector, RRF, decay, privacy filter) run in the
 *  renderer process. This server only provides atomic file I/O.
 *
 *  Endpoints:
 *    GET  /mem/<agentId>/<file>           → read JSONL file
 *    PUT  /mem/<agentId>/<file>           → write JSONL file (atomic: tmp + rename)
 *    GET  /health                         → health check
 *
 *  Started by saros Electron main process (startAgentMemoryGateway in app.ts).
 *--------------------------------------------------------------------------------------------*/

import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[agentmemory-fileserver]';

function emit(kind, msg, extra = {}) {
	const obj = { kind, msg, ts: new Date().toISOString(), ...extra };
	process.stdout.write(JSON.stringify(obj) + '\n');
}

function resolveDataDir() {
	const home = process.env.HOME || process.env.USERPROFILE || '.';
	return process.env.AGENTMEMORY_DATA_DIR || path.join(home, '.saros', '.agentmemory');
}

// Sanitize agentId/file to prevent path traversal
function sanitize(str) {
	return str.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function main() {
	const port = parseInt(process.env.AGENTMEMORY_PORT || '3111', 10);
	const dataDir = resolveDataDir();

	// Ensure data directory exists
	fs.mkdirSync(dataDir, { recursive: true });

	emit('log', `${TAG} starting on port ${port}, dataDir=${dataDir}`);

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, `http://localhost:${port}`);

			// Health check
			if (url.pathname === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok', dataDir, port }));
				return;
			}

			// Memory file endpoints: /mem/<agentId>/<file>
			const memMatch = url.pathname.match(/^\/mem\/([^/]+)\/(.+)$/);
			if (!memMatch) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'not found' }));
				return;
			}

			const agentId = sanitize(memMatch[1]);
			const fileName = sanitize(memMatch[2]);
			const agentDir = path.join(dataDir, agentId);
			const filePath = path.join(agentDir, fileName);

			// Prevent path traversal
			if (!filePath.startsWith(path.resolve(agentDir))) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'forbidden' }));
				return;
			}

			if (req.method === 'GET') {
				try {
					const content = fs.readFileSync(filePath, 'utf8');
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(content);
				} catch (err) {
					if (err.code === 'ENOENT') {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end('[]'); // empty array for missing files
					} else {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					}
				}
				return;
			}

			if (req.method === 'PUT') {
				// Collect body
				const chunks = [];
				for await (const chunk of req) {
					chunks.push(chunk);
				}
				const body = Buffer.concat(chunks).toString('utf8');

				// Ensure agent directory exists
				fs.mkdirSync(agentDir, { recursive: true });

				// Atomic write: tmp file + rename
				const tmpPath = filePath + `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				fs.writeFileSync(tmpPath, body, 'utf8');
				fs.renameSync(tmpPath, filePath);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, bytes: body.length }));
				return;
			}

			res.writeHead(405, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'method not allowed' }));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
		}
	});

	server.listen(port, '127.0.0.1', () => {
		emit('ready', `file server ready on port ${port}`, { port, dataDir });
	});

	// Graceful shutdown
	const shutdown = (sig) => {
		emit('log', `${TAG} received ${sig}, shutting down...`);
		server.close(() => {
			process.exit(0);
		});
		// Force exit after 2s
		setTimeout(() => process.exit(0), 2000);
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
	emit('error', `${TAG} fatal: ${err.message}`, { stack: err.stack });
	process.exit(1);
});
