import chatgpt from '../../../assets/logos/chatgpt.svg';
import claude from '../../../assets/logos/claude.svg';
import claudeCode from '../../../assets/logos/claude-code.svg';
import gemini from '../../../assets/logos/gemini.svg';
import type { Platform } from '../../shared/types';

const LOGOS: Record<Platform, string> = {
  chatgpt,
  claude,
  gemini,
  'claude-code': claudeCode,
};

/** Official logo supplied in assets/logos (never edited). Decorative: the name is always next to it. */
export function PlatformLogo({ platform, size }: { platform: Platform; size?: 'md' | 'lg' }) {
  return (
    <img
      className={size ? `logo logo--${size}` : 'logo'}
      src={LOGOS[platform]}
      alt=""
      aria-hidden="true"
    />
  );
}
