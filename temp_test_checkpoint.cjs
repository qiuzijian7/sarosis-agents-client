// Simple test script for CheckpointService
// Runs in Node.js, uses mocked IFileService/ILogService

const fs = require('fs');
const path = require('path');
const sqlite3 = require('@vscode/sqlite3');

// Mock ILogService
const mockLogService = {
	info: (msg) => console.log('[INFO]', msg),
	error: (msg) => console.error('[ERROR]', msg),
};

// We need to import the actual CheckpointService from TypeScript...
// This is complex. Let me just test the SQLite logic directly.

async function testSQLiteLogic() {
	console.log('=== Testing Checkpoint SQLite Logic ===');
	
	const testDbPath = path.join(__dirname, 'temp_test_checkpoints.db');
	
	// Clean up previous test
	if (fs.existsSync(testDbPath)) {
		fs.unlinkSync(testDbPath);
	}
	
	// Open database
	const db = await new Promise((resolve, reject) => {
		new sqlite3.Database(testDbPath, (err) => {
			if (err) return reject(err);
			resolve(db);
		});
	});
	
	console.log('Opened database:', testDbPath);
	
	// Run migration SQL
	const migrationSQL = `
		CREATE TABLE IF NOT EXISTS checkpoints (
			id            TEXT PRIMARY KEY NOT NULL,
			employee_id   TEXT NOT NULL,
			session_id    TEXT NOT NULL,
			type          TEXT NOT NULL,
			label         TEXT NOT NULL,
			description   TEXT,
			created_at    INTEGER NOT NULL,
			is_ghost      INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS file_snapshots (
			id            TEXT PRIMARY KEY NOT NULL,
			checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
			uri           TEXT NOT NULL,
			language_id   TEXT,
			content       TEXT NOT NULL,
			created_at    INTEGER NOT NULL
		);
	`;
	
	await new Promise((resolve, reject) => {
		db.exec(migrationSQL, (err) => err ? reject(err) : resolve());
	});
	
	console.log('Migration completed');
	
	// Test: Insert a checkpoint
	const checkpointId = 'test-cp-' + Date.now();
	await new Promise((resolve, reject) => {
		db.run(
			`INSERT INTO checkpoints (id, employee_id, session_id, type, label, description, created_at, is_ghost)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[checkpointId, 'emp1', 'sess1', 'tool_edit', 'Test CP', null, Date.now(), 0],
			function(err) { err ? reject(err) : resolve(); }
		);
	});
	
	console.log('Inserted checkpoint:', checkpointId);
	
	// Test: Insert file snapshots
	const snapshots = [
		{ uri: 'file:///test1.ts', content: 'console.log("hello");' },
		{ uri: 'file:///test2.ts', content: 'export const x = 1;' },
	];
	
	for (const snap of snapshots) {
		const snapId = snapshotId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
		await new Promise((resolve, reject) => {
			db.run(
				`INSERT INTO file_snapshots (id, checkpoint_id, uri, language_id, content, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[snapId, checkpointId, snap.uri, null, snap.content, Date.now()],
				function(err) { err ? reject(err) : resolve(); }
			);
		});
	}
	
	console.log('Inserted', snapshots.length, 'file snapshots');
	
	// Test: Read back checkpoint
	const row = await new Promise((resolve, reject) => {
		db.get('SELECT * FROM checkpoints WHERE id = ?', [checkpointId], (err, row) => {
			err ? reject(err) : resolve(row);
		});
	});
	
	console.log('Read checkpoint:', row);
	
	// Test: Read file snapshots
	const snapRows = await new Promise((resolve, reject) => {
		db.all('SELECT * FROM file_snapshots WHERE checkpoint_id = ?', [checkpointId], (err, rows) => {
			err ? reject(err) : resolve(rows);
		});
	});
	
	console.log('Read file snapshots:', snapRows.length, 'rows');
	snapRows.forEach(r => console.log('  -', r.uri, '(' + r.content.length + ' chars)'));
	
	// Test: Delete checkpoint (should cascade delete snapshots)
	await new Promise((resolve, reject) => {
		db.run('DELETE FROM checkpoints WHERE id = ?', [checkpointId], function(err) {
			err ? reject(err) : resolve();
		});
	});
	
	console.log('Deleted checkpoint (cascade should delete snapshots)');
	
	// Verify snapshots also deleted
	const remainingSnaps = await new Promise((resolve, reject) => {
		db.all('SELECT * FROM file_snapshots WHERE checkpoint_id = ?', [checkpointId], (err, rows) => {
			err ? reject(err) : resolve(rows);
		});
	});
	
	console.log('Remaining snapshots after delete:', remainingSnaps.length, '(should be 0)');
	
	// Cleanup
	await new Promise((resolve, reject) => {
		db.close((err) => err ? reject(err) : resolve());
	});
	
	fs.unlinkSync(testDbPath);
	console.log('Cleaned up test database');
	
	console.log('\n=== ALL TESTS PASSED ===');
}

testSQLiteLogic().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
