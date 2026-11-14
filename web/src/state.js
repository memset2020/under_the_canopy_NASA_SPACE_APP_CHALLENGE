// The one shared store (CLAUDE.md "State"). Modules never keep their own copy.

export function createStore(initial = {}) {
  let state = { ...initial };
  const subscribers = new Set();

  return {
    get() {
      return state;
    },
    // Shallow-merge a patch; subscribers get (state, prev, changedKeys).
    set(patch) {
      const prev = state;
      state = { ...state, ...patch };
      const changed = Object.keys(patch).filter((k) => prev[k] !== state[k]);
      if (changed.length === 0) return;
      for (const fn of [...subscribers]) fn(state, prev, changed);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// Run fn only when one of the named keys changed; also runs once immediately.
export function watch(store, keys, fn) {
  fn(store.get(), null, keys);
  return store.subscribe((state, prev, changed) => {
    if (changed.some((k) => keys.includes(k))) fn(state, prev, changed);
  });
}
