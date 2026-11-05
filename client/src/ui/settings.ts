// Player settings, saved in localStorage. Volumes are stored by the audio mixer itself.
import type { Action } from '../game/input';

export type Quality = 'auto' | 'high' | 'low';

export interface Settings {
  quality: Quality;
  showDebug: boolean;
  lefty: boolean;
  name: string;
  /** The sticker on each number key (index into EMOTES). */
  quickStickers: number[];
  /** Comfort options, 0..1. */
  shake: number;
  particles: number;
  colorblind: boolean;
  /** Keys the player changed; everything else stays on the default. */
  keys: Partial<Record<Action, string>>;
}

const KEY = 'tl:settings';

export function loadSettings(): Settings {
  const defaults: Settings = { quality: 'auto', showDebug: false, lefty: false, name: '', quickStickers: [0, 1, 2, 3], shake: 1, particles: 1, colorblind: false, keys: {} };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
