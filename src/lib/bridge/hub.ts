import { logger } from "@/lib/logger";
import {
  incomingMessageSchema,
  type Envelope,
  type OutgoingMessage,
  type ReceivedPayload,
  type RequestDataPayload,
  type ResponseDataPayload,
  type SendDataPayload,
} from "./protocol";

/**
 * What the dashboard knows about an app's connection.
 *  - coming-soon   registered but not built yet
 *  - idle          not loaded in this session
 *  - loading       frame is loading, or loaded and not yet heard from
 *  - ready         the app's bridge answered: data can be sent
 *  - no-bridge     the page loaded but nothing answered: bridge.js is not installed (or a 404 page)
 *  - unresponsive  it was ready and stopped answering pings
 *  - failed        the frame never finished loading
 */
export type AppHealth =
  "coming-soon" | "idle" | "loading" | "ready" | "no-bridge" | "unresponsive" | "failed";

/** The part of an app registry entry the hub needs. */
export interface HubApp {
  id: string;
  /** Exact origin the app is served from; null when it has no URL. */
  origin: string | null;
  protocolVersion: number;
  accepts: readonly string[];
  produces: readonly string[];
  active: boolean;
}

export type SendFailure =
  /** Coming soon, not loaded, or the session ended. */
  | "unavailable"
  /** The app never became ready within the time limit. */
  | "not-ready"
  /** The data was posted but no acknowledgement came back in time. */
  | "timeout"
  /** The app answered that it could not accept the data. */
  | "rejected";

export type SendOutcome =
  { ok: true; id: string } | { ok: false; id: string; reason: SendFailure; error?: string };

export interface HubHandlers {
  /** An app sent data to the dashboard. The return value is the acknowledgement. */
  onData?: (appId: string, payload: SendDataPayload) => ReceivedPayload;
  /** An app asked for data. Resolve with what to reply (after checking permissions). */
  onRequest?: (appId: string, payload: RequestDataPayload) => Promise<ResponseDataPayload>;
}

export interface HubOptions {
  apps: readonly HubApp[];
  /** How the dashboard names itself in envelopes. */
  selfId: string;
  /** Total time a send may take, from queueing to acknowledgement. */
  ackTimeoutMs?: number;
  /** How long a loaded page has to answer before it counts as having no bridge. */
  readyTimeoutMs?: number;
  /** How long a frame has to fire `load` before it counts as failed. */
  loadTimeoutMs?: number;
  pingIntervalMs?: number;
  newId?: () => string;
}

interface AppState {
  app: HubApp;
  health: AppHealth;
  /** Returns the iframe's window right now, or null if it is not mounted. */
  frame: (() => Window | null) | null;
  /** The current page has proven it has a working bridge. */
  ready: boolean;
  loaded: boolean;
  /** Id of the ping we are waiting on, if any. */
  pingId: string | null;
  missedPings: number;
  loadTimer: ReturnType<typeof setTimeout> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  /** Sends waiting for the app to become ready, by message id. */
  queue: Map<string, Envelope>;
}

interface PendingSend {
  appId: string;
  posted: boolean;
  promise: Promise<SendOutcome>;
  resolve: (outcome: SendOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MISSED_PINGS_BEFORE_UNRESPONSIVE = 2;

/**
 * The dashboard side of the bridge. Framework-free so it can be tested on its own.
 *
 * Trust rules, applied to every incoming message in this order:
 *  1. `event.source` must be the window of a registered app's iframe. All apps share one
 *     origin, so the origin alone says nothing about which app is talking.
 *  2. `event.origin` must equal that app's exact origin.
 *  3. The message must match the protocol schema, the app's protocol version, and be
 *     addressed from that app to the dashboard.
 * Anything else is dropped and logged without its contents. Outgoing messages always use the
 * app's exact origin as targetOrigin, never "*".
 */
export class BridgeHub {
  private readonly states = new Map<string, AppState>();
  private readonly pending = new Map<string, PendingSend>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Readonly<Record<string, AppHealth>> = {};
  private handlers: HubHandlers = {};
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private readonly selfId: string;
  private readonly ackTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly newId: () => string;

  constructor(options: HubOptions) {
    this.selfId = options.selfId;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 6_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 20_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.newId = options.newId ?? (() => crypto.randomUUID());

    for (const app of options.apps) {
      this.states.set(app.id, {
        app,
        health: app.active && app.origin ? "idle" : "coming-soon",
        frame: null,
        ready: false,
        loaded: false,
        pingId: null,
        missedPings: 0,
        loadTimer: null,
        readyTimer: null,
        queue: new Map(),
      });
    }
    this.publish();
  }

  // ---------- lifecycle ----------

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("message", this.onMessage);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.pingTimer = setInterval(this.pingAll, this.pingIntervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener("message", this.onMessage);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  setHandlers(handlers: HubHandlers): void {
    this.handlers = handlers;
  }

  /** Forgets everything held in memory: queued payloads and sends in flight. Called on sign-out. */
  clear(): void {
    for (const state of this.states.values()) state.queue.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, id, reason: "unavailable" });
    }
    this.pending.clear();
  }

