// Bundles the agent into a single executable file: dist/mesh-node.js (node >= 20, no node_modules needed).
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Release builds stamp the git tag (scripts/release/make-tarball.sh sets MESH_BUILD_VERSION=<tag without v>).
const version = (process.env.MESH_BUILD_VERSION || '').replace(/^v/, '') || pkg.version;

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/mesh-node.js',
  banner: { js: '#!/usr/bin/env node' },
  define: { __MESH_VERSION__: JSON.stringify(version) },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
chmodSync('dist/mesh-node.js', 0o755);
