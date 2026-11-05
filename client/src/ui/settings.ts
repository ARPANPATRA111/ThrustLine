// Player settings, saved in localStorage. Volumes are stored by the audio mixer itself.
export type Quality = 'auto' | 'high' | 'low';

export interface Settings {
  quality: Quality;
  showDebug: boolean;
  lefty: boolean;
  name: string;
  /** The sticker on each number key (index into EMOTES). */
  quickStickers: number[];
}

const KEY = 'tl:settings';

export function loadSettings(): Settings {
  const defaults: Settings = { quality: 'auto', showDebug: false, lefty: false, name: '', quickStickers: [0, 1, 2, 3] };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
