import type { ContentBlock } from '../../shared/types';
import type { RemoteConversation, RemoteMessage } from '../types';
import type { ConversationDetail } from './schema';

/**
 * Turns claude.ai's conversation into what the app stores. Only the branch that is on screen is kept (the chain from
 * the current leaf up through `parent_message_uuid`; edits and retries are other branches). Text is kept; thinking,
 * tool calls and tool results are left out and only counted, by name, in `skipped`.
 */
export function parseConversation(
  detail: ConversationDetail,
  remoteId: string,
  projectName: (uuid: string) => string | undefined,
): RemoteConversation {
  const byId = new Map(detail.chat_messages.map((m) => [m.uuid, m]));
  let chain = detail.chat_messages;
  const leaf = detail.current_leaf_message_uuid;
  if (leaf && byId.has(leaf)) {
    const path: typeof chain = [];
    const seen = new Set<string>();
    for (let cur = byId.get(leaf); cur && !seen.has(cur.uuid);) {
      seen.add(cur.uuid);
      path.push(cur);
      cur = cur.parent_message_uuid ? byId.get(cur.parent_message_uuid) : undefined;
    }
    chain = path.reverse();
  }

  const skipped: Record<string, number> = {};
  const skip = (kind: string, n = 1) => {
    skipped[kind] = (skipped[kind] ?? 0) + n;
  };
  const messages: RemoteMessage[] = [];
  for (const m of chain) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
    if (!role) {
      skip(`sender:${m.sender}`);
      continue;
    }
    const blocks: ContentBlock[] = [];
    if (m.content && m.content.length > 0) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text?.trim()) blocks.push({ type: 'text', text: b.text });
        else if (b.type !== 'text') skip(`block:${b.type}`);
      }
    } else if (m.text?.trim()) {
      blocks.push({ type: 'text', text: m.text });
    }
    if (m.files?.length) skip('files', m.files.length);
    if (m.attachments?.length) skip('attachments', m.attachments.length);
    if (blocks.length > 0) messages.push({ role, blocks, createdAt: m.created_at });
  }

  const project = detail.project_uuid ?? undefined;
  const name = project ? projectName(project) : undefined;
  return {
    remoteId,
    remoteTitle: detail.name?.trim() || 'Untitled',
    ...(project ? { projectRemoteId: project, projectName: name ?? 'Project' } : {}),
    ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
    createdAt: detail.created_at,
    updatedAt: detail.updated_at,
    messages,
  };
}
