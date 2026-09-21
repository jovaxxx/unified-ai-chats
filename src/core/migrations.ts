/**
 * Ordered schema migrations. The applied version is stored in `PRAGMA user_version`.
 * Never edit a migration that has shipped: append a new one.
 */
export const migrations: string[] = [
  /* 1: initial schema. */
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL CHECK (platform IN ('chatgpt','claude','gemini','claude-code')),
    label TEXT NOT NULL,
    identity_hint TEXT,
    partition TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_attention')),
    last_sync_at TEXT,
    -- writes to the platform are off by default, per account.
    allow_remote_changes INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (account_id, remote_id)
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    remote_title TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    preview TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'inbox'
      CHECK (state IN ('inbox','archived','trashed_local','deleted_remote')),
    state_before_trash TEXT CHECK (state_before_trash IN ('inbox','archived')),
    trash_purge_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    remote_updated_at TEXT NOT NULL,
    UNIQUE (account_id, remote_id)
  );
  CREATE INDEX conversations_state_updated ON conversations (state, remote_updated_at DESC);
  CREATE INDEX conversations_account ON conversations (account_id, state);
  CREATE INDEX conversations_project ON conversations (project_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    remote_id TEXT,
    parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_active_branch INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX messages_conversation ON messages (conversation_id, id);

  CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    local_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL
  );

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE conversation_tags (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );

  CREATE TABLE action_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','running','done','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after TEXT,
    last_error TEXT
  );

  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    stats_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Full-text index. rowid = conversations.id. Maintained by the repository, not by triggers,
  -- because \`body\` is derived from the messages.
  CREATE VIRTUAL TABLE conversations_fts USING fts5(
    title, remote_title, summary, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  /* 2: remember the title as the source presents it, so a re-import can tell whether the user
        renamed the chat locally (title != source_title) and must not overwrite that. */
  `
  ALTER TABLE conversations ADD COLUMN source_title TEXT;
  UPDATE conversations SET source_title = title;
  `,
  /* 3: keep the working directory of a source session (to build a "resume" command), and force a full
        re-import of local sessions: earlier versions of the parser dropped most of each conversation and
        an incremental sync would never re-read files that did not change. */
  `
  ALTER TABLE conversations ADD COLUMN cwd TEXT;
  UPDATE accounts SET last_sync_at = NULL WHERE platform = 'claude-code';
  `,
  /* 4: conversations the user deleted for good from this app. They still exist at the source, so a sync must
        know not to bring them back. */
  `
  CREATE TABLE ignored_conversations (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    removed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, remote_id)
  );
  `,
  /* 5: the order profiles are shown in, chosen by the user (starts as creation order). */
  `
  ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
  UPDATE accounts SET sort_order = id;
  `,
  /* 6: images. The media table of migration 1 was never used, so it is rebuilt: a row per image reference in a
        conversation, downloaded later (pending -> done | failed), stored under the app's media folder. */
  `
  DROP TABLE media;
  CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('generated','uploaded')),
    alt TEXT,
    width INTEGER,
    height INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    local_path TEXT,
    sha256 TEXT,
    mime TEXT,
    bytes INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, ref)
  );
  CREATE INDEX media_conversation ON media (conversation_id);
  CREATE INDEX media_status ON media (status, kind);
  `,
  /* 7: which version of the importer read each conversation. When importers learn to keep more (images, voice,
        ...), conversations read by an older one are read again once; rows from before this migration are version 0. */
  `
  ALTER TABLE conversations ADD COLUMN parse_version INTEGER NOT NULL DEFAULT 0;
  `,
  /* 8: actions to perform on a platform (rename, archive, delete). The queue table of migration 1 was never used:
        it now records the platform's own id for the conversation (the local row may be gone by the time it runs),
        when it was queued and finished. */
  `
  ALTER TABLE action_queue ADD COLUMN remote_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE action_queue ADD COLUMN created_at TEXT;
  ALTER TABLE action_queue ADD COLUMN finished_at TEXT;
  CREATE INDEX action_queue_status ON action_queue (status, run_after);
  CREATE INDEX action_queue_conversation ON action_queue (conversation_id);
  `,
  /* 9: Claude Code sessions that ran directly in a generic folder (Documents, Desktop, Downloads) are not part of a
        project: they were wrongly filed under a project named after that folder. They go back to plain chats. */
  `
  UPDATE conversations SET project_id = NULL
   WHERE project_id IN (SELECT p.id FROM projects p JOIN accounts a ON a.id = p.account_id
                         WHERE a.platform = 'claude-code' AND p.name IN ('Documents','Desktop','Downloads'));
  DELETE FROM projects
   WHERE account_id IN (SELECT id FROM accounts WHERE platform = 'claude-code')
     AND name IN ('Documents','Desktop','Downloads');
  `,
];
