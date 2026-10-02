import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e against the REAL gateway (mock adapter + mock upstream, throwaway SQLite) and the
 * Vite dev server. `pnpm --filter web e2e`. Chromium is the pre-installed build under
 * /opt/pw-browsers (override with PW_CHROMIUM=/path/to/chrome).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

export const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? 8790);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const ADMIN_TOKEN = 'e2e-admin-token';
export const E2E_DB = resolve(here, 'e2e/.tmp/mesh-e2e.db');

function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  for (const p of ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) if (existsSync(p)) return p;
  return undefined; // fall back to whatever Playwright has installed
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : [['list']],
  outputDir: './e2e/.tmp/results',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: chromiumPath() },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /phone\.spec\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, testMatch: /phone\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `node_modules/.bin/tsx src/index.ts`,
      cwd: resolve(root, 'apps/gateway'),
      url: `${GATEWAY_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(GATEWAY_PORT),
        HOST: '127.0.0.1',
        MESH_DB_PATH: E2E_DB,
        MESH_ADAPTER: 'mock',
        EPOCH_CRON: 'off',
        JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
        ADMIN_TOKEN,
        AUTH_DOMAIN: `127.0.0.1:${GATEWAY_PORT}`,
        OPENROUTER_API_KEY: '',
        STATS_CACHE_MS: '0',
        LOG_LEVEL: 'warn',
        ALERTS_ENABLED: 'false',
        CORS_ORIGINS: '*',
      },
    },
    {
      command: `node_modules/.bin/vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: here,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_URL: GATEWAY_URL, VITE_MOCK: '' },
    },
  ],
});
