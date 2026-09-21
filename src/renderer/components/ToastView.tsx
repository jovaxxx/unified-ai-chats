import { useTranslation } from 'react-i18next';

export interface Toast {
  message: string;
  error?: boolean;
  undo?: () => void;
}

/** A message at the bottom of the window. Lives at the app level so it shows on every screen. */
export function ToastView({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  const { t } = useTranslation();
  if (!toast) return null;
  return (
    <div className={`toast${toast.error ? ' toast--error' : ''}`} role="status">
      <span>{toast.message}</span>
      {toast.undo && (
        <button type="button" onClick={toast.undo}>
          {t('toast.undo')}
        </button>
      )}
      <button type="button" onClick={onDismiss}>
        {t('toast.dismiss')}
      </button>
    </div>
  );
}
