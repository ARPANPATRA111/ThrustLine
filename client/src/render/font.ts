// A bitmap font generated at load (from the system font), used by all in-world text:
// name tags and floating damage numbers. BitmapText avoids per-change texture uploads.
import { BitmapFont } from 'pixi.js';

export const FONT = 'TLFont';

export function installFont(): void {
  BitmapFont.install({
    name: FONT,
    style: {
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      fontSize: 32,
      fontWeight: 'bold',
      fill: '#ffffff',
      stroke: { color: '#0b1020', width: 5 },
    },
    chars: [[' ', '~']],
    resolution: 2,
  });
}
