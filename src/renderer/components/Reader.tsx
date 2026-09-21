import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatDetail, ContentBlock } from '../../shared/types';
import { daysUntil } from '../format';
import { Icon } from './Icon';
import { Lightbox, StoredImage } from './Lightbox';
import { Markdown } from './Markdown';
import { PlatformLogo } from './PlatformLogo';

interface Props {
  chat: ChatDetail | null;
  missing: boolean;
  now: Date;
  onOpenPlatform: (chat: ChatDetail) => void;
  onRename: (id: number, title: string) => void;
  onAction: (id: number, type: 'archive' | 'unarchive' | 'trash' | 'restore') => void;
  onAddTag: (id: number, tag: string) => void;
  onRemoveTag: (id: number, tag: string) => void;
  onPurge: (id: number) => void;
}

export function Reader({
  chat,
  missing,
  now,
  onOpenPlatform,
  onRename,
  onAction,
  onAddTag,
  onRemoveTag,
  onPurge,
}: Props) {
  const { t, i18n } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [viewing, setViewing] = useState<{ mediaId: number; alt: string | null } | null>(null);
  const [copyError, setCopyError] = useState(false);
  // Opening a chat lands on its last message. Images above it can grow after they load, so the view keeps
  // following the end until the reader scrolls by themselves.
  const bodyRef = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const toEnd = () => {
    const el = bodyRef.current;
    if (el && followEnd.current) el.scrollTop = el.scrollHeight;
  };
  const chatId = chat?.id ?? null;
  useEffect(() => {
    followEnd.current = true;
    toEnd();
  }, [chatId]);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  if (missing) {
    return (
      <section className="reader" aria-label={t('reader.label')}>
        <div className="reader-empty">{t('reader.notFound')}</div>
      </section>
    );
  }
  if (!chat) {
    return (
      <section className="reader" aria-label={t('reader.label')}>
        <div className="reader-empty">{t('reader.empty')}</div>
      </section>
    );
  }

  const platformName = t(`platforms.${chat.platform}`);
  const trashed = chat.state === 'trashed_local';
  const canOpen = chat.platform !== 'claude-code';
  const purgeDays = chat.trashPurgeAt ? daysUntil(chat.trashPurgeAt, now) : 0;
  const created = new Date(chat.createdAt);
  const updated = new Date(chat.updatedAt);
  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
  const range =
    fmt.format(created) === fmt.format(updated)
      ? fmt.format(updated)
      : `${fmt.format(created)} – ${fmt.format(updated)}`;

  const copyResume = async (command: string | null) => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError(true);
    }
  };

  const saveRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.trim() && draft.trim() !== chat.title) onRename(chat.id, draft.trim());
    setRenaming(false);
  };
  const saveTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (tagDraft.trim()) onAddTag(chat.id, tagDraft.trim());
    setTagDraft('');
    setAddingTag(false);
  };

  return (
    <section className="reader" aria-label={t('reader.label')}>
      <header className="reader-head">
        <div className="crumbs">
          <PlatformLogo platform={chat.platform} />
          <span>{platformName}</span>
          <span aria-hidden="true">›</span>
          <span>{chat.accountLabel}</span>
          {chat.projectName && (
            <>
              <span aria-hidden="true">›</span>
              <span>{t('nav.projects')}</span>
              <span aria-hidden="true">›</span>
              <strong>{chat.projectName}</strong>
            </>
          )}
        </div>

        {renaming ? (
          <form className="rename" onSubmit={saveRename}>
            <input
              ref={renameRef}
              aria-label={t('reader.renameLabel')}
              value={draft}
              maxLength={300}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
            />
            <button type="submit" className="btn btn--primary">
              {t('reader.renameSave')}
            </button>
            <button type="button" className="btn" onClick={() => setRenaming(false)}>
              {t('reader.renameCancel')}
            </button>
          </form>
        ) : (
          <h1 className="reader-title">{chat.title}</h1>
        )}

        <div className="reader-meta">
          {chat.remoteTitle !== chat.title && (
            <>{t('reader.originalTitle', { title: chat.remoteTitle })} · </>
          )}
          {t('reader.messages', { count: chat.messageCount })} · {range}
        </div>
        {copied && (
          <div className="notice notice--ok" role="status">
            {t('reader.resumeHint')}
          </div>
        )}
        {copyError && (
          <div className="form-error" role="alert">
            {t('reader.resumeFailed')}
          </div>
        )}
        {trashed && (
          <div className="notice">
            {t('reader.inTrash', { count: purgeDays, platform: platformName })}
          </div>
        )}
        {chat.state === 'archived' && <div className="notice">{t('reader.inArchive')}</div>}
        {chat.remoteSync === 'pending' && (
          <div className="notice" role="status">
            {t('reader.remotePending', { platform: platformName })}
          </div>
        )}
        {chat.remoteSync === 'failed' && (
          <div className="form-error" role="alert">
            {t('reader.remoteFailed', { platform: platformName })}
          </div>
        )}

        <div className="actions">
          {canOpen ? (
            <button type="button" className="btn btn--primary" onClick={() => onOpenPlatform(chat)}>
              {t('reader.openOn', { platform: platformName })}
              <Icon name="external" size="sm" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!chat.resumeCommand}
              title={chat.resumeCommand ? chat.resumeCommand : t('reader.resumeUnavailable')}
              onClick={() => void copyResume(chat.resumeCommand)}
            >
              {copied ? t('reader.resumeCopied') : t('reader.resumeCopy')}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft(chat.title);
              setRenaming(true);
            }}
          >
            <Icon name="pencil" size="sm" />
            {t('reader.rename')}
          </button>
          {trashed ? (
            <>
              <button type="button" className="btn" onClick={() => onAction(chat.id, 'restore')}>
                {t('reader.restore')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => onPurge(chat.id)}>
                <Icon name="trash" size="sm" />
                {t('trash.deleteNow')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  onAction(chat.id, chat.state === 'archived' ? 'unarchive' : 'archive')
                }
              >
                <Icon name="archive" size="sm" />
                {chat.state === 'archived' ? t('reader.unarchive') : t('reader.archive')}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => onAction(chat.id, 'trash')}
              >
                <Icon name="trash" size="sm" />
                {t('reader.delete')}
              </button>
            </>
          )}
        </div>
      </header>

      <div
        className="reader-body"
        ref={bodyRef}
        onLoadCapture={toEnd}
        onWheel={() => (followEnd.current = false)}
        onTouchMove={() => (followEnd.current = false)}
        onKeyDown={() => (followEnd.current = false)}
        onPointerDown={() => (followEnd.current = false)}
      >
        <div className="summary">
          <div className="eyebrow">{t('reader.summary')}</div>
          <p className={chat.summary ? undefined : 'is-placeholder'}>
            {chat.summary ?? t('reader.noSummary')}
          </p>
          {!chat.summary && <p className="is-placeholder">{t('reader.proNote')}</p>}
          <div className="tags">
            {chat.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
                <button
                  type="button"
                  className="tag-x"
                  aria-label={t('reader.removeTag', { tag })}
                  onClick={() => onRemoveTag(chat.id, tag)}
                >
                  ×
                </button>
              </span>
            ))}
            {addingTag ? (
              <form onSubmit={saveTag}>
                <input
                  autoFocus
                  className="tag-input"
                  aria-label={t('bulk.tagName')}
                  value={tagDraft}
                  maxLength={64}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={() => !tagDraft && setAddingTag(false)}
                  onKeyDown={(e) => e.key === 'Escape' && setAddingTag(false)}
                />
              </form>
            ) : (
              <button type="button" className="tag-add" onClick={() => setAddingTag(true)}>
                {t('reader.addTag')}
              </button>
            )}
          </div>
        </div>

        {chat.messages.map((m) =>
          m.role === 'user' ? (
            <div className="msg-user" key={m.id}>
              <span className="sr-only">{t('reader.you')}: </span>
              {m.blocks.map((b, i) =>
                b.type === 'text' ? (
                  <span key={i}>{b.text}</span>
                ) : b.type === 'image' ? (
                  <ChatImage key={i} block={b} onOpen={setViewing} />
                ) : (
                  <pre className="code" key={i}>
                    {b.text}
                  </pre>
                ),
              )}
            </div>
          ) : (
            <div className="msg-ai" key={m.id}>
              <div className="msg-ai-head">
                <PlatformLogo platform={chat.platform} size="md" />
                {platformName}
              </div>
              {m.blocks.map((b, i) =>
                b.type === 'text' ? (
                  <Markdown
                    key={i}
                    text={b.text}
                    onOpenLink={(url) => void window.api.openLink(url)}
                  />
                ) : b.type === 'image' ? (
                  <ChatImage key={i} block={b} onOpen={setViewing} />
                ) : (
                  <pre className="code" key={i}>
                    <code>{b.text}</code>
                  </pre>
                ),
              )}
            </div>
          ),
        )}
      </div>

      {viewing && (
        <Lightbox
          mediaId={viewing.mediaId}
          alt={viewing.alt}
          caption={chat.title}
          onClose={() => setViewing(null)}
        />
      )}
      <footer className="reader-foot">
        <Icon name="lock" size="sm" />
        <span>
          {canOpen ? t('reader.readOnly', { platform: platformName }) : t('reader.readOnlyLocal')}
        </span>
      </footer>
    </section>
  );
}

type ImageBlock = Extract<ContentBlock, { type: 'image' }>;

/** An image inside a message: the picture when it is on this Mac, otherwise a note saying why it is not. */
function ChatImage({
  block,
  onOpen,
}: {
  block: ImageBlock;
  onOpen: (v: { mediaId: number; alt: string | null }) => void;
}) {
  const { t } = useTranslation();
  if (block.mediaId) {
    const alt = block.alt ?? t('images.altFallback');
    return (
      <button
        type="button"
        className="chat-image"
        aria-label={alt}
        onClick={() => onOpen({ mediaId: block.mediaId!, alt: block.alt ?? null })}
      >
        <StoredImage id={block.mediaId} alt={alt} thumb />
      </button>
    );
  }
  const reason =
    block.status === 'failed' ? 'failed' : block.status === 'skipped' ? 'skipped' : 'pending';
  return (
    <span className="chat-image-missing">
      <Icon name="image" size="sm" />
      {t(`images.${reason}`)}
    </span>
  );
}
