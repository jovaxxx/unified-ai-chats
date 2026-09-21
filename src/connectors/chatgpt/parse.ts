import type { ContentBlock } from '../../shared/types';
import type { RemoteConversation, RemoteImage, RemoteMessage } from '../types';
import type { ChatGptMessage, ConversationDetail } from './schema';

/** Content types that are the assistant's plumbing (tool output, retrieved context), not conversation. */
const HIDDEN_CONTENT = new Set([
  'model_editable_context',
  'tether_browsing_display',
  'execution_output',
  'system_error',
  'tether_quote',
]);

/** Content types the importer understands; when one of these comes out empty it is just an empty message. */
const HANDLED_CONTENT = new Set(['text', 'multimodal_text', 'code']);

/**
 * ChatGPT marks citations and entities inside text with private-use characters (U+E200 … U+E201).
 * UNVERIFIED against every case; removing the marked groups and any stray private-use character is safe
 * because those code points never carry real text.
 */
export function cleanText(text: string): string {
  return text.replace(/[^]*/g, '').replace(/[-]/g, '');
}

function isoFromSeconds(seconds: number | null | undefined, fallback: string): string {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : fallback;
}

function blocksOf(
  m: ChatGptMessage,
  fromTool: boolean,
  images: Map<string, RemoteImage>,
  kind: 'generated' | 'uploaded',
): ContentBlock[] {
  const c = m.content;
  if (!c || HIDDEN_CONTENT.has(c.content_type)) return [];
  switch (c.content_type) {
    case 'text':
    case 'multimodal_text': {
      const out: ContentBlock[] = [];
      const texts: string[] = [];
      const flush = () => {
        const t = cleanText(texts.join('\n')).trim();
        if (t) out.push({ type: 'text', text: t });
        texts.length = 0;
      };
      for (const part of c.parts ?? []) {
        if (typeof part === 'string') {
          if (!fromTool) texts.push(part); // a tool's own text ("1 image generated") is plumbing
        } else if (
          isImagePart(part) &&
          typeof part.asset_pointer === 'string' &&
          part.asset_pointer
        ) {
          flush();
          const ref = part.asset_pointer;
          const meta = (part.metadata ?? {}) as {
            dalle?: { prompt?: unknown };
            generation?: { prompt?: unknown };
          };
          const prompt = [meta.dalle?.prompt, meta.generation?.prompt].find(
            (x) => typeof x === 'string' && x.trim(),
          ) as string | undefined;
          const alt = prompt ? prompt.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
          const width = typeof part.width === 'number' ? part.width : undefined;
          const height = typeof part.height === 'number' ? part.height : undefined;
          out.push({ type: 'image', ref, ...(alt ? { alt } : {}) });
          if (!images.has(ref))
            images.set(ref, {
              ref,
              kind,
              ...(alt ? { alt } : {}),
              ...(width ? { width } : {}),
              ...(height ? { height } : {}),
            });
        } else if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          // Voice conversations keep what was said as transcription objects, not plain strings.
          if (!fromTool) texts.push((part as { text: string }).text);
        }
      }
      flush();
      return out;
    }
    case 'code':
      return typeof c.text === 'string' && c.text.trim()
        ? [
            {
              type: 'code',
              lang: c.language && c.language !== 'unknown' ? c.language : '',
              text: c.text,
            },
          ]
        : [];
    default:
      // Unknown kinds of content are skipped rather than guessed at.
      return [];
  }
}

/** Whether a message is something the user or the assistant actually said, in the visible conversation. */
function hasImage(m: ChatGptMessage): boolean {
  return (m.content?.parts ?? []).some((p) => isImagePart(p));
}

function isImagePart(
  part: unknown,
): part is { asset_pointer?: unknown; width?: unknown; height?: unknown; metadata?: unknown } {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { content_type?: unknown }).content_type === 'image_asset_pointer'
  );
}

