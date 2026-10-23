const CHAT_STORAGE_PREFIX = "lg:";

/** Removes this app's saved chat state (model choice, run ids) from the browser. */
export function clearChatStorage() {
  const stores = [() => window.localStorage, () => window.sessionStorage];
  for (const getStore of stores) {
    try {
      const store = getStore();
      const keys: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key?.startsWith(CHAT_STORAGE_PREFIX)) keys.push(key);
      }
      keys.forEach((key) => store.removeItem(key));
    } catch {
      // Storage can be unavailable (private mode, blocked site data).
    }
  }
}
