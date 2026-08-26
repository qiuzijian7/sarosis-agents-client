/* UI tests for DirectorConsoleEditor (导演台编辑器).
 *
 * Verifies:
 * 1. Module imports without TDZ (the root cause fix: uploadRender declared before scheduleUpload)
 * 2. Fountain → StoryBoardData pipeline
 * 3. StoryboardDoc round-trip (boardStateToJson ↔ parseBoardState)
 * 4. LayerDoc round-trip (layerDocToJson ↔ parseLayerDoc)
 * 5. DirectorConsoleEditor component is a valid React function
 * 6. Board text fields configuration completeness
 * 7. Board CRUD operations (add/remove/move/patch/duplicate)
 * 8. Utility functions (duration, labels, images JSON, etc.)
 *
 * Run with: npx tsx test/directorConsole.test.ts
 */

import { fountainToBoards } from '../src/features/workflowEditor/comfyHost/fountain';
import {
	createBoard, defaultBoardState, parseBoardState, boardStateToJson,
	addBoard, removeBoard, moveBoard, patchBoard, totalDurationMs,
	shotLabels, coverImageUrl, boardsToImagesJson, duplicateBoardData,
	boardsFromImagesJson, suggestedDurationMs, boardsFromShotsJson,
	generateBoardUid, boardDurationMs, boardImageUrl, defaultBoardData,
	isStoryboardEditorNode, type StoryboardDoc, type StoryBoardData,
} from '../src/features/workflowEditor/comfyHost/storyboardEditor';
import {
	defaultLayerDoc, parseLayerDoc, layerDocToJson,
	addLayerOp, newLayerId, isLayerEditorNode, makeImageOp,
	type LayerDoc, type LayerOp,
} from '../src/features/workflowEditor/comfyHost/layerEditor';
import { DirectorConsoleEditor, BOARD_TEXT_FIELDS } from '../src/features/workflowEditor/DirectorConsoleEditor';

// ─── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function eq<T>(actual: T, expected: T, label: string): void {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
	else { failed++; console.error(`✗ ${label}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`); }
}

