import type { Platform } from '../shared/types';

/**
 * Where to send the user to open a chat on its platform.
 * The per-chat URL shapes are what these sites use today but have NOT been verified against real
 * accounts yet and can change at any time (see docs/architecture.md). Only these hosts are ever opened.
 */
const HOME: Record<Platform, string> = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/',
  gemini: 'https://gemini.google.com/',
  'claude-code': '',
};

const CHAT_URL: Record<Platform, ((remoteId: string) => string) | null> = {
  chatgpt: (id) => `https://chatgpt.com/c/${encodeURIComponent(id)}`,
  claude: (id) => `https://claude.ai/chat/${encodeURIComponent(id)}`,
  gemini: (id) => `https://gemini.google.com/app/${encodeURIComponent(id)}`,
  'claude-code': null,
};

/** Returns an https URL for the platform (or one of its chats), or null if there is none (local-only sources). */
export function platformUrl(platform: Platform, remoteId?: string): string | null {
  if (remoteId) {
    const build = CHAT_URL[platform];
    return build ? build(remoteId) : null;
  }
  return HOME[platform] || null;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quote escaping: safe to paste into a shell whatever the path contains. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that resumes a chat in the tool that owns it. Only Claude Code sessions have one.
 * NOTE: `claude --resume <session id>` run from the session's own folder is how Claude Code resumes
 * a session, to the best of our knowledge; it has not been verified against every version.
 * The folder comes from a file on disk, so it is quoted, and anything with a control character is refused.
 */
export function resumeCommand(
  platform: Platform,
  remoteId: string,
  cwd: string | null,
): string | null {
  if (platform !== 'claude-code' || !cwd) return null;
  const sessionId = remoteId.split('/').at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  if (!SAFE_ID.test(sessionId) || /[\u0000-\u001f\u007f]/.test(cwd)) return null;
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}
