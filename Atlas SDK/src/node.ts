import { Agent, fetch as undiciFetch } from "undici";

// nodeFetch returns a fetch for Node callers that trusts the supplied
// installation CA for HTTPS, with ordinary certificate and hostname
// verification. There is no option to disable verification. Requests and
// responses cross into undici's own fetch so its connection options apply
// without changing process-wide dispatch.
export function nodeFetch(options: { ca: string | Uint8Array }): (request: Request) => Promise<Response> {
  const ca = typeof options.ca === "string" ? options.ca : new TextDecoder().decode(options.ca);
  const dispatcher = new Agent({ connect: { ca, rejectUnauthorized: true } });
  return async (request: Request) => {
    const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body,
      redirect: "error",
      signal: request.signal,
      dispatcher,
    });
    return new Response(response.body === null ? null : bridged(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  };
}

// bridged re-exposes undici's response stream as a global stream without
// buffering, so response size bounds still apply while the body is read.
function bridged(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
