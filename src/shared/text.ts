/**
 * Turns Markdown into one plain line for list previews ("## Title\n**bold** and `code`" → "Title bold and code").
 * Not a full parser: good enough for a 160-character teaser.
 */
export function stripMarkdown(input: string): string {
  return input
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
