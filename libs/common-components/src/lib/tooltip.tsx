import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { createPopper, type Instance, type Placement } from '@popperjs/core';

interface TooltipProps {
  /** Content shown on hover/focus. Tooltip is suppressed when null/empty. */
  content: ReactNode;
  /** The trigger element(s) the tooltip describes. */
  children: ReactNode;
  /** Preferred placement; popper flips/shifts it to stay in the viewport. */
  placement?: Placement;
  /** Extra classes for the inline trigger wrapper (e.g. `cursor-help`). */
  className?: string;
}

/**
 * Hover/focus tooltip positioned with Popper and portaled to <body>, so it escapes
 * `overflow` clipping (tables, scroll areas) and flips to stay on screen.
 */
export function Tooltip({ content, children, placement = 'top', className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const popperRef = useRef<Instance | null>(null);
  const tooltipId = useId();

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return;
    popperRef.current = createPopper(triggerRef.current, tooltipRef.current, {
      placement,
      modifiers: [
        { name: 'offset', options: { offset: [0, 6] } },
        { name: 'flip', options: { padding: 8 } },
        { name: 'preventOverflow', options: { padding: 8 } },
      ],
    });
    return () => {
      popperRef.current?.destroy();
      popperRef.current = null;
    };
  }, [open, placement, content]);

  const show = () => setOpen(true);
  const hide = () => setOpen(false);
  const hasContent = content != null && content !== '';

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={open && hasContent ? tooltipId : undefined}
        className={['inline-flex', className ?? ''].join(' ').trim() || undefined}
      >
        {children}
      </span>
      {open && hasContent &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="z-50 max-w-xs rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium leading-snug text-slate-700 shadow-lg"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
