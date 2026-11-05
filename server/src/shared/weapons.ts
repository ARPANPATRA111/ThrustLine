// Weapon table shared by client (feel, prediction) and server (authoritative damage).
import { MODE_ARMS, MODE_BLADES, MODE_BOOM, MODE_SNIPERS } from './config';
import { PICKUP_DROP, PICKUP_SHIELD } from './map';

export const W_PISTOL = 0;
export const W_AR = 1;
export const W_SHOTGUN = 2;
export const W_SNIPER = 3;
export const W_KNIFE = 4;
export const W_FRAG = 5;
/** The SMG was added after the first release, so it takes the next free id (old rows keep 0..3). */
export const W_SMG = 6;
/** Airdrop power weapon: never a loadout choice, only found in crates. */
export const W_RAIL = 7;

export type FireKind = 'semi' | 'auto' | 'bolt' | 'melee' | 'thrown';

export interface WeaponDef {
  id: number;
  name: string;
  kind: FireKind;
  damage: number;
  /** Shots (or swings) per second. */
  rate: number;
  mag: number;
  /** Starting reserve; -1 means infinite. */
  reserve: number;
  reloadSec: number;
  range: number;
  /** Spread half-angle in degrees while standing still / moving. */
  spreadStill: number;
  spreadMoving: number;
  pellets: number;
  /** Shotgun falloff: full damage up to this distance, then linear down to falloffMul at range. */
  falloffStart: number;
  falloffMul: number;
  /** Impulse pushing the shooter away from the aim direction. */
  recoil: number;
  /** Camera shake strength on fire (px). */
  shake: number;
}

export const WEAPONS: WeaponDef[] = [
  { id: W_PISTOL, name: 'Pistol', kind: 'semi', damage: 18, rate: 4, mag: 12, reserve: -1, reloadSec: 1.0, range: 900, spreadStill: 1.5, spreadMoving: 1.5, pellets: 1, falloffStart: 900, falloffMul: 1, recoil: 0, shake: 2 },
  { id: W_AR, name: 'AR', kind: 'auto', damage: 11, rate: 10, mag: 30, reserve: 120, reloadSec: 1.6, range: 1100, spreadStill: 1.5, spreadMoving: 3, pellets: 1, falloffStart: 1100, falloffMul: 1, recoil: 0, shake: 2 },
  // Close-range burst: all ten pellets at point blank drop a full-health pilot, and the faster
  // pump makes a second shot land before the target can fly clear at 250 ms ping.
  { id: W_SHOTGUN, name: 'Shotgun', kind: 'semi', damage: 10, rate: 1.3, mag: 7, reserve: 28, reloadSec: 2.0, range: 460, spreadStill: 13, spreadMoving: 13, pellets: 10, falloffStart: 200, falloffMul: 0.55, recoil: 540, shake: 8 },
  // One clean body hit kills; with a quarter-second of lag, two-shot kills were too hard to close.
  { id: W_SNIPER, name: 'Sniper', kind: 'bolt', damage: 100, rate: 0.85, mag: 4, reserve: 16, reloadSec: 2.5, range: 2400, spreadStill: 0, spreadMoving: 5, pellets: 1, falloffStart: 2400, falloffMul: 1, recoil: 0, shake: 9 },
  { id: W_KNIFE, name: 'Knife', kind: 'melee', damage: 55, rate: 2, mag: 0, reserve: 0, reloadSec: 0, range: 64, spreadStill: 60, spreadMoving: 60, pellets: 0, falloffStart: 64, falloffMul: 1, recoil: 0, shake: 1 },
  { id: W_FRAG, name: 'Frag', kind: 'thrown', damage: 100, rate: 1.25, mag: 0, reserve: 0, reloadSec: 0, range: 170, spreadStill: 0, spreadMoving: 0, pellets: 0, falloffStart: 0, falloffMul: 1, recoil: 0, shake: 10 },
  // Latency-friendly primary: many forgiving shots, so a quarter-second of lag costs a few bullets
  // rather than a whole marksman's shot. Falls off at range; the AR still wins mid-to-long fights.
  { id: W_SMG, name: 'SMG', kind: 'auto', damage: 8, rate: 14, mag: 35, reserve: 140, reloadSec: 1.3, range: 900, spreadStill: 2.5, spreadMoving: 5.5, pellets: 1, falloffStart: 450, falloffMul: 0.55, recoil: 0, shake: 1.5 },
  // A few shots that go through every body on the line. Walls still stop them.
  { id: W_RAIL, name: 'Railgun', kind: 'bolt', damage: 150, rate: 0.9, mag: 3, reserve: 0, reloadSec: 0, range: 2400, spreadStill: 0, spreadMoving: 0.5, pellets: 1, falloffStart: 2400, falloffMul: 1, recoil: 240, shake: 12 },
];

export const PRIMARIES = [W_AR, W_SHOTGUN, W_SNIPER, W_SMG];

export function isGun(w: number): boolean {
  return w === W_PISTOL || w === W_AR || w === W_SHOTGUN || w === W_SNIPER || w === W_SMG || w === W_RAIL;
}

export function isPrimary(w: number): boolean {
  return w === W_AR || w === W_SHOTGUN || w === W_SNIPER || w === W_SMG;
}

/**
 * Weapons a player may hold (equip) in each mode. Grenades in Arms are thrown with their own key.
 * `power` is the railgun shots left from an airdrop.
 */
export function allowedWeapons(mode: number, primary: number, power = 0): number[] {
  if (mode === MODE_BLADES) return [W_KNIFE];
  if (mode === MODE_BOOM) return [W_FRAG, W_KNIFE];
  const rail = power > 0 ? [W_RAIL] : [];
  if (mode === MODE_SNIPERS) return [...rail, W_SNIPER, W_KNIFE];
  return [...rail, primary, W_PISTOL, W_KNIFE];
}

/** The primary gun actually carried: Snipers mode forces the sniper rifle. */
export function effectivePrimary(mode: number, primary: number): number {
  return mode === MODE_SNIPERS ? W_SNIPER : primary;
}

export function defaultWeapon(mode: number, primary: number): number {
  if (mode === MODE_BLADES) return W_KNIFE;
  if (mode === MODE_BOOM) return W_FRAG;
  return effectivePrimary(mode, primary);
}

/** Which pickup kinds (0 health, 1 ammo, 2 grenade, 3 shield, 4 airdrop) are active in a mode. */
export function pickupActive(mode: number, kind: number): boolean {
  if (kind === PICKUP_SHIELD) return true;
  if (kind === PICKUP_DROP) return mode === MODE_ARMS || mode === MODE_SNIPERS;
  if (mode === MODE_ARMS) return true;
  if (mode === MODE_SNIPERS) return kind !== 2;
  return kind === 0;
}

/** Grenades can be thrown in Arms (limited) and Boom (unlimited). */
export function canThrow(mode: number): boolean {
  return mode === MODE_ARMS || mode === MODE_BOOM;
}

/**
 * Damage per pellet at distance `d`. Full damage to falloffStart, then a linear drop to
 * damage * falloffMul at the weapon's range.
 */
export function damageAtDistance(w: WeaponDef, d: number): number {
  if (d <= w.falloffStart || w.falloffMul === 1) return w.damage;
  const t = Math.min(1, (d - w.falloffStart) / Math.max(1, w.range - w.falloffStart));
  return w.damage * (1 - t * (1 - w.falloffMul));
}

/** Linear grenade falloff: max at the centre, 0 at the blast radius. */
export function grenadeDamage(maxDamage: number, radius: number, d: number): number {
  if (d >= radius) return 0;
  return maxDamage * (1 - d / radius);
}
