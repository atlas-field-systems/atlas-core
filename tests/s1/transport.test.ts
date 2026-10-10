import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { ownedFixtureRoot, temporaryTLS } from "./tls.js";

test("trusted HTTPS keeps source bytes and selects gzip only after the receiver advertises support", async () => {
  await using tls = await temporaryTLS(ownedFixtureRoot(process.argv));
  const captured: { coding: string; message: Buffer; rawBytes: number }[] = [];
  await using server = createServer({ key: tls.key, cert: tls.certificate }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = Buffer.concat(chunks);
    const coding = request.headers["content-encoding"] ?? "identity";
    const head =
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
      request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 === 0 ? ": " : "\r\n"), "") +
      "\r\n";
    captured.push({ coding, message, rawBytes: Buffer.byteLength(head) + message.length });
    const original = coding === "gzip" ? gunzipSync(message) : message;
    response.setHeader("Accept-Encoding", "gzip, identity");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/discover") response.end("{}");
    else {
      response.setHeader("Content-Encoding", "gzip");
      response.end(gzipSync(original));
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const baseURL = `https://127.0.0.1:${address.port}`;
    const trusted = createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 8192, timeoutMs: 2000 });
    const large = JSON.stringify({
      generated_at: "2026-10-10T00:00:00.500+00:00",
      reason: "source facts ".repeat(200),
    });
    assert.equal(
      await (
        await trusted(`${baseURL}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: large,
        })
      ).text(),
      large,
    );
    assert.equal(captured[0]?.coding, "identity");
    await trusted(`${baseURL}/discover`);
    assert.equal(
      await (
        await trusted(`${baseURL}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: large,
        })
      ).text(),
      large,
    );
    assert.equal(captured[2]?.coding, "gzip");
    assert(captured[0] && captured[2]);
    assert(captured[2].rawBytes < captured[0].rawBytes);
    const small = '{"value":1}';
    assert.equal(
      await (
        await trusted(`${baseURL}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: small,
        })
      ).text(),
      small,
    );
    assert.equal(captured[3]?.coding, "identity");
    const untrusted = createHTTPSFetch({ maxJSONBytes: 8192, timeoutMs: 2000 });
    await assert.rejects(untrusted(`${baseURL}/discover`));
    await assert.rejects(trusted(`http://127.0.0.1:${address.port}/discover`));
  } finally {
    server.closeAllConnections();
  }
});

test("HTTPS decoding rejects malformed or oversized messages and aborts incomplete replies", async () => {
  await using tls = await temporaryTLS(ownedFixtureRoot(process.argv));
  const single = gzipSync(Buffer.from('{"value":1}'));
  const corrupt = Buffer.from(single);
  corrupt[corrupt.length - 1] = 255;
  const messages = new Map([
    ["/truncated", single.subarray(0, single.length - 3)],
    ["/corrupt", corrupt],
    ["/members", Buffer.concat([single, single])],
    ["/trailing", Buffer.concat([single, Buffer.from("x")])],
    ["/expanded", gzipSync(Buffer.from("x".repeat(4096)))],
  ]);
  let requests = 0;
  await using server = createServer({ key: tls.key, cert: tls.certificate }, (request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    const message = messages.get(request.url ?? "");
    if (message) {
      response.setHeader("Content-Encoding", "gzip");
      response.end(message);
    } else if (request.url === "/encoded") response.end("x".repeat(4096));
    else if (request.url === "/partial") {
      response.setHeader("Content-Length", "100");
      response.end("{}");
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "https://localhost/other" });
      response.end();
    } else if (request.url === "/unsupported") {
      response.setHeader("Content-Encoding", "br");
      response.end("{}");
    } else if (request.url === "/timeout") response.flushHeaders();
    else response.end("{}");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const baseURL = `https://127.0.0.1:${address.port}`;
    const transport = createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 256, timeoutMs: 300 });
    for (const path of [...messages.keys(), "/encoded", "/partial", "/redirect", "/unsupported", "/timeout"]) {
      await assert.rejects(transport(`${baseURL}${path}`), `accepted ${path}`);
    }
    const before = requests;
    await assert.rejects(transport(`${baseURL}/upload`, { method: "POST", body: "x".repeat(257) }));
    assert.equal(requests, before);
    let cancelled = false;
    const incomplete = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const streamingInput = { method: "POST", body: incomplete, duplex: "half" };
    await assert.rejects(transport(new Request(`${baseURL}/upload`, streamingInput)));
    assert.equal(cancelled, true);
    assert.equal(requests, before);
    assert.equal(await (await transport(`${baseURL}/healthy`)).text(), "{}");
  } finally {
    server.closeAllConnections();
  }
});

test("ordinary TLS refuses a trusted certificate with the wrong hostname or expired validity before application traffic", async () => {
  for (const fixture of [
    { options: { serverNames: "DNS:other.example" }, code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    { options: { expired: true }, code: "CERT_HAS_EXPIRED" },
  ]) {
    await using tls = await temporaryTLS(ownedFixtureRoot(process.argv), fixture.options);
    let applicationRequests = 0;
    await using server = createServer({ key: tls.key, cert: tls.certificate }, (_request, response) => {
      applicationRequests += 1;
      response.end("{}");
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const transport = createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 256, timeoutMs: 1000 });
      await assert.rejects(transport(`https://127.0.0.1:${address.port}/`), { code: fixture.code });
      assert.equal(applicationRequests, 0);
    } finally {
      server.closeAllConnections();
    }
  }
});

test(
  "HTTPS deadlines bound an unfinished request stream even when its cancellation never settles",
  { timeout: 3000 },
  async () => {
    const transport = createHTTPSFetch({ maxJSONBytes: 256, timeoutMs: 50 });
    for (const wrapped of [false, true]) {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations += 1;
          return new Promise<void>(() => {});
        },
      });
      const input = { method: "POST", body, duplex: "half" };
      const url = "https://127.0.0.1:1/upload";
      await assert.rejects(wrapped ? transport(new Request(url, input)) : transport(url, input), (error: unknown) => {
        if (error instanceof AggregateError) {
          assert.equal(error.errors.length, 2, "retain the read deadline and the incomplete cleanup");
          assert(error.errors[0] instanceof DOMException);
          assert.equal(error.errors[0].name, "TimeoutError");
          assert(error.errors[1] instanceof Error);
          assert.match(error.errors[1].message, /cancellation.*request ended/);
        } else {
          assert(error instanceof DOMException);
          assert.equal(error.name, "TimeoutError");
        }
        return true;
      });
      assert.equal(cancellations, 1);
    }
  },
);
