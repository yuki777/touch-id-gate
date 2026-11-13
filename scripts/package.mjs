// Chrome Web Store に提出する zip を dist/ に作る。実行: node scripts/package.mjs
// 拡張の動作に要らないファイルと、manifest.json の key を除く。
// key は、パッケージ化されていない拡張の ID を固定するためのもの。ストアでは ID をストアが決めるので、入れない。
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = [/^\./, /^test\//, /^scripts\//, /^docs\//, /\.md$/, /\.svg$/];

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const packageDirectory = join(root, 'dist', 'package');
const zipPath = join(root, 'dist', `url-gate-${manifest.version}.zip`);

const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const files = trackedFiles.filter((file) => !EXCLUDED.some((pattern) => pattern.test(file)));

rmSync(packageDirectory, { recursive: true, force: true });
rmSync(zipPath, { force: true });
for (const file of files) {
  mkdirSync(dirname(join(packageDirectory, file)), { recursive: true });
  cpSync(join(root, file), join(packageDirectory, file));
}
const { key, ...storeManifest } = manifest;
writeFileSync(join(packageDirectory, 'manifest.json'), `${JSON.stringify(storeManifest, null, 2)}\n`);

execFileSync('zip', ['-qr', zipPath, '.'], { cwd: packageDirectory });
console.log(zipPath);
