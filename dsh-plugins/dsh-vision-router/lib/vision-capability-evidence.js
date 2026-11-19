export const VISION_INTENTS = [
    'structured',
    'ocr',
    'document',
    'ui',
    'grounding',
    'detection',
    'general',
    'chart_diagram',
    'code_screenshot',
    'visual_compare',
];
export const BENCHMARK_AXES = [
    'structured',
    'ocr',
    'document',
    'grounding',
    'general',
];
const DIRECT_TASK_AXIS = Object.freeze({
    structured: 'structured',
    ocr: 'ocr',
    document: 'document',
    grounding: 'grounding',
    general: 'general',
});
export function normalizeVisionIntent(intent) {
    return typeof intent === 'string'
        && VISION_INTENTS.includes(intent)
        ? intent
        : 'general';
}
export function benchmarkAxisForVisionIntent(intent) {
    return DIRECT_TASK_AXIS[normalizeVisionIntent(intent)];
}
