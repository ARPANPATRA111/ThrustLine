// Connection to the SpacetimeDB database: connect/reconnect, room-scoped subscriptions and
// thin wrappers around reducer calls.
import type { Identity } from 'spacetimedb';
import { DbConnection, tables, type EventContext, type SubscriptionHandle } from '../module_bindings';
import type {
  BoomEv, EmoteEv, Grenade, HitEv, KickEv, KillEv, MeleeEv, NoticeEv, Pickup, PickupEv, Player, PongEv, Pstate, Room, ShotEv,
} from '../module_bindings/types';

export const STDB_URI: string = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const STDB_DB: string = import.meta.env.VITE_STDB_DB ?? 'thrustline-dev';
const TOKEN_KEY = `tl:token:${STDB_URI}/${STDB_DB}`;
const ROOM_KEY = 'tl:room';
/** Initial-connection retry delays (ms), then every 8 s. */
const BACKOFF = [500, 1000, 2000, 4000, 8000];

export type ConnState = 'connecting' | 'waking' | 'connected' | 'reconnecting' | 'offline';

/** Callbacks the game registers. Every handler is optional. */
export interface NetHandlers {
  roomChanged?: (r: Room | undefined) => void;
  playerUpsert?: (p: Player, old: Player | undefined) => void;
  playerDelete?: (p: Player) => void;
  pstateUpsert?: (s: Pstate) => void;
  pstateDelete?: (s: Pstate) => void;
  pickupUpsert?: (p: Pickup) => void;
  pickupDelete?: (p: Pickup) => void;
  grenadeInsert?: (g: Grenade) => void;
  grenadeDelete?: (g: Grenade) => void;
  shot?: (e: ShotEv) => void;
  hit?: (e: HitEv) => void;
  kill?: (e: KillEv) => void;
  melee?: (e: MeleeEv) => void;
  boom?: (e: BoomEv) => void;
  pickupTaken?: (e: PickupEv) => void;
  emote?: (e: EmoteEv) => void;
  notice?: (e: NoticeEv) => void;
  pong?: (e: PongEv) => void;
  kicked?: (e: KickEv) => void;
  state?: (s: ConnState) => void;
  reconnected?: () => void;
}

export class Net {
  conn: DbConnection | null = null;
  identity: Identity | null = null;
  h: NetHandlers = {};
  private roomSub: SubscriptionHandle | null = null;
  private roomSubId: bigint | null = null;

  get myKey(): string {
    return this.identity ? this.identity.toHexString() : '';
  }

  /** Connect (retrying with backoff until it works). Resolves on the first successful connection. */
  connect(): Promise<void> {
    return new Promise((resolve) => {
      let attempt = 0;
      const tryOnce = () => {
        this.h.state?.(attempt === 0 ? 'connecting' : 'reconnecting');
        // Maincloud pauses idle databases; if the handshake is slow, say so.
        const wake = setTimeout(() => this.h.state?.('waking'), 3000);
        let established = false;
        DbConnection.builder()
          .withUri(STDB_URI)
          .withDatabaseName(STDB_DB)
          .withToken(sessionStorage.getItem(TOKEN_KEY) ?? undefined)
          .withConfirmedReads(false) // updates arrive as soon as they commit in memory
          .withAutomaticReconnect({ minDelayMs: 500, maxDelayMs: 8000 })
          .onConnect((conn, identity, token) => {
            established = true;
            clearTimeout(wake);
            sessionStorage.setItem(TOKEN_KEY, token);
            this.conn = conn;
            this.identity = identity;
            this.register(conn);
            this.subscribeSelf(conn, identity);
            this.h.state?.('connected');
            resolve();
          })
          .onAutomaticReconnect((_conn, _identity, token) => {
            sessionStorage.setItem(TOKEN_KEY, token);
            this.h.state?.('connected');
            this.h.reconnected?.();
          })
          .onDisconnect((_ctx, _err, next) => {
            this.h.state?.(next !== undefined ? 'reconnecting' : 'offline');
            if (next === undefined && established) {
              // Automatic recovery gave up: start over with a fresh connection object.
              this.conn = null;
              this.roomSub = null;
              this.roomSubId = null;
              attempt = 1;
              setTimeout(tryOnce, 1000);
            }
          })
          .onConnectError((_ctx, err) => {
            clearTimeout(wake);
            if (established) return; // the SDK's automatic reconnect handles established connections
            console.warn('connect failed', err);
            if (/token|auth|401|403/i.test(String(err))) sessionStorage.removeItem(TOKEN_KEY);
            const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
            attempt++;
            this.h.state?.('reconnecting');
            setTimeout(tryOnce, delay);
          })
          .build();
      };
      tryOnce();
    });
  }

