// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

const escapeStack: (() => void)[] = [];

function useEscapeEntry(active: boolean, onDismiss: () => void) {
  const dismissRef = useLatestRef(onDismiss);
  useEffect(() => {
    if (!active) {
      return;
    }
    const entry = () => dismissRef.current();
    escapeStack.push(entry);
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        escapeStack[escapeStack.length - 1] === entry
      ) {
        event.preventDefault();
        entry();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      const index = escapeStack.indexOf(entry);
      if (index >= 0) {
        escapeStack.splice(index, 1);
      }
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, dismissRef]);
}

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  useEscapeEntry(open, onDismiss);
  const dismissRef = useLatestRef(onDismiss);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        dismissRef.current();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [ref, open, dismissRef]);
}

export function useMenuPopover(
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  onDismiss: () => void,
  options?: { alignEnd?: boolean; width?: "anchor" | "min-anchor" },
) {
  const alignEnd = options?.alignEnd === true;
  const width = options?.width;
  const dismissRef = useLatestRef(onDismiss);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) {
      return;
    }
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    const anchorRect = anchor.getBoundingClientRect();
    if (width === "anchor") {
      menu.style.width = `${anchorRect.width}px`;
      menu.style.minWidth = `${anchorRect.width}px`;
    } else if (width === "min-anchor") {
      menu.style.minWidth = `${anchorRect.width}px`;
    }
    menu.showPopover();
    const menuRect = menu.getBoundingClientRect();
    const rightToLeft = getComputedStyle(anchor).direction === "rtl";
    const alignRightEdge = alignEnd !== rightToLeft;
    let left = alignRightEdge
      ? anchorRect.right - menuRect.width
      : anchorRect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    let top = anchorRect.bottom + 6;
    if (
      top + menuRect.height > window.innerHeight - 8 &&
      anchorRect.top - menuRect.height - 6 >= 8
    ) {
      top = anchorRect.top - menuRect.height - 6;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || menu.contains(event.target)) {
        return;
      }
      if (!event.target.contains(anchor)) {
        return;
      }
      dismissRef.current();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open, anchorRef, menuRef, alignEnd, width, dismissRef]);
}