  // ---------- state for the UI ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Readonly<Record<string, AppHealth>> => this.snapshot;

  // ---------- frames ----------

  /** Call when an app's iframe is mounted. `frame` must return its contentWindow. */
  attachFrame(appId: string, frame: () => Window | null): void {
    const state = this.states.get(appId);
    if (!state || state.health === "coming-soon") return;
    this.resetConnection(state);
    state.frame = frame;
    state.loaded = false;
    state.loadTimer = setTimeout(() => {
      state.loadTimer = null;
      if (!state.loaded && !state.ready) this.setHealth(state, "failed");
    }, this.loadTimeoutMs);
    this.setHealth(state, "loading");
  }

  detachFrame(appId: string): void {
    const state = this.states.get(appId);
    if (!state || state.health === "coming-soon") return;
    this.resetConnection(state);
    state.frame = null;
    state.loaded = false;
    this.setHealth(state, "idle");
  }

  /**
   * Call on every iframe `load` event (first load, reload, or navigation inside the frame).
   * Whatever answered before may be gone, so readiness is withdrawn and the page now in the
   * frame is asked to prove itself with a ping. Until it does, sends stay queued, which stops
   * an earlier page's `ready` from releasing data to a different page.
   */
  frameLoaded(appId: string): void {
    const state = this.states.get(appId);
    if (!state || !state.frame) return;
    this.resetConnection(state);
    state.loaded = true;
    this.setHealth(state, "loading");
    this.ping(state);
    state.readyTimer = setTimeout(() => {
      state.readyTimer = null;
      if (!state.ready) this.setHealth(state, "no-bridge");
    }, this.readyTimeoutMs);
  }

  // ---------- sending ----------

  /**
   * Sends data to an app and waits for its acknowledgement.
   * If the app is not ready yet the message waits in memory until it is. Either way the whole
   * thing gives up after `ackTimeoutMs`. Pass the `id` of a failed attempt to retry it: the
   * app's bridge ignores an id it has already handled, so a retry can never import twice.
   */
  send(
    appId: string,
    payload: SendDataPayload,
    options: { id?: string } = {},
  ): Promise<SendOutcome> {
    const id = options.id ?? this.newId();
    const existing = this.pending.get(id);
    if (existing) return existing.promise;

    const state = this.states.get(appId);
    if (!state || !state.frame || !state.app.origin) {
      return Promise.resolve({ ok: false, id, reason: "unavailable" });
    }

    const envelope = this.envelope(state, { type: "send-data", payload }, id);
    let resolve!: (outcome: SendOutcome) => void;
    const promise = new Promise<SendOutcome>((done) => {
      resolve = done;
    });
    const entry: PendingSend = {
      appId,
      posted: false,
      promise,
      resolve,
      timer: setTimeout(() => {
        this.pending.delete(id);
        state.queue.delete(id);
        resolve({ ok: false, id, reason: entry.posted ? "timeout" : "not-ready" });
      }, this.ackTimeoutMs),
    };
    this.pending.set(id, entry);

    if (state.ready) {
      entry.posted = this.post(state, envelope);
    } else {
      state.queue.set(id, envelope);
    }
    return promise;
  }

  // ---------- internals ----------

  private envelope(state: AppState, message: OutgoingMessage, id: string): Envelope {
    return {
      type: message.type,
      from: this.selfId,
      to: state.app.id,
      version: state.app.protocolVersion,
      id,
      payload: message.payload,
    };
  }

  /** Posts to the app's frame with its exact origin. Returns false if there is no window to post to. */
  private post(state: AppState, envelope: Envelope): boolean {
    const target = state.frame?.();
    if (!target || !state.app.origin) return false;
    try {
      target.postMessage(envelope, state.app.origin);
      return true;
    } catch {
      return false;
    }
  }

  private reply(state: AppState, message: OutgoingMessage, id: string): void {
    this.post(state, this.envelope(state, message, id));
  }

  private ping(state: AppState): void {
    const id = this.newId();
    state.pingId = id;
    this.post(state, this.envelope(state, { type: "ping", payload: {} }, id));
  }

