import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cleanDirectives } from '../../shared/text';

/**
 * Renders an assistant message the way the platforms do (headings, lists, tables, code, links).
 *
 * Safe by construction: react-markdown never renders raw HTML (it is shown as text), unsafe URL
 * protocols such as javascript: are dropped, and this app makes no network requests, so remote
 * images are shown as a "[image]" placeholder instead of being fetched. Links open in the system
 * browser only when clicked, and only if they are http(s).
 */
export function Markdown({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink: (url: string) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) onOpenLink(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>,
          pre: ({ children }) => <pre className="code">{children}</pre>,
          // Wide tables scroll inside their own box instead of stretching the page.
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {cleanDirectives(text)}
      </ReactMarkdown>
    </div>
  );
}
