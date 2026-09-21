import { z } from 'zod';

/**
 * Response shapes of ChatGPT's web API, as recorded by the structure recorder (docs/architecture.md).
 * Only the fields we use are required; everything else is allowed and ignored (`looseObject`), so new
 * fields never break us, but a required field disappearing or changing type raises EndpointChanged.
 *
 * NOT an official API: it can change without notice.
 */

/** GET /api/auth/session */
export const sessionSchema = z.looseObject({
  accessToken: z.string().min(10),
  user: z.looseObject({ id: z.string().min(1) }),
});

const conversationItemSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullable(),
  create_time: z.string(),
  update_time: z.string(),
  gizmo_id: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
});
export type ConversationItem = z.infer<typeof conversationItemSchema>;

/** GET /backend-api/conversations?offset&limit&order&is_archived */
export const conversationPageSchema = z.looseObject({
  items: z.array(conversationItemSchema),
  total: z.number().nullable().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

/** GET /backend-api/gizmos/<project id>/conversations?cursor&limit */
export const projectConversationPageSchema = z.looseObject({
  items: z.array(conversationItemSchema),
  cursor: z.string().nullable().optional(),
});

/** One project in GET /backend-api/gizmos/snorlax/sidebar. Other kinds of item are ignored. */
export const sidebarProjectSchema = z.looseObject({
  gizmo: z.looseObject({
    gizmo: z.looseObject({
      id: z.string().min(1),
      display: z.looseObject({ name: z.string() }),
    }),
  }),
});
export const sidebarSchema = z.looseObject({
  items: z.array(z.unknown()),
  cursor: z.string().nullable().optional(),
});

const messageSchema = z.looseObject({
  author: z.looseObject({ role: z.string() }),
  create_time: z.number().nullable().optional(),
  content: z
    .looseObject({
      content_type: z.string(),
      parts: z.array(z.unknown()).optional(),
      text: z.string().optional(),
      language: z.string().optional(),
    })
    .optional(),
  recipient: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  weight: z.number().optional(),
});
export type ChatGptMessage = z.infer<typeof messageSchema>;

const nodeSchema = z.looseObject({
  id: z.string(),
  message: messageSchema.nullable().optional(),
  parent: z.string().nullable().optional(),
});

/** GET /backend-api/conversation/<id>: a tree of messages plus the id of the last one on the active branch. */
export const conversationDetailSchema = z.looseObject({
  title: z.string().nullable(),
  create_time: z.number(),
  update_time: z.number(),
  conversation_id: z.string().optional(),
  gizmo_id: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
  current_node: z.string().nullable(),
  mapping: z.record(z.string(), nodeSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/** GET /backend-api/files/download/<file id>: a short-lived signed link to the file. */
export const fileDownloadSchema = z.looseObject({
  status: z.string().optional(),
  download_url: z.string().url(),
});

/**
 * GET /backend-api/pins: what the user pinned ("Bloccate"). Each entry is either a chat (`id`, `update_time`) or a
 * project/folder (`gizmo`). Anything else is ignored.
 */
export const pinsSchema = z.array(
  z.looseObject({
    item: z.looseObject({
      id: z.string().optional(),
      update_time: z.string().optional(),
      gizmo: z
        .looseObject({ id: z.string().min(1), display: z.looseObject({ name: z.string() }) })
        .optional(),
    }),
  }),
);
export { conversationItemSchema };