function visibleRole(m: ChatGptMessage): 'user' | 'assistant' | null {
  const role = m.author.role;
  // A generated image arrives in a message from the image tool, not from the assistant: show it as the assistant's.
  if (role === 'tool' && hasImage(m) && (!m.recipient || m.recipient === 'all')) return 'assistant';
  if (role !== 'user' && role !== 'assistant') return null; // system and tool messages are plumbing
  if (m.weight === 0) return null; // hidden by ChatGPT itself
  if (m.recipient && m.recipient !== 'all') return null; // a call to a tool (python, browsing…), not a reply
  if (role === 'assistant' && m.channel === 'commentary') return null; // intermediate notes, not the answer
  return role;
}

/**
 * Turns ChatGPT's message tree into a transcript: walks from `current_node` (the last message of the
 * active branch) back to the root, so edited/regenerated branches that are not the current one are left out.
 */
export function parseConversation(
  detail: ConversationDetail,
  remoteId: string,
  projectName: (projectId: string) => string | undefined,
): RemoteConversation {
  const createdAt = isoFromSeconds(detail.create_time, new Date(0).toISOString());
  const updatedAt = isoFromSeconds(detail.update_time, createdAt);

  // Where the active branch ends. Normally `current_node`; if it is missing, the most recent message that
  // nothing follows (a chat is never shown empty just because that pointer is absent).
  const startId = ((): string | null => {
    if (detail.current_node && detail.mapping[detail.current_node]) return detail.current_node;
    let best: { id: string; t: number } | null = null;
    for (const [nodeId, node] of Object.entries(detail.mapping)) {
      if (node.message == null || (node as { children?: unknown[] }).children?.length) continue;
      const t = node.message.create_time ?? 0;
      if (!best || t >= best.t) best = { id: nodeId, t };
    }
    return best?.id ?? null;
  })();

  const walk = (from: string | null): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let id: string | null | undefined = from;
    while (id && !seen.has(id)) {
      seen.add(id);
      path.push(id);
      id = detail.mapping[id]?.parent;
    }
    return path.reverse();
  };
  let chain = walk(startId);

  const messages: RemoteMessage[] = [];
  const skipped: Record<string, number> = {};
  const images = new Map<string, RemoteImage>();
  const skip = (kind: string) => {
    skipped[kind] = (skipped[kind] ?? 0) + 1;
  };
  const collect = () => {
    for (const nodeId of chain) {
      const m = detail.mapping[nodeId]?.message;
      if (!m) continue;
      const role = visibleRole(m);
      if (!role) continue;
      const blocks = blocksOf(
        m,
        m.author.role === 'tool',
        images,
        role === 'user' ? 'uploaded' : 'generated',
      );
      if (blocks.length === 0) {
        // A message that should be visible but yielded nothing: note its KIND (never its content).
        const type = m.content?.content_type ?? 'no-content';
        // A text/code message with nothing in it is ordinary (ChatGPT has empty ones), not a gap.
        if (!HANDLED_CONTENT.has(type))
          skip(`${HIDDEN_CONTENT.has(type) ? 'hidden' : 'unhandled'}:${type}`);
        continue;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.blocks.push(...blocks);
      else messages.push({ role, blocks, createdAt: isoFromSeconds(m.create_time, updatedAt) });
    }
  };
  collect();

  // If following the branch produced nothing (a broken chain), fall back to every visible message in time order:
  // better a complete-looking transcript than an empty chat.
  if (messages.length === 0 && Object.keys(detail.mapping).length > 0) {
    const all = Object.entries(detail.mapping)
      .filter(([, n]) => n.message)
      .sort((a, b) => (a[1].message?.create_time ?? 0) - (b[1].message?.create_time ?? 0))
      .map(([nodeId]) => nodeId);
    chain = all;
    for (const k of Object.keys(skipped)) delete skipped[k]; // count each message once
    collect();
  }

  // Only projects (`g-p-…`); other `g-…` ids are custom GPTs, which are not folders.
  const gizmo = detail.gizmo_id ?? null;
  const projectId = gizmo && gizmo.startsWith('g-p-') ? gizmo : undefined;

  return {
    remoteId,
    remoteTitle: detail.title?.trim() || 'Untitled',
    ...(projectId
      ? { projectRemoteId: projectId, projectName: projectName(projectId) ?? 'Project' }
      : {}),
    ...(detail.is_archived ? { archived: true } : {}),
    ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
    ...(images.size > 0 ? { images: [...images.values()] } : {}),
    createdAt,
    updatedAt,
    messages,
  };
}
