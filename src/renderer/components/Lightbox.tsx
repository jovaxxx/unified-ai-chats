import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

/** The full image (`m`) or its small preview (`t`). */
export const mediaUrl = (id: number, thumb = false) => `uac-media://${thumb ? 't' : 'm'}/${id}`;

/**
 * An image of a chat, shown through the app's own scheme: the app fetches it from the platform when it is looked at
 * and keeps it only in memory. If the platform no longer has it, a plain placeholder shows instead of a broken picture.
 */
export function StoredImage({
  id,
  alt,
  lazy = true,
  thumb = false,
}: {
  id: number;
  alt: string;
  lazy?: boolean;
  /** A small preview instead of the full image: quick, and kept for next time. */
  thumb?: boolean;
}) {
  const [failedId, setFailedId] = useState<number | null>(null);
  if (failedId === id) {
    return (
      <span className="img-broken" role="img" aria-label={alt}>
        <Icon name="image" />
      </span>
    );
  }
  return (
    <img
      src={mediaUrl(id, thumb)}
      alt={alt}
      {...(lazy ? { loading: 'lazy' as const } : {})}
      onError={() => setFailedId(id)}
    />
  );
}

interface Props {
  mediaId: number;
  alt: string | null;
  /** Where it came from, e.g. the chat title and profile. */
  caption?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenChat?: () => void;
}

/** A large view of one image. Esc closes it; the arrow keys move between images when there are several. */
export function Lightbox({ mediaId, alt, caption, onClose, onPrev, onNext, onOpenChat }: Props) {
  const { t } = useTranslation();
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = () => {
    setSaveError(null);
    void window.api
      .saveImage(mediaId)
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <div
      className="overlay overlay--dark"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('images.view')}>
        <StoredImage id={mediaId} alt={alt ?? t('images.altFallback')} lazy={false} />
        <div className="lightbox-bar">
          <div className="lightbox-text">
            {alt && <div className="lightbox-alt">{alt}</div>}
            {caption && <div className="lightbox-caption">{caption}</div>}
            {saveError && (
              <div className="form-error" role="alert">
                {saveError}
              </div>
            )}
          </div>
          <div className="lightbox-actions">
            {onPrev && (
              <button type="button" className="btn" onClick={onPrev} aria-label={t('images.prev')}>
                ←
              </button>
            )}
            {onNext && (
              <button type="button" className="btn" onClick={onNext} aria-label={t('images.next')}>
                →
              </button>
            )}
            <button type="button" className="btn" onClick={save}>
              {t('images.save')}
            </button>
            {onOpenChat && (
              <button type="button" className="btn" onClick={onOpenChat}>
                {t('images.openChat')}
              </button>
            )}
            <button type="button" className="btn btn--primary" autoFocus onClick={onClose}>
              {t('images.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
