/** Deterministic control points for scenarios; no timing guesses. */

/** A one-shot gate: code awaits `opened`, the scenario learns it `arrived`. */
export class Gate {
  constructor() {
    this.arrived = new Promise((resolve) => { this.arrive = resolve; });
    this.opened = new Promise((resolve) => { this.open = resolve; });
  }
}

/**
 * A fetch that, for the first request matching `matches`, receives Core's
 * response and then holds it at `gate` until the scenario opens it.
 */
export function gatedFetch(matches, gate, inner = fetch) {
  let used = false;
  return async (input, init) => {
    const request = new Request(input, init);
    const hold = !used && matches(request);
    used ||= hold;
    const response = await inner(request);
    if (hold) {
      gate.arrive();
      await gate.opened;
    }
    return response;
  };
}

/**
 * A WebSocket that passes the handshake through but holds every change
 * message until the scenario releases it, so delivery order is chosen by the
 * scenario.
 */
export class HeldFeed extends EventTarget {
  static into(list) {
    return (url) => {
      const feed = new HeldFeed(url);
      list.push(feed);
      return feed;
    };
  }

  held = [];

  constructor(url) {
    super();
    this.socket = new WebSocket(url);
    for (const type of ["open", "close", "error"]) this.socket.addEventListener(type, () => this.dispatchEvent(new Event(type)));
    this.socket.addEventListener("message", (event) => {
      if (JSON.parse(event.data).type === "change") this.held.push(event.data);
      else this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    });
  }

  send(data) { this.socket.send(data); }
  close() { this.socket.close(); }

  /** Delivers one held change, by position in arrival order. */
  release(index = 0) {
    const [data] = this.held.splice(index, 1);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/**
 * Waits for observable state the scenario cannot receive as an event, such
 * as a held message arriving. Fails after a bounded number of checks.
 */
export async function eventually(predicate, description, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