  private resetConnection(state: AppState): void {
    state.ready = false;
    state.pingId = null;
    state.missedPings = 0;
    if (state.loadTimer) clearTimeout(state.loadTimer);
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.loadTimer = null;
    state.readyTimer = null;
  }

  private markReady(state: AppState): void {
    if (state.loadTimer) clearTimeout(state.loadTimer);
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.loadTimer = null;
    state.readyTimer = null;
    state.ready = true;
    // Hearing from the app settles any ping still outstanding.
    state.pingId = null;
    state.missedPings = 0;
    this.setHealth(state, "ready");

    for (const [id, envelope] of state.queue) {
      const pending = this.pending.get(id);
      if (pending) pending.posted = this.post(state, envelope);
    }
    state.queue.clear();
  }

  private setHealth(state: AppState, health: AppHealth): void {
    if (state.health === health) return;
    state.health = health;
    this.publish();
  }

  private publish(): void {
    this.snapshot = Object.fromEntries([...this.states].map(([id, s]) => [id, s.health]));
    for (const listener of this.listeners) listener();
  }

  private readonly pingAll = (): void => {
    // Background tabs throttle timers; pinging there would produce false alarms.
    if (document.visibilityState === "hidden") return;
    for (const state of this.states.values()) {
      if (!state.frame || !state.loaded) continue;
      if (state.pingId !== null && state.ready) {
        state.missedPings += 1;
        if (state.missedPings >= MISSED_PINGS_BEFORE_UNRESPONSIVE) {
          state.ready = false;
          this.setHealth(state, "unresponsive");
        }
      }
      this.ping(state);
    }
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      // Pings sent just before hiding may be answered late; don't count them as missed.
      for (const state of this.states.values()) state.pingId = null;
    } else {
      this.pingAll();
    }
  };

  private reject(state: AppState, reason: string): void {
    // Reason and app only. Never the message contents.
    logger.warn("Bridge rejected a message.", { app: state.app.id, reason });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    // 1. Which registered iframe is this from? Unknown windows (extensions, other frames) are ignored.
    let state: AppState | undefined;
    for (const candidate of this.states.values()) {
      const frame = candidate.frame?.();
      if (frame && event.source === frame) {
        state = candidate;
        break;
      }
    }
    if (!state) return;

    // 2. Exact origin.
    if (event.origin !== state.app.origin) return this.reject(state, "wrong-origin");

    // 3. Shape, version, addressing.
    const parsed = incomingMessageSchema.safeParse(event.data);
    if (!parsed.success) return this.reject(state, "invalid-message");
    const message = parsed.data;
    if (message.version !== state.app.protocolVersion) return this.reject(state, "wrong-version");
    if (message.from !== state.app.id || message.to !== this.selfId) {
      return this.reject(state, "wrong-addressing");
    }

    switch (message.type) {
      case "ready":
        this.markReady(state);
        // Answer straight away, so the app knows it is connected without waiting for the next ping.
        this.ping(state);
        return;

      case "pong":
        if (message.id !== state.pingId) return;
        state.pingId = null;
        this.markReady(state);
        return;

      case "ping":
        this.reply(state, { type: "pong", payload: {} }, message.id);
        return;

      case "received": {
        const pending = this.pending.get(message.id);
        // Unknown id = an acknowledgement that arrived after we gave up. Ignore it.
        if (!pending || pending.appId !== state.app.id) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(
          message.payload.ok
            ? { ok: true, id: message.id }
            : { ok: false, id: message.id, reason: "rejected", error: message.payload.error },
        );
        return;
      }

      case "send-data": {
        let ack: ReceivedPayload;
        if (!state.app.produces.includes(message.payload.dataType)) {
          ack = { ok: false, error: "This app is not registered to send this kind of data." };
        } else if (!this.handlers.onData) {
          ack = { ok: false, error: "The dashboard is not ready to receive data." };
        } else {
          ack = this.handlers.onData(state.app.id, message.payload);
        }
        this.reply(state, { type: "received", payload: ack }, message.id);
        return;
      }

      case "request-data": {
        const respond = (payload: ResponseDataPayload) =>
          this.reply(state, { type: "response-data", payload }, message.id);
        if (!state.app.accepts.includes(message.payload.dataType)) {
          respond({ ok: false, error: "This app is not registered to receive this kind of data." });
        } else if (!this.handlers.onRequest) {
          respond({ ok: false, error: "The dashboard is not ready to answer requests." });
        } else {
          this.handlers
            .onRequest(state.app.id, message.payload)
            .then(respond)
            .catch(() => respond({ ok: false, error: "The dashboard could not get the data." }));
        }
        return;
      }
    }
  };
}
