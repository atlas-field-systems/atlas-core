import { PictureError } from "./errors.js";
import type { FeedChange, FeedGap, FeedHello } from "./types.js";

/**
 * Messages Core may send before the reader takes them. A reader that falls
 * this far behind is disconnected; it reconnects and replays.
 */
const maxQueuedMessages = 1_000;

/** Time Core has to answer authentication with FeedHello. */
const helloTimeoutMs = 5_000;

type Delivery = FeedChange | FeedGap;

interface FeedEvents {
  hello(hello: FeedHello): void;
  failed(error: Error): void;
}

/** One authenticated feed connection whose messages are read in order. */
export class FeedConnection {
  readonly #socket: WebSocket;
  readonly #events: FeedEvents;
  readonly #queue: Delivery[] = [];
  #waiting?: { resolve: (message: Delivery) => void; reject: (error: Error) => void };
  #failure?: Error;

  private constructor(socket: WebSocket, events: FeedEvents) {
    this.#socket = socket;
    this.#events = events;
    socket.addEventListener("message", (event) => this.#receive(String(event.data)));
    socket.addEventListener("close", () => this.#fail(new PictureError("feed_closed", "The feed connection closed.")));
    socket.addEventListener("error", () => this.#fail(new PictureError("feed_closed", "The feed connection failed.")));
  }

  /** Authenticates on a new socket and resolves with Core's FeedHello. */
  static open(socket: WebSocket, apiKey: string): Promise<{ connection: FeedConnection; hello: FeedHello }> {
    return new Promise((resolve, reject) => {
      const connection = new FeedConnection(socket, {
        hello: (hello) => { clearTimeout(timeout); resolve({ connection, hello }); },
        failed: (error) => { clearTimeout(timeout); reject(error); },
      });
      const timeout = setTimeout(() => connection.#fail(new PictureError("feed_timeout", "The feed did not confirm its subscription.")), helloTimeoutMs);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ api_key: apiKey })));
    });
  }

  /** Resolves with the next change or gap; rejects once the connection ends. */
  next(): Promise<Delivery> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => { this.#waiting = { resolve, reject }; });
  }

  close(): void {
    this.#fail(new PictureError("feed_closed", "The feed connection closed."));
  }

  #receive(data: string): void {
    const message = parseMessage(data);
    if (!message) return this.#fail(new PictureError("feed_invalid", "Core sent a malformed feed message."));
    if (message.type === "hello") return this.#events.hello(message);
    if (this.#waiting) {
      this.#waiting.resolve(message);
      this.#waiting = undefined;
    } else if (this.#queue.push(message) > maxQueuedMessages) {
      this.#fail(new PictureError("feed_overflow", "The feed reader fell behind."));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#queue.length = 0;
    this.#waiting?.reject(error);
    this.#waiting = undefined;
    this.#events.failed(error);
    this.#socket.close();
  }
}

/**
 * Checks the fields the picture relies on before a message is used. Values
 * are otherwise trusted as Core's Protocol output.
 */
function parseMessage(data: string): FeedHello | Delivery | undefined {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(message)) return undefined;
  if (message.type === "hello" && typeof message.cursor === "string" && Number.isSafeInteger(message.sequence)) return message as FeedHello;
  if (message.type === "gap") return message as FeedGap;
  if (message.type === "change" && typeof message.cursor === "string" && isChange(message.change)) return message as FeedChange;
  return undefined;
}

function isChange(change: unknown): boolean {
  return isRecord(change) && Number.isSafeInteger(change.sequence) && isRecord(change.entity) && change.entity.id === change.resource_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
