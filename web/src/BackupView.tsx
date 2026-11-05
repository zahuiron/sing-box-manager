import { useRef, useState } from "react";
import { api, apiFetch, readResponse } from "./api";
import { downloadBlob } from "./browser";
import { Dialog, Spinner, useUI } from "./ui";
import { Header, NavRow } from "./views";
import { notify } from "./notifications";

interface BackupSummary {
  created_at: string;
  panel_version: string;
  servers: number;
  users: number;
  client_templates: number;
  server_templates: number;
  subscriptions: number;
  drafts: number;
}

export default function BackupView({
  busy,
  back,
  perform,
  onRestored,
}: {
  busy: boolean;
  back: () => void;
  perform: (
    operation: () => Promise<void>,
    success?: string,
  ) => Promise<boolean>;
  onRestored: () => void;
}) {
  const { t } = useUI();
  const input = useRef<HTMLInputElement>(null);
  const [action, setAction] = useState("");
  const [pending, setPending] = useState<{
    file: File;
    summary: BackupSummary;
  } | null>(null);

  async function exportBackup() {
    setAction("export");
    await perform(async () => {
      const response = await apiFetch("/backup");
      if (!response.ok) {
        await readResponse(response);
        return;
      }
      const filename =
        /filename="([^"]+)"/.exec(
          response.headers.get("Content-Disposition") || "",
        )?.[1] || "sing-box-manager-backup.json";
      downloadBlob(await response.blob(), filename);
    });
    setAction("");
  }

  async function checkBackup(file: File) {
    if (file.size > 128 * 1024 * 1024) {
      notify(
        t("备份文件不能超过 128 MiB", "Backup file must not exceed 128 MiB"),
      );
      return;
    }
    setAction("check");
    await perform(async () => {
      const summary = await api<BackupSummary>("/backup/check", {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/json" },
      });
      setPending({ file, summary });
    });
    setAction("");
  }

  async function restore() {
    if (!pending) return;
    setAction("restore");
    await perform(
      async () => {
        await api("/backup/restore", {
          method: "POST",
          body: pending.file,
          headers: { "Content-Type": "application/json" },
        });
        setPending(null);
        onRestored();
      },
      t("备份已恢复", "Backup restored"),
    );
    setAction("");
  }

  const summaryRows = pending
    ? [
        [t("文件", "File"), pending.file.name],
        [
          t("备份时间", "Backup time"),
          new Date(pending.summary.created_at).toLocaleString(),
        ],
        [t("面板版本", "Panel version"), pending.summary.panel_version],
        [t("服务器", "Servers"), pending.summary.servers],
        [t("用户模板", "User templates"), pending.summary.users],
        [t("客户端模板", "Client templates"), pending.summary.client_templates],
        [t("服务端模板", "Server templates"), pending.summary.server_templates],
        [t("订阅", "Subscriptions"), pending.summary.subscriptions],
        [t("配置草稿", "Configuration drafts"), pending.summary.drafts],
      ]
    : [];
  return (
    <div className="page">
      <Header title={t("备份与恢复", "Backup and restore")} back={back} />
      <div className="nav-list">
        <NavRow
          icon="download"
          title={t("导出备份", "Export backup")}
          detail={busy && action === "export" ? <Spinner /> : undefined}
          disabled={busy}
          onClick={() => void exportBackup()}
        />
        <NavRow
          icon="upload_file"
          title={t("恢复备份", "Restore backup")}
          detail={busy && action === "check" ? <Spinner /> : undefined}
          disabled={busy}
          onClick={() => input.current?.click()}
        />
      </div>
      <input
        hidden
        ref={input}
        type="file"
        accept=".json,application/json"
        disabled={busy}
        aria-label={t("选择备份文件", "Choose backup file")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void checkBackup(file);
        }}
      />
      {pending && (
        <Dialog
          title={t("恢复备份", "Restore backup")}
          onClose={() => setPending(null)}
          busy={busy}
        >
          <div className="card detail-card">
            {summaryRows.map(([label, value]) => (
              <div className="data-line" key={label}>
                <span className="label">{label}</span>
                <span className="value">{value}</span>
              </div>
            ))}
          </div>
          <p className="dialog-message">
            {t(
              "将覆盖当前面板全部数据，服务器仍需手动发布。",
              "This replaces all panel data. Publishing to servers remains manual.",
            )}
          </p>
          <div className="row-actions dialog-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void restore()}
            >
              {busy && action === "restore" && <Spinner />}
              {t("恢复", "Restore")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
