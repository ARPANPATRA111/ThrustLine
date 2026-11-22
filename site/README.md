# THRUSTLINE website

The game's home page, privacy policy and data safety page, live at https://thrustline.pages.dev.
Google Play links to the last two, so keep them in step with
[android/STORE_LISTING.md](../android/STORE_LISTING.md).

Built with Astro: every page is plain HTML, and React with Motion runs only the map and arsenal
pickers, loaded when they scroll into view. Weapon stats come straight from
`server/src/shared/weapons.ts`, so the site always matches the game.

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # static files in dist/
npm run deploy     # build, then upload to Cloudflare Pages (needs `npx wrangler login` once)
```

When the app goes live on Google Play, set `PLAY_LIVE` to `true` in `src/config.ts` and deploy.

| Path | What |
| --- | --- |
| `src/pages/` | Home, privacy, data safety and 404 pages |
| `src/components/` | One file per section; `MapShowcase.tsx` and `ArsenalPicker.tsx` are the React parts |
| `src/assets/` | Gameplay stills and sprites exported from the game, optimised at build time |
| `public/media/` | Highlight clips (real gameplay, 432 × 768, no audio) |
| `public/_headers` | Security and cache headers for Cloudflare Pages |