function ok(condition: boolean, label: string): void {
	if (condition) { passed++; }
	else { failed++; console.error(`✗ ${label}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Module import sanity — no TDZ on import (the key fix)
// ══════════════════════════════════════════════════════════════════════════════

ok(typeof DirectorConsoleEditor === 'function', 'DirectorConsoleEditor is a function component');
ok(typeof fountainToBoards === 'function', 'fountainToBoards imported OK');
ok(typeof createBoard === 'function', 'createBoard imported OK');
ok(typeof parseBoardState === 'function', 'parseBoardState imported OK');
ok(typeof boardStateToJson === 'function', 'boardStateToJson imported OK');
ok(typeof defaultLayerDoc === 'function', 'defaultLayerDoc imported OK');
ok(typeof parseLayerDoc === 'function', 'parseLayerDoc imported OK');
ok(typeof layerDocToJson === 'function', 'layerDocToJson imported OK');

// ══════════════════════════════════════════════════════════════════════════════
// 2. Fountain parser — basic scene extraction
// ══════════════════════════════════════════════════════════════════════════════

const sampleFountain = `
EXT. CITY STREET - DAY

The hero walks down the street.

JOHN
Hello world!

INT. OFFICE - NIGHT

John sits at his desk.
`;

const boards = fountainToBoards(sampleFountain);
ok(Array.isArray(boards), 'fountain returns array');
ok(boards.length >= 1, `fountain parsed ${boards.length} scenes (expected >= 1)`);

if (boards.length >= 1) {
	// StoryBoardData uses flat strings: dialogue, action (not nested dialogues[], heading)
	const hasContent = (boards[0].dialogue?.length > 0 || boards[0].action?.length > 0);
	ok(hasContent, 'first scene has dialogue or action content');
}

// Edge cases
eq(fountainToBoards('').length, 0, 'empty string → 0 boards');
eq(fountainToBoards('\n\n\n').length, 0, 'whitespace only → 0 boards');

// ══════════════════════════════════════════════════════════════════════════════
// 3. StoryboardDoc round-trip: state → JSON → parse
// ══════════════════════════════════════════════════════════════════════════════

const sampleBoards: StoryBoardData[] = [
	createBoard({ action: 'A child plays on a swing.', dialogue: 'MOM\nBe careful!' }),
	createBoard({ action: 'Dinner time.' }),
];

const state: StoryboardDoc = { version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000, boards: sampleBoards };
const json = boardStateToJson(state);
ok(typeof json === 'string' && json.length > 0, 'boardStateToJson produces non-empty string');

const parsed = parseBoardState(json);
ok(parsed !== null, 'parseBoardState parses back successfully');
eq(parsed.boards.length, sampleBoards.length, 'round-trip preserves board count');
if (parsed.boards.length >= 1) {
	eq(parsed.boards[0].action, sampleBoards[0].action, 'round-trip preserves first action');
	eq(parsed.boards[0].dialogue, sampleBoards[0].dialogue, 'round-trip preserves first dialogue');
}
eq(parsed.width, 1280, 'round-trip preserves width');
eq(parsed.height, 720, 'round-trip preserves height');

// ══════════════════════════════════════════════════════════════════════════════
// 4. LayerDoc round-trip: default → JSON → parse
// ══════════════════════════════════════════════════════════════════════════════

const layer = defaultLayerDoc(1920, 1080);
ok(layer !== null && typeof layer === 'object', 'defaultLayerDoc returns object');
eq(layer.width, 1920, 'layer width');          // LayerDoc uses width/height
eq(layer.height, 1080, 'layer height');
ok(Array.isArray(layer.layers), 'layer has layers array');
eq(layer.layers.length, 1, 'default layer has 1 layer');
ok(layer.layers[0].visible === true, 'default layer is visible');

const layerJson = layerDocToJson(layer);
ok(typeof layerJson === 'string' && layerJson.length > 0, 'layerDocToJson produces non-empty string');

const parsedLayer = parseLayerDoc(layerJson);
ok(parsedLayer !== null, 'parseLayerDoc parses back successfully');
if (parsedLayer) {
	eq(parsedLayer.width, layer.width, 'parsed width matches');
	eq(parsedLayer.height, layer.height, 'parsed height matches');
	eq(parsedLayer.layers.length, layer.layers.length, 'parsed layer count matches');
}

// Invalid input safety — parseLayerDoc returns fallback default (not null)
const fallbackEmpty = parseLayerDoc('');
ok(fallbackEmpty !== null && Array.isArray(fallbackEmpty.layers), 'empty string → fallback LayerDoc');
const fallbackBad = parseLayerDoc('not json');
ok(fallbackBad !== null && Array.isArray(fallbackBad.layers), 'invalid json → fallback LayerDoc');

// ══════════════════════════════════════════════════════════════════════════════
// 5. Board text fields config — all required fields present
// ══════════════════════════════════════════════════════════════════════════════

const expectedFields = ['dialogue', 'action', 'scenePurpose', 'character', 'shotSize', 'imagePrompt', 'motionPrompt', 'notes'];
const actualKeys = BOARD_TEXT_FIELDS.map(f => f.key);
eq(actualKeys, expectedFields, 'BOARD_TEXT_FIELDS has all 8 fields in correct order');

for (const f of BOARD_TEXT_FIELDS) {
	ok(typeof f.label === 'string' && f.label.length > 0, `field "${f.key}" has non-empty label`);
	ok(typeof f.placeholder === 'string' && f.placeholder.length > 0, `field "${f.key}" has non-empty placeholder`);
	if (f.rows) ok(f.rows >= 1, `field "${f.key}" rows >= 1`);
}

const uniqueKeys = new Set(actualKeys);
eq(uniqueKeys.size, actualKeys.length, 'no duplicate board text field keys');

// ══════════════════════════════════════════════════════════════════════════════
// 6. createBoard / defaultBoardData / defaultBoardState factories
// ══════════════════════════════════════════════════════════════════════════════

const board = createBoard({ action: 'Test action' });
ok(board !== null, 'createBoard returns non-null');
ok(board.uid.length > 0, 'board has uid (5 chars)');
eq(board.uid.length, 5, 'uid is 5 characters');
eq(board.action, 'Test action', 'createBoard preserves action');
eq(board.newShot, false, 'newShot defaults to false');
eq(board.layerState, null, 'layerState defaults to null');
eq(board.durationMs, null, 'durationMs defaults to null');

// defaultBoardData includes initialized layerState
const boardWithData = defaultBoardData(1920, 1080);
ok(boardWithData.layerState !== null, 'defaultBoardData has layerState');
if (boardWithData.layerState) {
	eq((boardWithData.layerState as LayerDoc).width, 1920, 'layerState width matches');
	eq((boardWithData.layerState as LayerDoc).height, 1080, 'layerState height matches');
}

// defaultBoardState creates complete doc with one board
const fullDoc = defaultBoardState(800, 600);
eq(fullDoc.version, 1, 'version is 1');
eq(fullDoc.width, 800, 'default state width');
eq(fullDoc.height, 600, 'default state height');
eq(fullDoc.defaultBoardTimingMs, 2000, 'default timing ms');
eq(fullDoc.boards.length, 1, 'default state has 1 board');
ok(fullDoc.boards[0].layerState !== null, 'default board has layerState');

// round-trip full doc
const fullJson = boardStateToJson(fullDoc);
const fullParsed = parseBoardState(fullJson);
eq(fullParsed.width, 800, 'full round-trip preserves width');
eq(fullParsed.height, 600, 'full round-trip preserves height');
eq(fullParsed.boards.length, 1, 'full round-trip preserves board count');

// generateBoardUid produces valid UIDs
const uid1 = generateBoardUid();
const uid2 = generateBoardUid();
ok(uid1.length === 5, 'uid is 5 chars');
ok(uid2.length === 5, 'second uid is 5 chars');
ok(uid1 !== uid2, 'uids are unique');

// ══════════════════════════════════════════════════════════════════════════════
// 7. Board CRUD operations
// ══════════════════════════════════════════════════════════════════════════════

// ★ 回归测试：createBoard 不得再使用模块级全局计数器（旧 bug：name 显示"镜头 81"）
const g1 = createBoard();
const g2 = createBoard();
const g3 = createBoard();
eq(g1.name, undefined, 'createBoard #1: name undefined (no global seq)');
eq(g2.name, undefined, 'createBoard #2: name undefined (no global seq)');
eq(g3.name, undefined, 'createBoard #3: name undefined (no global seq)');
ok(g1.uid !== g2.uid && g2.uid !== g3.uid, 'createBoard: uids always unique');

let crudDoc = defaultBoardState(640, 480);

// addBoard
const afterAdd = addBoard(crudDoc);
eq(afterAdd.boards.length, 2, 'addBoard increases count');
ok(afterAdd.boards[1].layerState !== null, 'new board has layerState');

// removeBoard
const afterRemove = removeBoard(afterAdd, afterAdd.boards[0].uid);
eq(afterRemove.boards.length, 1, 'removeBoard decreases count');

// cannot remove last board
const afterRemoveLast = removeBoard(crudDoc, crudDoc.boards[0].uid);
eq(afterRemoveLast.boards.length, 1, 'cannot remove last board');

// moveBoard
const threeBoards = addBoard(addBoard(crudDoc));
const afterMoveUp = moveBoard(threeBoards, threeBoards.boards[2].uid, -1); // move last up
eq(afterMoveUp.boards[2].uid, threeBoards.boards[1].uid, 'moveBoard swaps positions');

// patchBoard
const afterPatch = patchBoard(crudDoc, crudDoc.boards[0].uid, { dialogue: 'patched text', action: 'patched action' });
eq(afterPatch.boards[0].dialogue, 'patched text', 'patchBoard updates dialogue');
eq(afterPatch.boards[0].action, 'patched action', 'patchBoard updates action');

// duplicateBoardData
const dup = duplicateBoardData(crudDoc.boards[0]);
ok(dup.uid !== crudDoc.boards[0].uid, 'duplicate gets new uid');
eq(dup.dialogue, crudDoc.boards[0].dialogue, 'duplicate preserves dialogue');
eq(dup.action, crudDoc.boards[0].action, 'duplicate preserves action');

// ══════════════════════════════════════════════════════════════════════════════
// 8. Utility functions
// ══════════════════════════════════════════════════════════════════════════════

// totalDurationMs
const durDoc: StoryboardDoc = {
	version: 1, width: 100, height: 100, defaultBoardTimingMs: 2000,
	boards: [createBoard({ durationMs: 3000 }), createBoard({ durationMs: null }), createBoard({ durationMs: 5000 })],
};
eq(totalDurationMs(durDoc), 10000, 'totalDurationMs sums explicit + defaults (3000+2000+5000)');

// boardDurationMs
eq(boardDurationMs(durDoc, durDoc.boards[0]), 3000, 'explicit duration used');
eq(boardDurationMs(durDoc, durDoc.boards[1]), 2000, 'null duration falls back to default');

// shotLabels
const labels = shotLabels(defaultBoardState());
eq(labels, ['1A'], 'single board → ["1A"]');
const multiLabels = shotLabels({ ...defaultBoardState(), boards: [createBoard(), createBoard({ newShot: true }), createBoard()] });
eq(multiLabels.length, 3, '3 boards produce 3 labels');
eq(multiLabels[0], '1A', 'first label is 1A');
eq(multiLabels[1], '1B', 'newShot increments letter');

// coverImageUrl
eq(coverImageUrl(defaultBoardState()), '', 'no images → empty string');
const withComposite = defaultBoardState();
withComposite.boards[0] = { ...withComposite.boards[0], compositeUrl: 'http://img.png' };
eq(coverImageUrl(withComposite), 'http://img.png', 'compositeUrl found');
const withRefOnly = defaultBoardState();
withRefOnly.boards[0] = { ...withRefOnly.boards[0], refUrl: 'http://ref.png' };
eq(coverImageUrl(withRefOnly), 'http://ref.png', 'refUrl used when no compositeUrl');

// boardImageUrl
eq(boardImageUrl({ ...createBoard(), compositeUrl: 'a', refUrl: 'b' }), 'a', 'compositeUrl priority');
eq(boardImageUrl({ ...createBoard(), refUrl: 'b' }), 'b', 'refUrl fallback');
eq(boardImageUrl(createBoard()), null, 'no image → null');

// boardsToImagesJson
const imgDoc2 = defaultBoardState();
imgDoc2.boards[0] = { ...imgDoc2.boards[0], compositeUrl: 'http://test.png' };
const imgJson = boardsToImagesJson(imgDoc2);
const imgParsed = JSON.parse(imgJson);
ok(Array.isArray(imgParsed.images), 'imagesJson has images array');
eq(imgParsed.images.length, 1, 'one image for one board with url');
if (imgParsed.images[0]) {
	eq(imgParsed.images[0].label, '1A', 'image label is shot label');
}

// suggestedDurationMs
eq(suggestedDurationMs(createBoard({ dialogue: '' })), null, 'empty dialogue → null');
const cjkDur = suggestedDurationMs(createBoard({ dialogue: '你好世界' }));
ok(cjkDur !== null && cjkDur! >= 1000, 'CJK text gives duration >= 1000ms');
const latinDur = suggestedDurationMs(createBoard({ dialogue: 'Hello world' }));
ok(latinDur !== null && latinDur! >= 1000, 'Latin text gives duration >= 1000ms');

// boardsFromImagesJson
const fromImgs = boardsFromImagesJson(JSON.stringify({ images: [{ index: 1, label: 'shot1', image_url: 'http://a.png' }, { index: 2, label: 'composite', image_url: 'http://b.png' }] }));
eq(fromImgs.length, 2, '2 images → 2 boards');
eq(fromImgs[0].refUrl, 'http://a.png', 'first board refUrl');
eq(fromImgs[0].notes, 'shot1', 'first board notes from label');
eq(fromImgs[1].notes, '', 'composite label ignored as notes');

// boardsFromShotsJson
const fromShots = boardsFromShotsJson(JSON.stringify({
	shots: [{ dialogue: 'Hello', action: 'Walk', character: 'John', duration: 2.5 }],
}));
eq(fromShots.length, 1, '1 shot → 1 board');
eq(fromShots[0].dialogue, 'Hello', 'shot dialogue preserved');
eq(fromShots[0].action, 'Walk', 'shot action preserved');
eq(fromShots[0].character, 'John', 'shot character preserved');
eq(fromShots[0].durationMs, 2500, 'duration converted to ms');
ok(fromShots[0].newShot, 'shots always set newShot=true');

// isStoryboardEditorNode / isLayerEditorNode
ok(isStoryboardEditorNode('ComfyTV.StoryboardEditorStage'), 'recognizes storyboard node');
ok(!isStoryboardEditorNode('ComfyTV.Other'), 'rejects non-storyboard node');
ok(isLayerEditorNode('ComfyTV.LayerEditorStage'), 'recognizes layer editor node');
ok(!isLayerEditorNode('ComfyTV.Other'), 'rejects non-layer node');

// ══════════════════════════════════════════════════════════════════════════════
// 9. Layer operations
// ══════════════════════════════════════════════════════════════════════════════

const lid = newLayerId('test');
ok(lid.startsWith('test_'), 'newLayerId uses prefix');

const strokeOp: LayerOp = { type: 'stroke', color: '#ff0000', size: 0.01, points: [[0.1, 0.2], [0.3, 0.4]] };
const afterStroke = addLayerOp(layer, layer.layers[0].id, strokeOp);
eq(afterStroke.layers[0].ops.length, 1, 'addLayerOp adds stroke op');

const imgOp = makeImageOp('http://photo.jpg');
eq(imgOp.type, 'image', 'makeImageOp creates image op');
eq(imgOp.imageUrl, 'http://photo.jpg', 'makeImageOp preserves URL');
eq(imgOp.x, 0, 'image op x=0');
eq(imgOp.w, 1, 'image op w=1 (full width)');

// ══════════════════════════════════════════════════════════════════════════════
// 10. clampDim — 尺寸校验（nodeCard.tsx 中的辅助函数）
// ══════════════════════════════════════════════════════════════════════════════

// 复制 nodeCard.tsx 中的 clampDim 实现（避免跨模块导入）
function clampDim(v: number, fallback: number): number {
	if (!Number.isFinite(v) || v < 64 || v > 4096) { return fallback; }
	return Math.round(v / 8) * 8;
}

eq(clampDim(NaN, 1280), 1280, 'NaN → fallback');
eq(clampDim(Infinity, 720), 720, 'Infinity → fallback');
eq(clampDim(-100, 1280), 1280, 'negative → fallback');
eq(clampDim(0, 1280), 1280, 'zero → fallback');
eq(clampDim(14, 1280), 1280, '14 (too small) → fallback 1280');
eq(clampDim(63, 1280), 1280, '63 (below min) → fallback');
eq(clampDim(64, 1280), 64, '64 (min) → 64');
eq(clampDim(1280, 720), 1280, '1280 (valid) → 1280');
eq(clampDim(4096, 720), 4096, '4096 (max) → 4096');
eq(clampDim(4097, 720), 720, '4097 (over max) → fallback');
eq(clampDim(1290, 1280), 1288, '1290 rounds to nearest 8');
eq(clampDim(65, 720), 64, '65 rounds down to 64');

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
