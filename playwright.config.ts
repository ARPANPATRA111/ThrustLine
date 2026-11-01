import { defineConfig } from '@playwright/test';

// BASE_URL defaults to the local Vite dev server. For the production smoke test:
//   BASE_URL=https://<app>.vercel.app PLAYERS=2 npx playwright test
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    launchOptions: {
      // Software GL so the canvas renders in headless Chromium.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
