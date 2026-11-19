export function effectiveProxyUrlForUndici(value) {
    if (typeof value !== 'string')
        return value;
    return value.replace(/^(\s*)socks5h:/i, '$1socks5:');
}