  /** Forward row and event callbacks from the SDK to the game's handlers. */
  private register(conn: DbConnection): void {
    const db = conn.db;
    const h = () => this.h;
    db.room.onInsert((_c: EventContext, r) => h().roomChanged?.(r));
    db.room.onUpdate((_c: EventContext, _o, r) => h().roomChanged?.(r));
    db.room.onDelete((_c: EventContext) => h().roomChanged?.(undefined));
    db.player.onInsert((_c: EventContext, p) => h().playerUpsert?.(p, undefined));
    db.player.onUpdate((_c: EventContext, o, p) => h().playerUpsert?.(p, o));
    db.player.onDelete((_c: EventContext, p) => h().playerDelete?.(p));
    db.pstate.onInsert((_c: EventContext, s) => h().pstateUpsert?.(s));
    db.pstate.onUpdate((_c: EventContext, _o, s) => h().pstateUpsert?.(s));
    db.pstate.onDelete((_c: EventContext, s) => h().pstateDelete?.(s));
    db.pickup.onInsert((_c: EventContext, p) => h().pickupUpsert?.(p));
    db.pickup.onUpdate((_c: EventContext, _o, p) => h().pickupUpsert?.(p));
    db.pickup.onDelete((_c: EventContext, p) => h().pickupDelete?.(p));
    db.grenade.onInsert((_c: EventContext, g) => h().grenadeInsert?.(g));
    db.grenade.onDelete((_c: EventContext, g) => h().grenadeDelete?.(g));
    db.shotEv.onInsert((_c: EventContext, e) => h().shot?.(e));
    db.hitEv.onInsert((_c: EventContext, e) => h().hit?.(e));
    db.killEv.onInsert((_c: EventContext, e) => h().kill?.(e));
    db.meleeEv.onInsert((_c: EventContext, e) => h().melee?.(e));
    db.boomEv.onInsert((_c: EventContext, e) => h().boom?.(e));
    db.pickupEv.onInsert((_c: EventContext, e) => h().pickupTaken?.(e));
    db.emoteEv.onInsert((_c: EventContext, e) => h().emote?.(e));
    db.noticeEv.onInsert((_c: EventContext, e) => h().notice?.(e));
    db.pongEv.onInsert((_c: EventContext, e) => h().pong?.(e));
    db.kickEv.onInsert((_c: EventContext, e) => h().kicked?.(e));
  }

  /** Always-on subscription: my own player row (tells me my room), pongs and kick notices for me. */
  private subscribeSelf(conn: DbConnection, me: Identity): void {
    conn.subscriptionBuilder()
      .onError((ctx) => console.error('self subscription failed', ctx.event))
      .subscribe([tables.player.where((r) => r.identity.eq(me)), tables.pongEv.where((r) => r.to.eq(me)), tables.kickEv.where((r) => r.to.eq(me))]);
  }

  /** Subscribe to exactly one room's rows and events; switching rooms swaps the subscription. */
  subscribeRoom(roomId: bigint | null): void {
    if (!this.conn || roomId === this.roomSubId) return;
    const old = this.roomSub;
    this.roomSub = null;
    this.roomSubId = roomId;
    if (roomId !== null) {
      // Subscribe to the new room before dropping the old one (recommended ordering).
      this.roomSub = this.conn.subscriptionBuilder()
        .onError((ctx) => console.error('room subscription failed', ctx.event))
        .subscribe([
          tables.room.where((r) => r.id.eq(roomId)),
          tables.player.where((r) => r.roomId.eq(roomId)),
          tables.pstate.where((r) => r.roomId.eq(roomId)),
          tables.pickup.where((r) => r.roomId.eq(roomId)),
          tables.grenade.where((r) => r.roomId.eq(roomId)),
          tables.shotEv.where((r) => r.roomId.eq(roomId)),
          tables.hitEv.where((r) => r.roomId.eq(roomId)),
          tables.killEv.where((r) => r.roomId.eq(roomId)),
          tables.meleeEv.where((r) => r.roomId.eq(roomId)),
          tables.boomEv.where((r) => r.roomId.eq(roomId)),
          tables.pickupEv.where((r) => r.roomId.eq(roomId)),
          tables.emoteEv.where((r) => r.roomId.eq(roomId)),
          tables.noticeEv.where((r) => r.roomId.eq(roomId)),
        ]);
    }
    if (old && !old.isEnded()) old.unsubscribe();
  }

  // ---- Remembered room code (sessionStorage) for reconnect / reload ----
  static get savedRoom(): string | null {
    return sessionStorage.getItem(ROOM_KEY);
  }
  static set savedRoom(code: string | null) {
    if (code) sessionStorage.setItem(ROOM_KEY, code);
    else sessionStorage.removeItem(ROOM_KEY);
  }
}

/** A short error message from a failed reducer call (SenderError text). */
export function errorText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^.*?:\s*(?=[A-Z])/, '').slice(0, 120) || 'Something went wrong';
}

/**
 * Open an extra, throwaway connection with a brand-new identity (no saved token).
 * Used by CPU players: each bot is a real client that joins the room and calls `sync`.
 */
export function openBotConnection(): Promise<{ conn: DbConnection; identity: Identity }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bot connection timed out')), 15000);
    DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_DB)
      .withConfirmedReads(false)
      .onConnect((conn, identity) => {
        clearTimeout(timer);
        resolve({ conn, identity });
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e);
      })
      .build();
  });
}
