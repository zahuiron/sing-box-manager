import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  dismissNotification,
  useNotifications,
  type Notification,
} from "./notifications";
import { Icon, IconButton, useUI } from "./ui";

export default function ToastHost() {
  const items = useNotifications();
  const [target, setTarget] = useState<HTMLElement>(document.body);
  const root = useRef<HTMLDivElement>(null);
  const { t } = useUI();
  const active = items.length > 0;
  useLayoutEffect(() => {
    if (!active) return;
    const chooseTarget = () =>
      setTarget(
        Array.from(
          document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
        ).at(-1) || document.body,
      );
    chooseTarget();
    const observer = new MutationObserver(chooseTarget);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    const element = root.current;
    if (
      element &&
      element.isConnected &&
      typeof element.showPopover === "function" &&
      !element.matches(":popover-open")
    )
      element.showPopover();
  }, [items, target]);
  if (!active) return null;
  return createPortal(
    <div
      ref={root}
      className="toast-stack"
      style={{ "--toast-count": items.length } as CSSProperties}
      popover="manual"
      aria-label={t("通知", "Notifications")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>,
    target,
  );
}

function Toast({ item }: { item: Notification }) {
  const { t } = useUI();
  const duration = item.type === "error" ? 8000 : 5000;
  const remaining = useRef(duration);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const timer = window.setTimeout(
      () => dismissNotification(item.id),
      remaining.current,
    );
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - started),
      );
    };
  }, [item.id, paused]);
  return (
    <div
      className={`toast ${item.type}`}
      style={
        {
          "--toast-duration": `${duration}ms`,
          animationPlayState: paused ? "paused" : "running",
        } as CSSProperties
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <span className="toast-icon">
        <Icon
          name={
            item.type === "error"
              ? "warning_amber"
              : item.type === "success"
                ? "check"
                : "text_snippet"
          }
        />
      </span>
      <div className="toast-message">{item.message}</div>
      <IconButton
        icon="close"
        label={t("关闭通知", "Dismiss notification")}
        onClick={() => dismissNotification(item.id)}
      />
    </div>
  );
}
