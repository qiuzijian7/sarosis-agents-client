/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyLauncher — Comfy Desktop 配置解析 + python/main.py 路径挑选。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { join } from 'path';
import {
	parseComfyDesktopConfig,
	pythonCandidates,
	mainPyCandidates,
	pickComfyLaunchPaths,
} from '../../electron-main/comfyLauncher.js';

const venvPy = join('D:', 'ComfyUI', '.venv', 'Scripts', 'python.exe');
const desktopMain = join('D:', 'Program Files', 'ComfyUI', 'resources', 'ComfyUI', 'main.py');

suite('comfyLauncher', () => {

	suite('parseComfyDesktopConfig', () => {

		test('解析 config.json basePath + extra yaml desktopRoot', () => {
			const cfg = parseComfyDesktopConfig(
				JSON.stringify({ basePath: 'D:\\ComfyUI', installState: 'installed' }),
				'# ComfyUI extra_model_paths.yaml for win32\n' +
				'desktop_extensions:\n' +
				'  custom_nodes: D:\\Program Files\\ComfyUI\\resources\\ComfyUI\\custom_nodes\n' +
				'  base_path: D:\\ComfyUI\n',
			);
			assert.strictEqual(cfg.basePath, 'D:\\ComfyUI');
			// <desktopRoot>/resources/ComfyUI/custom_nodes → 上推 3 级
			assert.strictEqual(cfg.desktopRoot, 'D:\\Program Files\\ComfyUI');
		});

		test('空/损坏输入容错', () => {
			assert.deepStrictEqual(parseComfyDesktopConfig(undefined, undefined), {});
			assert.deepStrictEqual(parseComfyDesktopConfig('{broken json', 'not yaml: ['), {});
		});

		test('无 custom_nodes 时不推断 desktopRoot', () => {
			const cfg = parseComfyDesktopConfig(undefined, 'desktop_extensions:\n  base_path: D:\\ComfyUI\n');
			assert.strictEqual(cfg.desktopRoot, undefined);
		});
	});

	suite('pythonCandidates / mainPyCandidates', () => {

		test('python 候选 venv 优先', () => {
			const c = pythonCandidates({ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' });
			assert.strictEqual(c[0], venvPy);
			assert.ok(c.some(p => p.includes('bootstrap-python')));
		});

		test('main.py 候选 desktopRoot 优先', () => {
			const c = mainPyCandidates({ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' });
			assert.strictEqual(c[0], desktopMain);
		});
	});

	suite('pickComfyLaunchPaths', () => {

		test('挑选存在的组合', () => {
			const exists = (p: string) => p.includes('.venv') || p.includes('resources');
			const paths = pickComfyLaunchPaths(
				{ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' },
				exists,
			);
			assert.strictEqual(paths.pythonPath, venvPy);
			assert.strictEqual(paths.mainPyPath, desktopMain);
		});

		test('override 优先（环境变量显式指定）', () => {
			const paths = pickComfyLaunchPaths(
				{ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' },
				() => true,
				{ pythonPath: 'C:\\py\\python.exe', mainPyPath: 'D:\\my\\main.py' },
			);
			assert.strictEqual(paths.pythonPath, 'C:\\py\\python.exe');
			assert.strictEqual(paths.mainPyPath, 'D:\\my\\main.py');
		});

		test('无匹配返回 undefined', () => {
			const paths = pickComfyLaunchPaths({}, () => false);
			assert.strictEqual(paths.pythonPath, undefined);
			assert.strictEqual(paths.mainPyPath, undefined);
		});

		test('override 指向不存在的路径时回退候选（exists=false）', () => {
			// exists 总返回 false → override 视为无效，回退候选列表也全空 → 都为 undefined
			const paths = pickComfyLaunchPaths(
				{ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' },
				() => false,
				{ pythonPath: 'D:\\nonexistent\\python.exe', mainPyPath: 'D:\\nonexistent\\main.py' },
			);
			assert.strictEqual(paths.pythonPath, undefined);
			assert.strictEqual(paths.mainPyPath, undefined);
		});

		test('override 优先于自动解析（用户场景：自定义安装位置）', () => {
			// 自动候选会找到 .venv python，但用户配置指向独立 Python
			const paths = pickComfyLaunchPaths(
				{ basePath: 'D:\\ComfyUI', desktopRoot: 'D:\\Program Files\\ComfyUI' },
				() => true,
				{ pythonPath: 'C:\\Python311\\python.exe' },
			);
			assert.strictEqual(paths.pythonPath, 'C:\\Python311\\python.exe');
			assert.strictEqual(paths.mainPyPath, desktopMain);
		});
	});
});
