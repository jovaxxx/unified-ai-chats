/**
 * Reads a `Range: bytes=…` header for a file of `size` bytes, so a video can be played and skipped through.
 * Null when there is no (usable) range, `'invalid'` when the range lies outside the file.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '') || size <= 0) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // The last N bytes.
    const last = Number(m[2]);
    if (!Number.isSafeInteger(last) || last <= 0) return 'invalid';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
    return 'invalid';
  return { start, end };
}
