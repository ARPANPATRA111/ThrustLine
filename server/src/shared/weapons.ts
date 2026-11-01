// Weapon table shared by client (feel, prediction) and server (authoritative damage).
import { MODE_ARMS, MODE_BLADES, MODE_BOOM } from './config';

export const W_PISTOL = 0;
export const W_AR = 1;
export const W_SHOTGUN = 2;
export const W_SNIPER = 3;
export const W_KNIFE = 4;
export const W_FRAG = 5;

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
  { id: W_SHOTGUN, name: 'Shotgun', kind: 'semi', damage: 9, rate: 1.1, mag: 6, reserve: 24, reloadSec: 2.2, range: 420, spreadStill: 14, spreadMoving: 14, pellets: 7, falloffStart: 180, falloffMul: 0.5, recoil: 520, shake: 7 },
  { id: W_SNIPER, name: 'Sniper', kind: 'bolt', damage: 85, rate: 0.8, mag: 4, reserve: 16, reloadSec: 2.6, range: 2400, spreadStill: 0, spreadMoving: 6, pellets: 1, falloffStart: 2400, falloffMul: 1, recoil: 0, shake: 8 },
  { id: W_KNIFE, name: 'Knife', kind: 'melee', damage: 55, rate: 2, mag: 0, reserve: 0, reloadSec: 0, range: 64, spreadStill: 60, spreadMoving: 60, pellets: 0, falloffStart: 64, falloffMul: 1, recoil: 0, shake: 1 },
  { id: W_FRAG, name: 'Frag', kind: 'thrown', damage: 90, rate: 1.25, mag: 0, reserve: 0, reloadSec: 0, range: 150, spreadStill: 0, spreadMoving: 0, pellets: 0, falloffStart: 0, falloffMul: 1, recoil: 0, shake: 10 },
];

export const PRIMARIES = [W_AR, W_SHOTGUN, W_SNIPER];

export function isGun(w: number): boolean {
  return w === W_PISTOL || w === W_AR || w === W_SHOTGUN || w === W_SNIPER;
}

export function isPrimary(w: number): boolean {
  return w === W_AR || w === W_SHOTGUN || w === W_SNIPER;
}

/** Weapons a player may hold (equip) in each mode. Grenades in Arms are thrown with their own key. */
export function allowedWeapons(mode: number, primary: number): number[] {
  if (mode === MODE_BLADES) return [W_KNIFE];
  if (mode === MODE_BOOM) return [W_FRAG, W_KNIFE];
  return [primary, W_PISTOL, W_KNIFE];
}

export function defaultWeapon(mode: number, primary: number): number {
  if (mode === MODE_BLADES) return W_KNIFE;
  if (mode === MODE_BOOM) return W_FRAG;
  return primary;
}

export function canMelee(mode: number): boolean {
  return mode === MODE_ARMS || mode === MODE_BLADES || mode === MODE_BOOM;
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
