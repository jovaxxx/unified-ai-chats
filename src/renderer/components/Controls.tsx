import { useState, type ReactNode, type Ref } from 'react';
import { Icon } from './Icon';

/**
 * The app's shared form controls, so a search box, a filter pill or a sort menu looks and behaves the same in every
 * view. Do not style raw `<input>` / `<select>` in a view: use these.
 */

/**
 * A search box: magnifier, input, optional trailing hint. With `suggestions` it offers completions in the app's own
 * menu (never the browser's native one): arrows move, Enter or a click picks, Esc closes.
 */
export function SearchField({
  ref,
  ...props
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  ref?: Ref<HTMLInputElement>;
  suggestions?: string[];
  /** Sits in a toolbar instead of taking the full-width margins of the list's search. */
  inline?: boolean;
  children?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const options = (props.suggestions ?? []).filter(
    (s) => s.toLowerCase() !== props.value.trim().toLowerCase(),
  );
  const open = focused && !dismissed && props.value.trim() !== '' && options.length > 0;
  const pick = (s: string) => {
    props.onChange(s);
    setDismissed(true);
    setActive(-1);
  };
  return (
    <label className={`search${props.inline ? ' search--inline' : ''}`}>
      <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
        <Icon name="search" />
      </span>
      <span className="sr-only">{props.label}</span>
      <input
        ref={ref}
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        maxLength={200}
        {...(props.suggestions
          ? { role: 'combobox', 'aria-expanded': open, 'aria-autocomplete': 'list' as const }
          : {})}
        onChange={(e) => {
          props.onChange(e.target.value);
          setDismissed(false);
          setActive(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % options.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(options[active]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDismissed(true);
          }
        }}
      />
      {props.children}
      {open && (
        <ul className="suggest" role="listbox">
          {options.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === active}
              className={`suggest-item${i === active ? ' is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the input
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Icon name="search" size="xs" />
              {s}
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

/** A filter pill: "Label: Any", or the chosen value once set. */
export function FilterSelect(props: {
  label: string;
  anyLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  /** Spoken name, if it should say more than the visible label. */
  ariaLabel?: string;
}) {
  return (
    <span className="chip-select">
      <select
        aria-label={props.ariaLabel ?? props.label}
        className={props.value ? 'is-set' : ''}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">{`${props.label}: ${props.anyLabel}`}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chev-down" size="xs" />
    </span>
  );
}

/** A sort menu: the same pill as a filter, without the "set" colour. */
export function SortSelect(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  /** Push it to the right end of a row. */
  end?: boolean;
}) {
  return (
    <span className={`chip-select${props.end ? ' chip-select--end' : ''}`}>
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chev-down" size="xs" />
    </span>
  );
}
