import { useEffect, useSyncExternalStore } from "react";

export type NoticeType = "success" | "error" | "info";
export interface Notification {
  id: number;
  message: string;
  type: NoticeType;
}
let items: Notification[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const snapshot = () => items;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => {
  for (const listener of listeners) listener();
};

export function notify(message: string, type: NoticeType = "error") {
  if (!message.trim()) return;
  items = [
    ...items.filter((item) => item.message !== message || item.type !== type),
    { id: ++sequence, message, type },
  ].slice(-4);
  emit();
}

export function dismissNotification(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export function useNotifications() {
  return useSyncExternalStore(subscribe, snapshot);
}

export function Notice({
  message,
  error = true,
}: {
  message: string;
  error?: boolean;
}) {
  useEffect(() => {
    if (message) notify(message, error ? "error" : "success");
  }, [message, error]);
  return null;
}
