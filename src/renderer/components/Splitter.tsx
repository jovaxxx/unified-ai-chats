import { useRef, useState } from 'react';

interface Props {
  /** Distance from the left edge of the window, in pixels. */
  left: number;
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
  onReset: () => void;
}

const STEP = 16;

/**
 * A draggable divider between two columns. Works with the mouse or touch (pointer capture), and with the
 * keyboard (arrow keys, Home/End); double-click or Enter... resets. Announced as a separator to screen readers.
 */
export function Splitter({ left, value, min, max, label, onChange, onReset }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, value: 0 });
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));

  return (
    <div
      className={`splitter${dragging ? ' is-dragging' : ''}`}
      style={{ left }}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, value };
        setDragging(true);
        document.body.classList.add('is-resizing');
      }}
      onPointerMove={(e) => {
        if (dragging) onChange(clamp(start.current.value + e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setDragging(false);
        document.body.classList.remove('is-resizing');
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(clamp(value - STEP));
        else if (e.key === 'ArrowRight') onChange(clamp(value + STEP));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}
