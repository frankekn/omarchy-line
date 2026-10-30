// Assemble named context values and check late-bound reads. No dependencies.
export function makeRegistry() {
  const values = Object.create(null);
  const sources = new Map();
  const handler = {
    get(target, key, receiver) {
      if (!Object.hasOwn(target, key)) {
        throw new Error(`unknown ctx.${String(key)}`);
      }
      return Reflect.get(target, key, receiver);
    },
    set() {
      throw new TypeError("ctx is read-only");
    },
    defineProperty() {
      throw new TypeError("ctx is read-only");
    },
    deleteProperty() {
      throw new TypeError("ctx is read-only");
    },
  };
  // Factories may read the initial values during assembly and hold this proxy.
  // Both proxies share the same object, which finish() freezes before wrapping.
  const assembling = new Proxy(values, handler);
  function provide(name, part) {
    const keys = Object.keys(part);
    for (const key of keys) {
      if (Object.hasOwn(values, key)) {
        throw new Error(
          `duplicate ctx.${key} from ${sources.get(key)} and ${name}`,
        );
      }
    }
    for (const key of keys) {
      values[key] = part[key];
      sources.set(key, name);
    }
  }
  function finish() {
    Object.freeze(values);
    return new Proxy(values, handler);
  }
  return { assembling, provide, finish };
}
