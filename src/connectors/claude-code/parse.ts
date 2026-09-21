import { basename } from 'node:path';
import { z } from 'zod';
import { EndpointChanged } from '../errors';
import type { RemoteConversation, RemoteMessage } from '../types';
import type { ContentBlock } from '../../shared/types';

/**
 * Parser for the JSONL session files Claude Code keeps under ~/.claude/projects/<project>/<session>.jsonl.
 *
 * The format is not a documented API and can change. Field names below were observed on a real
 * installation (structure only) and are NOT guaranteed: every relevant line is validated, and a line
 * that no longer matches raises EndpointChanged instead of being guessed at.
 *
 * Lines we do not need (queue-operation, attachment, system, last-prompt, mode, …) are ignored.
 */

const contentBlock = z.looseObject({ type: z.string() });

const messageLine = z.looseObject({
  type: z.enum(['user', 'assistant']),
  uuid: z.string(),
  parentUuid: z.string().nullable().optional(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  cwd: z.string().optional(),
  message: z.looseObject({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(contentBlock)]),
  }),
});

/**
 * Any line that can sit in the parent chain. In real sessions the chain runs THROUGH lines that are
 * not messages (attachments, system notices, compaction boundaries): walking only user/assistant
 * lines breaks the chain almost immediately and drops most of the conversation.
 * `logicalParentUuid` is used by a compaction boundary, whose `parentUuid` is null.
 */
const chainNode = z.looseObject({
  uuid: z.string(),
  parentUuid: z.string().nullable().optional(),
  logicalParentUuid: z.string().nullable().optional(),
});

const aiTitleLine = z.looseObject({ type: z.literal('ai-title'), aiTitle: z.string() });
const customTitleLine = z.looseObject({ type: z.literal('custom-title'), customTitle: z.string() });

type Entry = z.infer<typeof messageLine>;

const MAX_TOOL_SUMMARY = 300;
const MAX_TITLE = 80;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A compact, human-readable line for a tool call: `Bash: ls -la`. Never the full input. */
function summarizeToolUse(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input;
  let detail = '';
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    const pick = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query'].find(
      (k) => typeof rec[k] === 'string',
    );
    detail = pick ? String(rec[pick]) : '';
  }
  return detail ? `${name}: ${oneLine(detail, MAX_TOOL_SUMMARY)}` : name;
}

function toBlocks(entry: Entry): ContentBlock[] {
  const content = entry.message.content;
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    const rec = b as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof rec.text === 'string' && rec.text.trim())
          out.push({ type: 'text', text: rec.text });
        break;
      case 'tool_use':
        out.push({ type: 'code', lang: 'tool', text: summarizeToolUse(rec) });
        break;
      case 'image':
        out.push({ type: 'text', text: '[image]' });
        break;
      // 'thinking' and 'tool_result' are deliberately not shown: reasoning is internal, and tool
      // output can be huge and is not part of the conversation the user had.
      default:
        break;
    }
  }
  return out;
}

export interface ParseOptions {
  /** Session id (the file name without .jsonl). */
  sessionId: string;
  /** Folder name under ~/.claude/projects, used as the stable project id. */
  projectDir: string;
  /** Used when a session has no timestamps at all. */
  fallbackTime: string;
}

/** The home folder itself, or Documents / Desktop / Downloads directly inside it: not a project. */
export function isGenericFolder(cwd: string): boolean {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const first = parts[0]?.toLowerCase();
  // /Users/name, /home/name, C:\Users\name
  const at =
    first === 'users' || first === 'home' ? 0 : parts[1]?.toLowerCase() === 'users' ? 1 : -1;
  if (at < 0) return false;
  const rest = parts.slice(at + 2);
  return (
    rest.length === 0 || (rest.length === 1 && /^(documents|desktop|downloads)$/i.test(rest[0]!))
  );
}

export function parseSession(text: string, opts: ParseOptions): RemoteConversation {
  const lines = text.split('\n');
  const entries: Entry[] = [];
  const parents = new Map<string, string | null>();
  let aiTitle: string | undefined;
  let customTitle: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // A session that is still being written can end mid-line; anything else is a real problem.
      if (lines.slice(i + 1).every((l) => !l.trim())) break;
      throw new EndpointChanged(`${opts.sessionId}: line ${i + 1} is not valid JSON`);
    }
    const type = (json as { type?: unknown } | null)?.type;
    const node = chainNode.safeParse(json);
    if (node.success) {
      parents.set(node.data.uuid, node.data.parentUuid ?? node.data.logicalParentUuid ?? null);
    }
    if (type === 'user' || type === 'assistant') {
      const parsed = messageLine.safeParse(json);
      if (!parsed.success) {
        throw new EndpointChanged(
          `${opts.sessionId}: line ${i + 1} no longer matches the expected ${String(type)} shape (${parsed.error.issues[0]?.path.join('.') ?? '?'})`,
        );
      }
      entries.push(parsed.data);
    } else if (type === 'ai-title') {
      const p = aiTitleLine.safeParse(json);
      if (p.success) aiTitle = p.data.aiTitle;
    } else if (type === 'custom-title') {
      const p = customTitleLine.safeParse(json);
      if (p.success) customTitle = p.data.customTitle;
    }
  }

  // The active branch: walk from the last main-thread message back to the root through parent links,
  // passing through non-message lines. Sidechains (sub-agents) and abandoned branches (edits,
  // rewinds) are not on this path, so they are left out.
  const main = entries.filter((e) => !e.isSidechain && !e.isMeta);
  const byId = new Map(entries.map((e) => [e.uuid, e]));
  const chain: Entry[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = main[main.length - 1]?.uuid;
  while (id && !seen.has(id)) {
    seen.add(id);
    const e = byId.get(id);
    if (e && !e.isSidechain && !e.isMeta) chain.push(e);
    // A parent missing from the file (e.g. a very old truncated session) simply ends the chain.
    id = parents.get(id);
  }
  chain.reverse();

  // Claude Code writes one assistant line per content block; merge consecutive same-role lines.
  const messages: RemoteMessage[] = [];
  for (const e of chain) {
    const blocks = toBlocks(e);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === e.message.role) last.blocks.push(...blocks);
    else messages.push({ role: e.message.role, blocks, createdAt: e.timestamp });
  }

  const firstUser = messages.find((m) => m.role === 'user')?.blocks.find((b) => b.type === 'text');
  const firstPrompt = firstUser ? oneLine(firstUser.text, MAX_TITLE) : '';
  const remoteTitle = oneLine(aiTitle ?? '', MAX_TITLE) || firstPrompt || 'Untitled session';
  const custom = customTitle ? oneLine(customTitle, MAX_TITLE) : '';

  const times = entries.map((e) => e.timestamp).sort();
  const cwd = entries.find((e) => e.cwd)?.cwd;

  return {
    remoteId: opts.sessionId,
    remoteTitle,
    ...(custom && custom !== remoteTitle ? { customTitle: custom } : {}),
    // A session started in the home folder or a generic one (Documents, Desktop, Downloads) belongs to no project.
    ...(cwd && isGenericFolder(cwd)
      ? {}
      : {
          projectRemoteId: opts.projectDir,
          projectName: cwd ? basename(cwd) || cwd : opts.projectDir,
        }),
    ...(cwd ? { cwd } : {}),
    createdAt: times[0] ?? opts.fallbackTime,
    updatedAt: times[times.length - 1] ?? opts.fallbackTime,
    messages,
  };
}
