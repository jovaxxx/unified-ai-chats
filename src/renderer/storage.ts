/** Small helpers for remembered interface choices (widths, collapsed folders, sort order). Never throws. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`uac.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(`uac.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
