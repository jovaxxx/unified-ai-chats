import type { ContentBlock } from '../../shared/types';
import { EndpointChanged } from '../errors';
import type { RemoteConversation, RemoteMessage } from '../types';

/**
 * Gemini answers with unnamed, position-based arrays. These functions find what the app needs by what it looks like
 * (an id that starts with `c_`, a `[seconds, nanoseconds]` pair, …), wherever the answer nests it, from the
 * structure report recorded on a real account. Anything that does not look right is left out or reported; nothing is
 * guessed.
 */

export interface ListedChat {
  id: string;
  title: string;
  updatedAt: string;
}

export interface Turn {
  chatId: string;
  responseId: string;
  at: string;
  user: string;
  assistant: string;
}

const MAX_DEPTH = 14;
const MAX_NODES = 200_000;
const CHAT_ID = /^c_[A-Za-z0-9_-]{6,}$/;
const RESPONSE_ID = /^r_[A-Za-z0-9_-]{6,}$/;

/** `[1712345678, 123456000]` → ISO time. Null if it is not a plausible time. */
export function timeOf(pair: unknown): string | null {
  if (!Array.isArray(pair) || typeof pair[0] !== 'number') return null;
  const nanos = typeof pair[1] === 'number' ? pair[1] : 0;
  const ms = pair[0] * 1000 + Math.floor(nanos / 1_000_000);
  const d = new Date(ms);
  return Number.isFinite(ms) && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100
    ? d.toISOString()
    : null;
}

/** Calls `visit` for every array in the tree. `visit` returns true to say "this one is taken, do not look inside". */
function walk(root: unknown, visit: (a: unknown[]) => boolean): void {
  let nodes = 0;
  const go = (v: unknown, depth: number) => {
    if (!Array.isArray(v) || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    if (visit(v)) return;
    for (const child of v) go(child, depth + 1);
  };
  go(root, 0);
}

/** The chats in an answer to the chat-list call: `[ "c_…", title, null, null, null, [seconds, nanos], … ]`. */
export function findChats(payload: unknown): ListedChat[] {
  const out: ListedChat[] = [];
  walk(payload, (a) => {
    const [id, title] = a;
    const updatedAt = timeOf(a[5]);
    if (typeof id !== 'string' || !CHAT_ID.test(id) || typeof title !== 'string' || !updatedAt)
      return false;
    out.push({ id, title, updatedAt });
    return true;
  });
  return out;
}

/**
 * The turns in an answer to the read-a-chat call. A turn is `[ ["c_…","r_…"], null, [[ "what the user wrote" ], …],
 * [[ ["rc_…", [ "the answer" ], …] ], …, "rc_…"], [seconds, nanoseconds] ]`.
 */
export function findTurns(payload: unknown): Turn[] {
  const seen = new Set<string>();
  const out: Turn[] = [];
  walk(payload, (a) => {
    const ids = a[0];
    if (!Array.isArray(ids)) return false;
    const [chatId, responseId] = ids as unknown[];
    const at = timeOf(a[4]);
    if (
      typeof chatId !== 'string' ||
      !CHAT_ID.test(chatId) ||
      typeof responseId !== 'string' ||
      !RESPONSE_ID.test(responseId) ||
      !at
    )
      return false;
    if (seen.has(responseId)) return true;
    seen.add(responseId);
    out.push({ chatId, responseId, at, user: userText(a[2]), assistant: assistantText(a[3]) });
    return true;
  });
  return out;
}

function userText(part: unknown): string {
  const first = Array.isArray(part) ? part[0] : undefined;
  const text = Array.isArray(first) ? first[0] : undefined;
  return typeof text === 'string' ? text : '';
}

function assistantText(part: unknown): string {
  if (!Array.isArray(part) || !Array.isArray(part[0])) return '';
  const candidates = part[0] as unknown[];
  const chosen = part[3];
  const pick =
    candidates.find((c) => Array.isArray(c) && c[0] === chosen && typeof chosen === 'string') ??
    candidates[0];
  const body = Array.isArray(pick) ? pick[1] : undefined;
  const text = Array.isArray(body) ? body[0] : undefined;
  return typeof text === 'string' ? text : '';
}

/** What the read-a-chat call returns per page, as the site asks for it. A full page may mean there is more. */
export const TURNS_PER_PAGE = 10;

export function parseConversation(
  payload: unknown,
  remoteId: string,
  listed?: { title: string; updatedAt: string },
): RemoteConversation {
  const all = findTurns(payload);
  const turns = (
    all.some((t) => t.chatId === remoteId) ? all.filter((t) => t.chatId === remoteId) : all
  ).sort((a, b) => a.at.localeCompare(b.at));
  if (turns.length === 0)
    throw new EndpointChanged(
      'A Gemini chat no longer matches what was expected (no turns found).',
    );

  const messages: RemoteMessage[] = [];
  for (const t of turns) {
    const text = (s: string): ContentBlock[] => (s.trim() ? [{ type: 'text', text: s }] : []);
    if (t.user.trim()) messages.push({ role: 'user', blocks: text(t.user), createdAt: t.at });
    if (t.assistant.trim())
      messages.push({ role: 'assistant', blocks: text(t.assistant), createdAt: t.at });
  }
  const firstUser =
    turns
      .find((t) => t.user.trim())
      ?.user.trim()
      .split('\n')[0] ?? '';
  const title = listed?.title.trim() || (firstUser ? firstUser.slice(0, 80) : 'Untitled');
  const last = turns[turns.length - 1]!.at;
  return {
    remoteId,
    remoteTitle: title,
    // A full page of turns may not be the whole chat: counted, never hidden.
    ...(turns.length >= TURNS_PER_PAGE ? { skipped: { 'turns:maybe-more': 1 } } : {}),
    createdAt: turns[0]!.at,
    updatedAt: listed?.updatedAt ?? last,
    messages,
  };
}
