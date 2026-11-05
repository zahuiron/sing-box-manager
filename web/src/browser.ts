export async function copyText(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  const dialogs = document.querySelectorAll("dialog[open]");
  (dialogs[dialogs.length - 1] || document.body).append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  previous?.focus();
  if (!copied) throw new Error("复制失败 / Copy failed");
}

export function downloadText(content: string, filename: string, type: string) {
  downloadBlob(new Blob([content], { type }), filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
