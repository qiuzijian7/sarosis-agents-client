export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    console.log('Resolving electron...');
    const result = await nextResolve(specifier, context);
    console.log('Resolved to:', result.url);
    return result;
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('electron')) {
    console.log('Loading:', url);
  }
  return nextLoad(url, context);
}
