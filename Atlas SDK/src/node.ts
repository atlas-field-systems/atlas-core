import { request as httpsRequest } from "node:https";
import { gzipSync } from "node:zlib";

export type HTTPSFetchOptions = {
  ca?: string | Buffer;
  maxJSONBytes: number;
  timeoutMs: number;
};

/** A bounded HTTPS transport with the platform's ordinary certificate checks. */
export function createHTTPSFetch(options: HTTPSFetchOptions): typeof fetch {
  if (
    !Number.isSafeInteger(options.maxJSONBytes) ||
    options.maxJSONBytes <= 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new RangeError("HTTPS limits must be positive safe integers");
  }
  const gzipReceivers = new Set<string>();
  return async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new TypeError("Atlas requires a credential-free HTTPS URL");
    }
    const signal = AbortSignal.any([outgoing.signal, AbortSignal.timeout(options.timeoutMs)]);
    signal.throwIfAborted();
    let body = outgoing.body ? await boundedBytes(outgoing.body, options.maxJSONBytes, signal) : Buffer.alloc(0);
    const headers = Object.fromEntries(outgoing.headers);
    if (headers["content-encoding"] && headers["content-encoding"] !== "identity") {
      throw new TypeError("The transport accepts original request bytes");
    }
    delete headers["content-encoding"];
    headers.host = url.host;
    headers.connection = "close";
    headers["accept-encoding"] = "gzip, identity";
    if (outgoing.body) headers["content-length"] = String(body.length);
    else delete headers["content-length"];
    if (
      outgoing.body &&
      headers["content-type"]?.split(";", 1)[0]?.trim() === "application/json" &&
      gzipReceivers.has(url.origin)
    ) {
      const compressed = gzipSync(body);
      const compressedHeaders = { ...headers, "content-encoding": "gzip", "content-length": String(compressed.length) };
      if (
        messageSize(outgoing.method, url, compressedHeaders, compressed) <
        messageSize(outgoing.method, url, headers, body)
      ) {
        body = compressed;
        Object.assign(headers, compressedHeaders);
      }
    }
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: outgoing.method,
          headers,
          ...(options.ca === undefined ? {} : { ca: options.ca }),
          signal,
          agent: false,
        },
        (response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > options.maxJSONBytes) throw new RangeError("Encoded response exceeds the configured limit");
              chunks.push(bytes);
            }
            let decoded: Buffer = Buffer.concat(chunks, size);
            const responseHeaders = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              const key = response.rawHeaders[index];
              const value = response.rawHeaders[index + 1];
              if (key !== undefined && value !== undefined) responseHeaders.append(key, value);
            }
            const coding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
            if (coding === "gzip") {
              // The standard gzip stream rejects extra members and trailing bytes.
              const compressed = new ReadableStream<BufferSource>({
                start(controller) {
                  controller.enqueue(new Uint8Array(decoded));
                  controller.close();
                },
              });
              decoded = await boundedBytes(
                compressed.pipeThrough(new DecompressionStream("gzip")),
                options.maxJSONBytes,
                signal,
              );
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            } else if (coding && coding !== "identity") {
              throw new TypeError("Unsupported response encoding");
            }
            const status = response.statusCode;
            if (status === undefined) throw new TypeError("Missing HTTP response status");
            if (status >= 300 && status < 400 && responseHeaders.has("location")) {
              throw new TypeError("Atlas transport does not follow redirects");
            }
            if (acceptsGzip(responseHeaders.get("accept-encoding"))) gzipReceivers.add(url.origin);
            else gzipReceivers.delete(url.origin);
            resolve(
              new Response(
                [204, 205, 304].includes(status) || outgoing.method === "HEAD" ? null : new Uint8Array(decoded),
                {
                  status,
                  headers: responseHeaders,
                },
              ),
            );
          })().catch((error) => {
            response.destroy();
            reject(error);
          });
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  };
}

async function boundedBytes(stream: ReadableStream<Uint8Array>, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const result = await Promise.race([reader.read(), cancelled]);
      signal.throwIfAborted();
      if (result.done) return Buffer.concat(chunks, size);
      size += result.value.byteLength;
      if (size > maximum) throw new RangeError("JSON message exceeds the configured limit");
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    try {
      // Cancellation belongs to the caller's stream implementation and may
      // never settle. It cannot extend the request's deadline indefinitely.
      await Promise.race([
        reader.cancel(error),
        cancelled.catch(() => {
          throw new Error("Stream cancellation did not finish before the request ended", { cause: signal.reason });
        }),
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Reading and cancelling the bounded stream failed");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function messageSize(method: string, url: URL, headers: Record<string, string>, body: Buffer): number {
  const head =
    `${method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    "\r\n";
  return Buffer.byteLength(head) + body.length;
}

function acceptsGzip(value: string | null): boolean {
  return (
    value?.split(",").some((part) => {
      const [coding, ...parameters] = part.trim().split(";");
      const quality = parameters
        .find((parameter) => parameter.trim().startsWith("q="))
        ?.trim()
        .slice(2);
      return coding?.trim().toLowerCase() === "gzip" && (quality === undefined || Number(quality) > 0);
    }) ?? false
  );
}
