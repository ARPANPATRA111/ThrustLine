// A soldier assembled from atlas parts and animated in code (no frame sheets):
// legs swing with speed, the body bobs, the arm and gun rotate to the aim angle,
// the jet flame flickers while thrusting.
import { BitmapText, Container, Sprite, type Texture } from 'pixi.js';
import { FLAG_GROUNDED, FLAG_JETTING, PLAYER_H } from '@shared/config';
import { FONT } from './font';

export const PLAYER_COLORS = [0x22d3ee, 0xf472b6, 0xa3e635, 0xfbbf24, 0xa78bfa, 0xfb7185];
export const PLAYER_CSS = ['#22D3EE', '#F472B6', '#A3E635', '#FBBF24', '#A78BFA', '#FB7185'];
export const GOLD = 0xffd54a;

function part(tex: Texture, ax: number, ay: number): Sprite {
  const s = new Sprite(tex);
  s.anchor.set(ax, ay);
  return s;
}

export class SoldierView {
  root = new Container();
  private body = new Container();
  private legL: Sprite;
  private legR: Sprite;
  private torso: Sprite;
  private helmet: Sprite;
  private visor: Sprite;
  private jet: Sprite;
  private flame: Sprite;
  private armGroup = new Container();
  private gun: Sprite;
  private bubble: Sprite;
  private crown: Sprite;
  private tag: BitmapText;
  private phase = 0;
  private flameTick = 0;
  private currentWeapon = -1;

  constructor(private tex: Record<string, Texture>, name: string, colorIdx: number) {
    this.legL = part(tex.leg, 0.5, 0.1);
    this.legR = part(tex.leg, 0.5, 0.1);
    this.torso = part(tex.torso, 0.5, 0.5);
    this.helmet = part(tex.helmet, 0.5, 0.5);
    this.visor = part(tex.visor, 0.2, 0.5);
    this.jet = part(tex.jetpack, 0.5, 0.5);
    this.flame = part(tex.flame0, 0.5, 0);
    this.flame.blendMode = 'add';
    this.gun = part(tex.w0, 0.15, 0.5);
    const arm = part(tex.arm, 0.1, 0.5);
    this.armGroup.addChild(this.gun, arm);
    this.gun.x = 9;
    this.bubble = part(tex.bubble, 0.5, 0.5);
    this.bubble.blendMode = 'add';
    this.crown = part(tex.crown, 0.5, 1);

    // Layout relative to the feet at (0, 0); y grows downward.
    this.legL.position.set(-4, -18);
    this.legR.position.set(4, -18);
    this.jet.position.set(-10, -30);
    this.flame.position.set(-10, -20);
    this.torso.position.set(0, -28);
    this.helmet.position.set(1, -42);
    this.visor.position.set(2, -42);
    this.armGroup.position.set(0, -30);
    this.body.addChild(this.flame, this.jet, this.legL, this.legR, this.torso, this.helmet, this.visor, this.armGroup);

    this.bubble.position.set(0, -PLAYER_H / 2);
    this.crown.position.set(0, -58);
    this.tag = new BitmapText({ text: name, style: { fontFamily: FONT, fontSize: 13 } });
    this.tag.anchor.set(0.5, 1);
    this.tag.position.set(0, -60);
    this.tag.alpha = 0.9;
    this.root.addChild(this.body, this.bubble, this.crown, this.tag);
    this.setColor(colorIdx);
  }

  setColor(colorIdx: number): void {
    const c = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
    this.torso.tint = c;
    this.helmet.tint = c;
    this.armGroup.children[1].tint = c;
    this.tag.tint = c;
  }

  setName(name: string): void {
    if (this.tag.text !== name) this.tag.text = name;
  }

  /**
   * Pose the soldier. (x, y) are the feet; aim in radians; flags from pstate.
   * `dt` drives the walk cycle; `bounty` adds a gold glow; `shielded` shows the spawn bubble.
   */
  update(x: number, y: number, aim: number, vx: number, flags: number, weapon: number, dt: number, bounty: boolean, shielded: boolean): void {
    this.root.position.set(Math.round(x), Math.round(y));
    const facingRight = Math.cos(aim) >= 0;
    this.body.scale.x = facingRight ? 1 : -1;
    // In the mirrored body, a local rotation θ shows as world angle π-θ.
    this.armGroup.rotation = facingRight ? aim : Math.PI - aim;

    if (weapon !== this.currentWeapon) {
      this.currentWeapon = weapon;
      this.gun.texture = this.tex[`w${weapon}`];
    }

    const grounded = (flags & FLAG_GROUNDED) !== 0;
    const jetting = (flags & FLAG_JETTING) !== 0;
    const speed = Math.abs(vx);
    if (grounded && speed > 20) {
      this.phase += dt * (6 + speed / 30);
      const swing = Math.sin(this.phase) * Math.min(0.7, speed / 300);
      // Legs swing opposite to each other; walking backwards reverses the cycle.
      const dir = (vx >= 0) === facingRight ? 1 : -1;
      this.legL.rotation = swing * dir;
      this.legR.rotation = -swing * dir;
      this.torso.y = -28 - Math.abs(Math.cos(this.phase)) * 1.5;
    } else if (!grounded) {
      this.legL.rotation = 0.35;
      this.legR.rotation = -0.15;
      this.torso.y = -28;
    } else {
      this.legL.rotation *= 0.8;
      this.legR.rotation *= 0.8;
      this.torso.y = -28;
    }
    this.helmet.y = this.torso.y - 14;
    this.visor.y = this.helmet.y;

    this.flame.visible = jetting;
    if (jetting) {
      this.flameTick = (this.flameTick + 1) % 9;
      this.flame.texture = this.tex[`flame${(this.flameTick / 3) | 0}`];
    }
    this.bubble.visible = shielded;
    this.crown.visible = bounty;
    this.torso.alpha = 1;
    if (bounty) this.helmet.tint = GOLD;
  }

  /** Restore normal colour after bounty ends. */
  refreshColor(colorIdx: number, bounty: boolean): void {
    this.helmet.tint = bounty ? GOLD : PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
