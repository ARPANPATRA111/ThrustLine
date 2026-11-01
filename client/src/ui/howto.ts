// "How to play" as pictures instead of paragraphs: keycaps and a phone diagram for controls,
// weapon cards with real sprites and stat bars, and icon cards for scoring.
import { WEAPONS } from '@shared/weapons';
import type { Atlas } from '../render/atlas';

const NOTES = ['Always carried', 'Full auto, sprays on the move', 'Seven pellets, recoil launches you', 'One shot, huge damage', 'Lunge and slash up close', 'Bounces, then boom'];

export function setupHowTo(atlas: Atlas): void {
  // Every <img data-icon="..."> on the page gets its sprite from the atlas.
  document.querySelectorAll<HTMLImageElement>('img[data-icon]').forEach((img) => {
    img.src = atlas.iconURL(img.dataset.icon!, 3);
  });

  // Weapon cards with relative stat bars.
  const maxDps = Math.max(...WEAPONS.map((w) => w.damage * Math.max(1, w.pellets) * w.rate));
  const maxRange = Math.max(...WEAPONS.map((w) => w.range));
  document.getElementById('weapon-cards')!.innerHTML = WEAPONS.map((w, i) => {
    const dmg = w.damage * Math.max(1, w.pellets);
    const dps = (dmg * w.rate) / maxDps;
    const bar = (label: string, v: number) => `<div class="stat">${label}<i style="--v:${Math.round(Math.min(1, v) * 100)}%"></i></div>`;
    return `<div class="wcard"><div class="wimg"><img src="${atlas.iconURL(`w${i}`, 3)}" alt=""></div><b>${w.name}</b><small>${NOTES[i]}</small>${bar('Dmg', dmg / 100)}${bar('Rate', Math.min(1, w.rate / 10))}${bar('Range', w.range / maxRange)}${bar('DPS', dps)}</div>`;
  }).join('');

  // Tabs.
  const tabs = document.querySelectorAll<HTMLButtonElement>('#howto-tabs .tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll<HTMLElement>('#scr-howto .tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== t.dataset.tab));
  }));
}

const ADJ = ['Neon', 'Turbo', 'Rogue', 'Acid', 'Iron', 'Swift', 'Nova', 'Ghost', 'Rapid', 'Solar', 'Storm', 'Laser', 'Volt', 'Cosmo', 'Hyper', 'Frost'];
const NOUN = ['Falcon', 'Rigger', 'Viper', 'Comet', 'Raven', 'Jet', 'Wolf', 'Spark', 'Hawk', 'Bolt', 'Lynx', 'Orbit', 'Fox', 'Pilot', 'Blaze', 'Drift'];

/** A random callsign like "Neon Falcon" (the server adds a number if it's taken in the room). */
export function randomCallsign(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a} ${n}`.slice(0, 16);
}
