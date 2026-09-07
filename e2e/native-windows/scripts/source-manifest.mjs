import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', 'test-results', 'playwright-report', 'reports', 'secrets', '__pycache__', 'results.json', 'junit.xml']);
async function list(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name) || entry.name.startsWith('.')) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await list(absolute));
    else files.push({ path: path.relative(root, absolute).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  return files;
}
const files = await list(root);
const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const snapshot = path.join(path.dirname(process.argv[2]), 'framework-source');
for (const file of files) {
  const target = path.join(snapshot, file.path);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file.path), target);
}
await writeFile(process.argv[2], JSON.stringify({ sha256: digest, files }, null, 2));
console.log(`Framework source: ${digest}`);
