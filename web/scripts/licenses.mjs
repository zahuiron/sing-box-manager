import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const repository = resolve(root, "..");
const destination = resolve(root, "public/licenses");
await mkdir(destination, { recursive: true });
for (const entry of await readdir(destination, { withFileTypes: true }))
  if (entry.isFile() && entry.name.endsWith(".txt"))
    await rm(resolve(destination, entry.name));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const dependencies = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  const directory = resolve(root, path);
  const installed = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  if (installed.version !== metadata.version)
    throw new Error(`Installed dependency differs from lockfile: ${path}`);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:licen[cs]e|copying|copyright|ofl|notice)(?:[.-].*)?$/i.test(name))
    .sort();
  if (!names.some((name) => /^(?:licen[cs]e|copying|ofl)(?:[.-].*)?$/i.test(name)))
    throw new Error(`Dependency has no license file: ${path}`);
  const filename = `${path.replace(/^node_modules\//, "").replaceAll("/", "_")}.txt`;
  const documents = await Promise.all(names.map(async (name) =>
    `${name}\n\n${await readFile(resolve(directory, name), "utf8")}`));
  await writeFile(resolve(destination, filename),
    `${installed.name} ${metadata.version}\n${metadata.license}\n\n${documents.join("\n\n")}\n`);
  dependencies.push(`${installed.name}@${metadata.version}: ${metadata.license} (${filename})`);
}
const documents = {
  "GPL-3.0.txt": "LICENSE",
  "sing-box-dashboard.txt": "web/src/vendor/LICENSE",
  "Apache-2.0.txt": "web/src/vendor/Apache-2.0.txt",
  "s-panel-schema.txt": "web/src/schema/LICENSE",
  "sing-box-LICENSE.txt": "licenses/sing-box-LICENSE.txt",
  "Go-LICENSE.txt": "licenses/Go-LICENSE.txt",
  "Go-PATENTS.txt": "licenses/Go-PATENTS.txt",
  "THIRD_PARTY.txt": "web/THIRD_PARTY.md",
};
for (const [name, source] of Object.entries(documents))
  await writeFile(resolve(destination, name), await readFile(resolve(repository, source)));
await writeFile(resolve(destination, "NOTICE.txt"),
  `${await readFile(resolve(repository, "NOTICE"), "utf8")}\nPanel runtime dependencies:\n${dependencies.join("\n")}\n`);
