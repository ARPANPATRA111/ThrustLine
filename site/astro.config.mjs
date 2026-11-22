import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://thrustline.pages.dev',
  trailingSlash: 'always',
  compressHTML: false,
  integrations: [react(), sitemap({ filter: (page) => !page.includes('/404') })],
  vite: {
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  },
});
