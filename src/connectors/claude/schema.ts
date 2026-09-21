import { z } from 'zod';

/**
 * Response shapes of claude.ai's web API. The conversation, list and project shapes come from a structure report
 * recorded on a real account (docs/architecture.md). `/api/organizations` and `/api/account` are NOT in that report:
 * they are the calls unofficial clients have long used, so they are UNVERIFIED here. Only the fields we use are
 * required; anything else is ignored. NOT an official API: it can change without notice.
 */

/** GET /api/organizations (unverified): the organizations the account belongs to. */
export const organizationsSchema = z.array(
  z.looseObject({
    uuid: z.string().min(1),
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
  }),
);

/** GET /api/account (unverified): who is signed in. */
export const accountSchema = z.looseObject({ uuid: z.string().min(1) });

const conversationItem = z.looseObject({
  uuid: z.string().min(1),
  name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  project_uuid: z.string().nullable().optional(),
});
export type ConversationItem = z.infer<typeof conversationItem>;

/** GET /api/organizations/:org/chat_conversations_v2?limit&offset&archived */
export const conversationPageSchema = z.looseObject({
  // The recorder saw an empty entry in the list once, so anything that is not a conversation is dropped.
  data: z.array(z.unknown()),
  has_more: z.boolean().optional(),
});

export const parseConversationItem = (v: unknown): ConversationItem | null => {
  const r = conversationItem.safeParse(v);
  return r.success ? r.data : null;
};

const project = z.looseObject({ uuid: z.string().min(1), name: z.string() });
/** GET /api/organizations/:org/projects_v2?limit&offset&is_archived */
export const projectPageSchema = z.looseObject({
  data: z.array(z.unknown()),
  pagination: z.looseObject({ has_more: z.boolean().optional() }).optional(),
});
export const parseProject = (v: unknown): { uuid: string; name: string } | null => {
  const r = project.safeParse(v);
  return r.success ? { uuid: r.data.uuid, name: r.data.name } : null;
};

const block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});
const message = z.looseObject({
  uuid: z.string().min(1),
  sender: z.string(),
  text: z.string().optional(),
  content: z.array(block).optional(),
  created_at: z.string(),
  parent_message_uuid: z.string().nullable().optional(),
  files: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
});

/** GET /api/organizations/:org/chat_conversations/:id?tree=True&rendering_mode=messages&render_all_tools=true */
export const conversationDetailSchema = z.looseObject({
  uuid: z.string().min(1),
  name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  is_starred: z.boolean().optional(),
  project_uuid: z.string().nullable().optional(),
  current_leaf_message_uuid: z.string().nullable().optional(),
  chat_messages: z.array(message),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
