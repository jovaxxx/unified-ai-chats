import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EndpointChanged, NotFound } from '../errors';
import type {
  AccountContext,
  Connector,
  RemoteConversation,
  RemoteConversationSummary,
} from '../types';
import { parseSession } from './parse';

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Default location of Claude Code's sessions. Nothing here reads outside the given root. */
export function defaultClaudeCodeRoot(homeDir: string): string {
  return join(homeDir, '.claude', 'projects');
}

function rootOf(ctx: AccountContext): string {
  if (!ctx.root) throw new Error('claude-code connector needs ctx.root');
  return ctx.root;
}

/** remoteId is `<projectDir>/<sessionId>`, so two projects can never collide. */
function split(remoteId: string): { projectDir: string; sessionId: string } {
  const [projectDir, sessionId, ...rest] = remoteId.split('/');
  if (
    !projectDir ||
    !sessionId ||
    rest.length > 0 ||
    !SESSION_ID.test(projectDir) ||
    !SESSION_ID.test(sessionId)
  ) {
    throw new NotFound(`Invalid session id`);
  }
  return { projectDir, sessionId };
}

export const claudeCodeConnector: Connector = {
  id: 'claude-code',
  // Read-only local source: nothing can be renamed/archived/deleted "at the source" from here.
  capabilities: { projects: true, archive: false, rename: false, delete: false, images: false },

  async checkSession(ctx) {
    try {
      await readdir(rootOf(ctx));
      return 'ok';
    } catch {
      return 'unknown';
    }
  },

  async *listConversations(ctx, since) {
    const root = rootOf(ctx);
    let projectDirs;
    try {
      projectDirs = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const dir of projectDirs) {
      if (!dir.isDirectory() || !SESSION_ID.test(dir.name)) continue;
      const files = await readdir(join(root, dir.name), { withFileTypes: true });
      // Only top-level *.jsonl: nested folders hold sub-agent transcripts, which are not chats.
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const sessionId = f.name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID.test(sessionId)) continue;
        const info = await stat(join(root, dir.name, f.name));
        if (since && info.mtime <= since) continue;
        const summary: RemoteConversationSummary = {
          remoteId: `${dir.name}/${sessionId}`,
          remoteUpdatedAt: info.mtime.toISOString(),
        };
        yield summary;
      }
    }
  },

  async getConversation(ctx, remoteId): Promise<RemoteConversation> {
    const { projectDir, sessionId } = split(remoteId);
    const path = join(rootOf(ctx), projectDir, `${sessionId}.jsonl`);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new NotFound(`Session ${sessionId} not found`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new EndpointChanged(
        `${sessionId}: file is larger than ${MAX_FILE_BYTES} bytes, skipped`,
      );
    }
    const parsed = parseSession(await readFile(path, 'utf8'), {
      sessionId,
      projectDir,
      fallbackTime: info.mtime.toISOString(),
    });
    return { ...parsed, remoteId };
  },
};
