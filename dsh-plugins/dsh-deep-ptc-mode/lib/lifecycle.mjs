// Serialize definition replacement. The registry retains revisions used by old sessions.
export function presetLifecycle(register, getDefinition, onError) {
  let disposed = false;
  let unregister;
  let lastGood;
  let queue = Promise.resolve();
  const refresh = () => {
    queue = queue.then(async () => {
      if (disposed) return;
      const definition = await getDefinition(); // Validate before removing the last good definition.
      await unregister?.();
      unregister = undefined;
      if (disposed) return;
      let release;
      try { release = await register(definition); }
      catch (error) {
        if (lastGood !== undefined && !disposed) {
          try { unregister = await register(lastGood); }
          catch (restoreError) { throw new AggregateError([error, restoreError], 'Preset update and restoration both failed'); }
        }
        throw error;
      }
      if (disposed) await release();
      else {
        unregister = release;
        lastGood = definition;
      }
    });
    const operation = queue;
    queue = operation.catch(error => onError(error));
    return operation;
  };
  return {
    refresh,
    async dispose() {
      disposed = true;
      await queue;
      await unregister?.();
      unregister = undefined;
    },
  };
}
