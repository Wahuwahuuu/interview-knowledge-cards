import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
await mkdir('desktop-dist', { recursive: true });
for (const entry of ['main', 'cli']) await build({ entryPoints: [`desktop/${entry}.ts`], outfile: `desktop-dist/${entry}.cjs`, platform: 'node', target: 'node24', format: 'cjs', bundle: true, external: ['electron'], sourcemap: false, logLevel: 'info' });
// Only the bundled backend belongs in the application archive. Never scan private files or ship dev dependencies.
await mkdir('.cache/desktop-package', { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('.cache/desktop-package/package.json', JSON.stringify({ name: pkg.name, productName: '面试知识卡', version: pkg.version, description: pkg.description, author: '面试知识卡', main: 'main.cjs' }, null, 2));
await copyFile('desktop-dist/main.cjs', '.cache/desktop-package/main.cjs');
