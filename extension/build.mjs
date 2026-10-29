import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
for (const target of ['chromium', 'firefox']) {
  const destination = join(root, 'build', target);
  await mkdir(destination, { recursive: true });
  for (const file of ['background.js', 'youtube.js', 'popup.js', 'popup.html']) await cp(join(root, file), join(destination, file));
  await cp(join(root, target, 'manifest.json'), join(destination, 'manifest.json'));
  console.log(`Built ${destination}`);
}
