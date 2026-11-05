import { useState } from "react";
import type { ServerRecord } from "./api";
import { Dialog, IconButton, Spinner, useUI } from "./ui";

export default function ServerOrderDialog({
  servers,
  busy,
  onClose,
  save,
}: {
  servers: ServerRecord[];
  busy: boolean;
  onClose: () => void;
  save: (ids: string[]) => Promise<boolean>;
}) {
  const { t } = useUI();
  const [ids, setIDs] = useState(() => servers.map((server) => server.id));
  const names = new Map(servers.map((server) => [server.id, server.name]));
  const changed = ids.some((id, index) => id !== servers[index]?.id);

  function move(index: number, direction: number) {
    const target = index + direction;
    if (busy || target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    setIDs(next);
  }

  return (
    <Dialog
      title={t("服务器排序", "Server order")}
      onClose={onClose}
      busy={busy}
    >
      <ol className="server-order-list">
        {ids.map((id, index) => (
          <li className="server-order-row" key={id}>
            <span className="hint">{index + 1}</span>
            <span className="server-order-name">{names.get(id) || id}</span>
            <span className="server-order-actions">
              <IconButton
                icon="expand_less"
                label={`${t("上移", "Move up")} · ${names.get(id) || id}`}
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
              />
              <IconButton
                icon="expand_more"
                label={`${t("下移", "Move down")} · ${names.get(id) || id}`}
                disabled={busy || index === ids.length - 1}
                onClick={() => move(index, 1)}
              />
            </span>
          </li>
        ))}
      </ol>
      <div className="row-actions dialog-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          {t("取消", "Cancel")}
        </button>
        <button
          className="button primary"
          disabled={busy || !changed}
          onClick={() => void save(ids)}
        >
          {busy && <Spinner />}
          {t("保存", "Save")}
        </button>
      </div>
    </Dialog>
  );
}
