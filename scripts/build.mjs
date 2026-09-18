import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __pathDirname(__filename);',
].join(' ');

const targets = {
  main: { entryPoint: 'src/main.ts', outfile: 'dist/index.mjs' },
  post: { entryPoint: 'src/post-main.ts', outfile: 'dist/post/index.mjs' },
};

const requestedTarget = process.argv[2];
if (requestedTarget && !(requestedTarget in targets)) {
  throw new Error(`Unknown build target: ${requestedTarget}`);
}

for (const [name, target] of Object.entries(targets)) {
  if (requestedTarget && requestedTarget !== name) continue;
  await build({
    entryPoints: [target.entryPoint],
    outfile: target.outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    legalComments: 'external',
    banner: { js: banner },
    logLevel: 'info',
  });
}

const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const notices = [];
for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!packagePath.startsWith('node_modules/') || metadata.dev) continue;
  const packageJsonPath = join(packagePath, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE']
    .map(filename => join(packagePath, filename))
    .find(existsSync);
  const licenseText = licenseFile
    ? readFileSync(licenseFile, 'utf8').trim()
    : `License identifier: ${packageJson.license || metadata.license || 'UNKNOWN'}`;
  notices.push([
    `${packageJson.name || packagePath}@${packageJson.version || metadata.version || 'unknown'}`,
    licenseText,
  ].join('\n\n'));
}

mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/THIRD_PARTY_LICENSES.txt',
  ['Third-party licenses for AutoSpec AI', ...notices.sort()].join('\n\n' + '='.repeat(80) + '\n\n') + '\n'
);
