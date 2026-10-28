export const WELCOME_AFTER = 10 * 60 * 1000;
export const RECONNECT_AFTER = 10000;
export const RECONNECT_STABLE = 3000;

// Pointer-down wakes the animation before click fires. Preserve the original
// sleep/away state until the gesture is confirmed as a click rather than a drag.
export class GreetingCues {
  constructor(now = Date.now()) {
    this.lastInteraction = now;
    this.prepared = null;
  }

  prepare(sleeping, now = Date.now()) {
    this.prepared = {
      sleeping,
      away:
        now >= this.lastInteraction &&
        now - this.lastInteraction >= WELCOME_AFTER,
    };
  }

  engage(now = Date.now()) {
    this.lastInteraction = now;
    this.prepared = null;
  }

  click(sleeping, eligible, sounds, now = Date.now()) {
    if (!this.prepared) this.prepare(sleeping, now);
    const original = this.prepared;
    this.engage(now);
    if (!eligible || !sounds.enabled || sounds.volume <= 0) return null;
    if (original?.away && sounds.welcome) return "welcome";
    if (original?.sleeping && sounds.wake) return "wake";
    return null;
  }
}

// Only recovery from an observed, sustained outage can announce a connection.
// Initial startup, changing servers, brief flaps and hidden/muted recoveries
// establish a new baseline without leaving a reminder to replay later.
export class ReconnectionCues {
  constructor() {
    this.endpoint = null;
    this.connectionEpoch = null;
    this.connected = false;
    this.hadConnection = false;
    this.offlineAt = null;
    this.stableAt = null;
    this.cue = null;
  }

  update(state, now, visible, sounds) {
    this.cue = null;
    const connected = state.connection === "connected";
    if (this.endpoint !== state.config.endpoint) {
      this.endpoint = state.config.endpoint;
      this.connectionEpoch = state.connectionEpoch;
      this.connected = connected;
      this.hadConnection = connected;
      this.offlineAt = null;
      this.stableAt = null;
      return false;
    }
    // A quick reconnect can be coalesced into a single "connected" snapshot.
    // A pending recovery must observe a full stable interval in this generation.
    if (
      connected &&
      this.connected &&
      this.connectionEpoch !== state.connectionEpoch &&
      this.stableAt !== null
    )
      this.stableAt =
        now >= this.stableAt && now - this.stableAt < RECONNECT_STABLE + 6000
          ? now
          : null;
    this.connectionEpoch = state.connectionEpoch;
    if (!connected) {
      if (this.connected && this.hadConnection) this.offlineAt = now;
      this.stableAt = null;
    } else {
      if (
        !this.connected &&
        this.offlineAt !== null &&
        now >= this.offlineAt &&
        now - this.offlineAt >= RECONNECT_AFTER
      )
        this.stableAt = now;
      this.offlineAt = null;
      this.hadConnection = true;
    }
    this.connected = connected;
    if (this.stableAt === null) return false;
    if (
      !visible ||
      !sounds.enabled ||
      sounds.volume <= 0 ||
      !sounds.reconnected ||
      now < this.stableAt
    ) {
      this.stableAt = null;
      return false;
    }
    if (now - this.stableAt < RECONNECT_STABLE) return false;
    // A suspended renderer must not announce an old recovery on resume.
    const fresh = now - this.stableAt < RECONNECT_STABLE + 6000;
    this.stableAt = null;
    if (!fresh) return false;
    this.cue = {
      at: now,
      endpoint: state.config.endpoint,
      connectionEpoch: state.connectionEpoch,
    };
    return true;
  }

  isCurrent(state, now, visible, cue) {
    return (
      !!cue &&
      visible &&
      state.connection === "connected" &&
      state.config.endpoint === cue.endpoint &&
      state.connectionEpoch === cue.connectionEpoch &&
      now >= cue.at &&
      now - cue.at < 6000
    );
  }
}
