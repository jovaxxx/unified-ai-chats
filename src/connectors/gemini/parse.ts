import type { ContentBlock } from '../../shared/types';
import { EndpointChanged } from '../errors';
import type { RemoteConversation, RemoteImage, RemoteMessage } from '../types';

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
  /** Links to the images of the answer, in order, as Gemini's own image host gives them. */
  images: string[];
  /** The generated videos of the answer: the file to play and the still to show before it plays. */
  videos: { video: string; poster?: string }[];
}

const MAX_DEPTH = 14;
const MAX_NODES = 200_000;
const CHAT_ID = /^c_[A-Za-z0-9_-]{6,}$/;
const RESPONSE_ID = /^r_[A-Za-z0-9_-]{6,}$/;

const TITLE_MAX = 100;

/** A title for the list: the first line, spaces collapsed, cut at a word. Gemini may send a whole prompt as the title. */
export function cleanTitle(raw: string): string {
  const line =
    raw
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l !== '') ?? '';
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > TITLE_MAX * 0.6 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

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
    out.push({ id, title: cleanTitle(title), updatedAt });
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
    out.push({
      chatId,
      responseId,
      at,
      user: userText(a[2]),
      assistant: assistantText(a[3]),
      images: imageLinks(a[3]),
      videos: videoLinks(a[3]),
    });
    return true;
  });
  return out;
}

/** Gemini's own image host: `lh3.googleusercontent.com` and the like. Nothing else is ever treated as an image. */
export function isImageLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com'))
    );
  } catch {
    return false;
  }
}

/** The only place a generated video can be downloaded from: Google's user-content download address. */
export function isVideoLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4000) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'contribution.usercontent.google.com' &&
      u.pathname.startsWith('/download')
    );
  } catch {
    return false;
  }
}

/** The mark that keeps a video, and its still, apart from pictures in the database. */
export const VIDEO_MARK = '#video';
export const POSTER_MARK = '#poster';

/**
 * The videos of an answer. A video is described by a list whose position 11 says `video/…` and whose position 7 holds
 * its links: the still(s) on Gemini's image host and the download address. From a structure report recorded on a real
 * account (types and positions only): NOT yet run against a real video.
 */
function videoLinks(part: unknown): { video: string; poster?: string }[] {
  const out: { video: string; poster?: string }[] = [];
  let nodes = 0;
  const go = (v: unknown, depth: number) => {
    if (typeof v !== 'object' || v === null || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    if (Array.isArray(v)) {
      const mime = v[11];
      const links = v[7];
      if (typeof mime === 'string' && /^video\//i.test(mime) && Array.isArray(links)) {
        const video = links.find(isVideoLink);
        const poster = links.find(isImageLink);
        if (video && !out.some((o) => o.video === video))
          out.push({ video, ...(poster ? { poster } : {}) });
        return;
      }
    }
    // Lists and keyed objects alike: the report shows a keyed object on the way to the description of a video.
    for (const child of Array.isArray(v) ? v : Object.values(v)) go(child, depth + 1);
  };
  go(part, 0);
  return out;
}

/**
 * The images of an answer. Each is described by a list with its link at position 3; when one list holds two such
 * descriptions (the picture and a second size of it, by the look of the report), only the first is taken.
 * NOT confirmed on a real account: the report shows the positions, not the links.
 */
function imageLinks(part: unknown): string[] {
  const out: string[] = [];
  let nodes = 0;
  const go = (v: unknown, depth: number) => {
    if (typeof v !== 'object' || v === null || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    let taken = false;
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (Array.isArray(child) && isImageLink(child[3])) {
        if (!taken) {
          taken = true;
          if (!out.includes(child[3])) out.push(child[3]);
        }
        continue;
      }
      go(child, depth + 1);
    }
  };
  go(part, 0);
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

const PLACEHOLDER =
  /(?:\[[^\]]*\]\()?https?:\/\/googleusercontent\.com\/(image_generation_content|generated_video_content)\/\d+\)?/g;

/**
 * Gemini's text points at its pictures and videos with made-up links (`googleusercontent.com/image_generation_content/0`)
 * that lead nowhere. They are taken out: the pictures come as images, a video as a short note.
 */
export function withoutPlaceholders(text: string): {
  text: string;
  images: number;
  videos: number;
} {
  let images = 0;
  let videos = 0;
  const cleaned = text
    .replace(PLACEHOLDER, (_all, kind: string) => {
      if (kind === 'image_generation_content') {
        images++;
        return '';
      }
      videos++;
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, images, videos };
}

const VIDEO_NOTE = '(A video was generated here: open this chat on Gemini to watch it.)';

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
  const images = new Map<string, RemoteImage>();
  const skipped: Record<string, number> = {};
  const skip = (kind: string, n = 1) => {
    skipped[kind] = (skipped[kind] ?? 0) + n;
  };
  for (const t of turns) {
    if (t.user.trim())
      messages.push({ role: 'user', blocks: [{ type: 'text', text: t.user }], createdAt: t.at });
    const reply = withoutPlaceholders(t.assistant);
    const blocks: ContentBlock[] = [];
    if (reply.text) blocks.push({ type: 'text', text: reply.text });
    for (const ref of t.images) {
      blocks.push({ type: 'image', ref });
      if (!images.has(ref)) images.set(ref, { ref, kind: 'generated' });
    }
    for (const v of t.videos) {
      const ref = `${v.video}${VIDEO_MARK}`;
      const poster = v.poster ? `${v.poster}${POSTER_MARK}` : undefined;
      blocks.push({ type: 'video', ref, ...(poster ? { poster } : {}) });
      images.set(ref, { ref, kind: 'generated', ...(poster ? { poster } : {}) });
      if (poster) images.set(poster, { ref: poster, kind: 'generated' });
    }
    // Pictures the text pointed at but whose links were not found: counted, never hidden.
    if (reply.images > t.images.length)
      skip('images:link-not-found', reply.images - t.images.length);
    // A video the text pointed at but whose file was not found: said in the chat, counted, never hidden.
    if (reply.videos > t.videos.length) {
      skip('videos:link-not-found', reply.videos - t.videos.length);
      blocks.splice(reply.text ? 1 : 0, 0, { type: 'text', text: VIDEO_NOTE });
    }
    if (blocks.length > 0) messages.push({ role: 'assistant', blocks, createdAt: t.at });
  }
  const firstUser =
    turns
      .find((t) => t.user.trim())
      ?.user.trim()
      .split('\n')[0] ?? '';
  const title = cleanTitle(listed?.title ?? '') || cleanTitle(firstUser) || 'Untitled';
  const last = turns[turns.length - 1]!.at;
  return {
    remoteId,
    remoteTitle: title,
    // A full page of turns may not be the whole chat: counted, never hidden.
    ...(turns.length >= TURNS_PER_PAGE ? { skipped: { ...skipped, 'turns:maybe-more': 1 } } : {}),
    ...(turns.length < TURNS_PER_PAGE && Object.keys(skipped).length > 0 ? { skipped } : {}),
    ...(images.size > 0 ? { images: [...images.values()] } : {}),
    createdAt: turns[0]!.at,
    updatedAt: listed?.updatedAt ?? last,
    messages,
  };
}
