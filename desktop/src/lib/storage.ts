// Per-machine UI preferences in the WebView's localStorage (theme, panel sizes, recents).
// Keys are prefixed `localleaf:`; values saved by older versions under `texcraft:` are
// still read, and rewritten under the new prefix on the next save.

const PREFIX = "localleaf:";
const LEGACY_PREFIX = "texcraft:";

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key) ?? localStorage.getItem(LEGACY_PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(PREFIX + key, value);
    localStorage.removeItem(LEGACY_PREFIX + key);
  } catch {
    /* storage unavailable: the preference just isn't remembered */
  }
}

export function removeStored(key: string) {
  try {
    localStorage.removeItem(PREFIX + key);
    localStorage.removeItem(LEGACY_PREFIX + key);
  } catch {
    /* ignore */
  }
}
