export function cleanLogText(text: string) {
  return text
    .replace(/\u001b\][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\|(?=\r?\n)|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b(?:\[[0-?]*[ -/]*)?$/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function appendLogText(current: string, chunk: string) {
  let next = current + chunk;
  if (next.length > 256 * 1024) {
    next = next.slice(-256 * 1024);
    const boundary = next.indexOf("\n");
    if (boundary >= 0) next = next.slice(boundary + 1);
  }
  return next.split("\n").slice(-1000).join("\n");
}
