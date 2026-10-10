/**
 * Turns Markdown into one plain line for list previews ("## Title\n**bold** and `code`" → "Title bold and code").
 * Not a full parser: good enough for a 160-character teaser.
 */
export function stripMarkdown(input: string): string {
  return cleanDirectives(input)
    .replace(/```[^\n]*\n?/g, ' ') // code fence markers, keep the code text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // stray HTML tags
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/(\s)#{1,6}\s+(?=\S)/g, '$1') // headings that were already flattened onto one line
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ') // table separator rows
    .replace(/\|/g, ' ') // table cell borders
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[\s(])([*_])(\S(?:[^*_\n]*?\S)?)\2(?=[\s).,;:!?]|$)/g, '$1$3') // italic
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/\s+/g, ' ')
    .trim();
}

const DIRECTIVE_OPEN = /^\s{0,3}:{3,}\s*([A-Za-z][\w-]*)(?:\{(.*)\})?\s*$/;
const DIRECTIVE_CLOSE = /^\s{0,3}:{3,}\s*$/;
/** A line that only holds a directive's settings, as JSON between corner brackets: `【{"image_fetch": "…"}】`. */
/** An old-style citation marker: `【12†source】`. */
const CITATION = /[ \t]?【[^】\n]*†[^】\n]*】/g;
const DIRECTIVE_SETTINGS = /^\s*【\{.*\}】\s*$/;

/**
 * ChatGPT marks some of its answers with container directives, for example
 * `:::writing{variant="chat_message" id="…"}` … `:::` around a drafted message or email, or `:::contextList`
 * followed by a line of settings (`【{"image_fetch": "…"}】`), and old-style citation markers (`【12†source】`).
 * Shown as plain text they are just noise. This removes the opening and closing marker lines and keeps what is
 * inside; an email's subject, when the marker carries one, becomes a bold first line. Code blocks are left alone.
 */
export function cleanDirectives(text: string): string {
  if (
    !/^\s{0,3}:{3,}\s*[A-Za-z]/m.test(text) &&
    !/^\s*【\{.*\}】\s*$/m.test(text) &&
    !/【[^】\n]*†[^】\n]*】/.test(text)
  )
    return text;
  const out: string[] = [];
  let fenced = false;
  let depth = 0;
  for (const line of text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (!fenced) {
      const open = DIRECTIVE_OPEN.exec(line);
      if (open) {
        depth++;
        const subject = /subject="([^"]*)"/.exec(open[2] ?? '')?.[1];
        if (subject) out.push(`**${subject}**`, '');
        continue;
      }
      if (depth > 0 && DIRECTIVE_CLOSE.test(line)) {
        depth--;
        continue;
      }
      // The settings of a directive sit on a line of their own (outside any code block): plumbing, never shown.
      if (DIRECTIVE_SETTINGS.test(line)) continue;
    }
    out.push(fenced ? line : line.replace(CITATION, ''));
  }
  return out.join('\n');
}
