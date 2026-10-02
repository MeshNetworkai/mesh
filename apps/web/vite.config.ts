import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Serves the node installer from this origin so the one-liner on /app/node works wherever the web
 * app is hosted:  /install-node.sh  <- scripts/install-node.sh (single source of truth)
 *                 /mesh-node.js     <- apps/node-agent/dist/mesh-node.js (fallback bundle source when
 *                                      the gateway does not serve GET /install/mesh-node.js)
 * In dev they are served live; in build they are emitted as plain assets at the site root.
 */
function nodeInstaller(): Plugin {
  const files: Record<string, { path: string; type: string }> = {
    '/install-node.sh': { path: resolve(here, '../../scripts/install-node.sh'), type: 'text/x-shellscript; charset=utf-8' },
    '/mesh-node.js': { path: resolve(here, '../node-agent/dist/mesh-node.js'), type: 'text/javascript; charset=utf-8' },
  };
  return {
    name: 'mesh-node-installer',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = files[(req.url ?? '').split('?')[0]];
        if (!f || !existsSync(f.path)) return next();
        res.setHeader('content-type', f.type);
        res.setHeader('cache-control', 'no-cache');
        res.end(readFileSync(f.path));
      });
    },
    generateBundle() {
      for (const [url, f] of Object.entries(files)) {
        if (!existsSync(f.path)) {
          this.warn(`${url}: ${f.path} missing (run pnpm --filter node-agent build); skipped`);
          continue;
        }
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(f.path) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), nodeInstaller()],
  define: {
    // Some Solana wallet-adapter deps expect a Node-ish global.
    'process.env': {},
    global: 'globalThis',
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      onwarn(warning, warn) {
        // Noisy upstream (ox/zod) PURE-annotation notices; everything else surfaces.
        if (warning.code === 'INVALID_ANNOTATION') return;
        warn(warning);
      },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          wallets: [
            '@solana/web3.js',
            '@solana/wallet-adapter-phantom',
            '@solana/wallet-adapter-solflare',
            'wagmi',
            'viem',
          ],
        },
      },
    },
  },
});
