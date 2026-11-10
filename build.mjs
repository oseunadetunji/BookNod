// Bundles public/ into one Worker file (dist/worker.js), plus two clickable previews that need no server.
// Runs automatically before every `wrangler deploy` (see [build] in wrangler.toml). Uses only Node built-ins.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const isText = t => t.startsWith('text/') || t.startsWith('application/') || t.startsWith('image/svg');

const assets = {};
for (const name of readdirSync(join(root, 'public')).sort()) {
  const file = join(root, 'public', name);
  const type = TYPES[extname(name)] || 'application/octet-stream';
  assets['/' + name] = isText(type)
    ? { type, body: readFileSync(file, 'utf8') }
    : { type, body: readFileSync(file).toString('base64'), b64: true };
}

const src = readFileSync(join(root, 'src', 'worker.js'), 'utf8');
if (!src.includes('__ASSETS__')) throw new Error('src/worker.js is missing the __ASSETS__ placeholder');
const out = src.replace('__ASSETS__', () => JSON.stringify(assets));
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'worker.js'), out);
console.log(`dist/worker.js ${Math.round(out.length / 1024)} KB`);

// Previews: the app with a stand-in server and sample ratings. Open them in any browser.
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const mock = readFileSync(join(root, 'preview', 'mock.js'), 'utf8');
const marker = '<script>\nconst API=';
if (!html.includes(marker)) throw new Error('public/index.html: preview injection point not found');
for (const [name, slug] of [['booknod-preview.html', null], ['booknod-partner-preview.html', 'demo']]) {
  const page = html.replace(marker, () => `<script>window.BOOKNOD_PARTNER=${JSON.stringify(slug)};</script>\n<script>\n${mock}\n</script>\n${marker}`);
  writeFileSync(join(root, 'dist', name), page);
  console.log('dist/' + name);
}
