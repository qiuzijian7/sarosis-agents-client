function propertyBag(value) {
    return value !== null && typeof value === 'object'
        ? value
        : undefined;
}
function failureMessage(failure) {
    const message = propertyBag(failure)?.message;
    return message ? String(message) : String(failure);
}
/**
 * Minimal DVR text assembler over the public DSH StreamChunk contract.
 *
 * Current DSH failures arrive inside the terminal finish reason. The two
 * standalone terminal shapes remain explicit compatibility input for released
 * historical/partial adapters. Runtime shape checks stay in place because JS
 * callers may still provide malformed chunks.
 */
export function createChunkAssembler() {
    const parts = new Map();
    const order = [];
    let finishKind;
    let failure;
    const pushUnknown = (value) => {
        const chunk = propertyBag(value);
        if (chunk === undefined || typeof chunk.type !== 'string')
            return;
        switch (chunk.type) {
            case 'block-start': {
                if (!parts.has(chunk.index)) {
                    order.push(chunk.index);
                    parts.set(chunk.index, { type: chunk.blockType, text: '' });
                }
                break;
            }
            case 'text-delta': {
                const part = parts.get(chunk.index);
                if (part !== undefined)
                    part.text += (chunk.text ?? '');
                break;
            }
            case 'reasoning-delta':
            case 'tool-call-delta':
            case 'usage':
                break;
            case 'block-end': {
                const part = parts.get(chunk.index);
                const block = propertyBag(chunk.block);
                if (part !== undefined && typeof block?.text === 'string') {
                    part.text = block.text;
                }
                break;
            }
            case 'finish': {
                const reason = propertyBag(chunk.reason);
                if (reason !== undefined
                    && (reason.kind === 'error' || reason.kind === 'aborted')) {
                    failure = reason.failure;
                }
                finishKind =
                    reason !== undefined && reason.kind
                        ? String(reason.kind)
                        : 'stop';
                break;
            }
            case 'error':
            case 'aborted':
                failure = chunk.failure;
                break;
            default:
                break;
        }
    };
    return {
        push(chunk) {
            pushUnknown(chunk);
        },
        finish() {
            if (failure)
                throw new Error(failureMessage(failure));
            if (finishKind !== undefined
                && finishKind !== 'stop'
                && finishKind !== 'max-tokens') {
                throw new Error(`vision call finished with "${finishKind}"`);
            }
            return order
                .map((index) => parts.get(index))
                .filter((part) => part !== undefined && part.type === 'text')
                .map((part) => part.text)
                .join('')
                .trim();
        },
    };
}
const _officialFailureAuthority = undefined;
void _officialFailureAuthority;
