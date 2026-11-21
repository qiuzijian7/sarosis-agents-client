// Present an official tool plugin with replaced service faces while keeping the real Cordis context
// for effects, events and injection. `faces` maps a service name to a function of the real service.
export function adaptContext(ctx, faces) {
  const face = (target, key) => {
    const value = Reflect.get(target, key, target);
    if (Object.hasOwn(faces, key) && value !== undefined) return faces[key](value);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'inject') return (dependencies, callback) => target.inject(dependencies,
        child => callback(new Proxy(child, { get: face })));
      return face(target, key);
    },
  });
}

// Wrap each definition an official plugin registers.
export function registering(tools, wrap) {
  return new Proxy(tools, {
    get(target, key) {
      if (key === 'register') return (definition, ...options) => target.register(wrap(definition), ...options);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
