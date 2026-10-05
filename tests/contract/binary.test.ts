import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "./runner.js";
import fixtures from "./binary-fixtures.json" with { type: "json" };
import { dataset, fixtureClient, headers, timedFetch, unallocatedRequestId, validateError, version } from "./support.js";

const contentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const path = "/__fixture/content/{content_id}";
const body = String.fromCharCode(...fixtures.bytes);
const boundaryInput = await readFile(new URL("./binary-limit.bin", import.meta.url));
const boundaryExpected = Array.from(new Uint8Array(1024).fill(165));
const boundaryReceipt = {
  dataset_id: dataset, data: { byte_length: fixtures.boundary.byte_length, sha256: fixtures.boundary.sha256 }, commit_cursor: "fixture:content:1",
};
const receipt = { dataset_id: dataset, data: { byte_length: fixtures.byte_length, sha256: fixtures.sha256 }, commit_cursor: "fixture:content:1" };

for (const mode of ["generated transport", "direct Protocol"]) {
  let ownedDirectory = "";
  await withFixture(async ({ baseUrl, dataDir }) => {
    ownedDirectory = dataDir;
    const client = fixtureClient(baseUrl);
    if (mode === "generated transport") {
      const atLimit = await client.PUT(path, {
        params: { header: headers, path: { content_id: contentId } }, headers: { "Content-Type": "application/octet-stream" },
        body: String.fromCharCode(...boundaryInput), bodySerializer: (value) => Uint8Array.from(value, (character) => character.charCodeAt(0)),
      });
      assert.equal(atLimit.response.status, 200, "documented exact body limit is accepted");
      assert.deepEqual(atLimit.data, boundaryReceipt);
      const boundary = await client.GET(path, { params: { header: headers, path: { content_id: contentId } }, parseAs: "arrayBuffer" });
      assert.equal(boundary.response.status, 200);
      assert(boundary.data);
      assert.deepEqual(Array.from(new Uint8Array(boundary.data)), boundaryExpected);
      assert.equal(boundary.data.byteLength, 1024);
      assert.equal(createHash("sha256").update(new Uint8Array(boundary.data)).digest("hex"), fixtures.boundary.sha256);
      assert.equal(boundary.response.headers.get("Content-Length"), "1024");
      assert.equal(boundary.response.headers.get("Fixture-Digest"), fixtures.boundary.sha256);
    } else {
      const atLimit = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: boundaryInput,
      });
      assert.equal(atLimit.status, 200, "documented exact body limit is accepted");
      assert.deepEqual(await atLimit.json(), boundaryReceipt);
      const boundary = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, { headers });
      assert.equal(boundary.status, 200);
      const bytes = new Uint8Array(await boundary.arrayBuffer());
      assert.deepEqual(Array.from(bytes), boundaryExpected);
      assert.equal(bytes.byteLength, 1024);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtures.boundary.sha256);
      assert.equal(boundary.headers.get("Content-Length"), "1024");
      assert.equal(boundary.headers.get("Fixture-Digest"), fixtures.boundary.sha256);
      assert.equal(boundary.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(boundary.headers.get("Atlas-Dataset-ID"), dataset);
      assert.equal(boundary.headers.get("Atlas-Protocol-Version"), version);
    }
    if (mode === "generated transport") {
      const uploaded = await client.PUT(path, {
        params: { header: headers, path: { content_id: contentId } }, headers: { "Content-Type": "application/octet-stream" }, body,
        bodySerializer: (value) => Uint8Array.from(value, (character) => character.charCodeAt(0)),
      });
      assert.equal(uploaded.response.status, 200);
      assert.deepEqual(uploaded.data, receipt);
      const retrieved = await client.GET(path, { params: { header: headers, path: { content_id: contentId } }, parseAs: "arrayBuffer" });
      assert.equal(retrieved.response.status, 200);
      assert(retrieved.data);
      assert.deepEqual(Array.from(new Uint8Array(retrieved.data)), fixtures.bytes);
      assert.equal(retrieved.data.byteLength, 7);
      assert.equal(createHash("sha256").update(new Uint8Array(retrieved.data)).digest("hex"), fixtures.sha256);
      assert.equal(retrieved.response.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(retrieved.response.headers.get("Content-Length"), "7");
      assert.equal(retrieved.response.headers.get("Fixture-Digest"), fixtures.sha256);
      assert.equal(retrieved.response.headers.get("Atlas-Dataset-ID"), dataset);
      assert.equal(retrieved.response.headers.get("Atlas-Protocol-Version"), version);
    } else {
      const uploaded = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: Uint8Array.from(fixtures.bytes),
      });
      assert.equal(uploaded.status, 200);
      assert.deepEqual(await uploaded.json(), receipt);
      const retrieved = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, { headers });
      assert.equal(retrieved.status, 200);
      const bytes = new Uint8Array(await retrieved.arrayBuffer());
      assert.deepEqual(Array.from(bytes), fixtures.bytes);
      assert.equal(bytes.byteLength, 7);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtures.sha256);
      assert.equal(retrieved.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(retrieved.headers.get("Content-Length"), "7");
      assert.equal(retrieved.headers.get("Fixture-Digest"), fixtures.sha256);
      assert.equal(retrieved.headers.get("Atlas-Dataset-ID"), dataset);
      assert.equal(retrieved.headers.get("Atlas-Protocol-Version"), version);
    }

    // A missing body must not publish empty content over a prior selection.
    let missingError: unknown;
    if (mode === "generated transport") {
      const bodyless = fixtureClient(baseUrl, {
        fetch: (request) => timedFetch(new Request(request.url, { method: request.method, headers: request.headers })),
      });
      const response = await bodyless.PUT(path, { params: { header: headers, path: { content_id: contentId } },
        headers: { "Content-Type": "application/octet-stream" }, body });
      assert.equal(response.response.status, 400, "required binary body is absent");
      missingError = response.error;
    } else {
      const response = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" },
      });
      assert.equal(response.status, 400, "required binary body is absent");
      missingError = await response.json();
    }
    assert(validateError(missingError));
    assert.equal(missingError.error.code, "invalid_request");
    const afterMissing = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, { headers });
    assert.deepEqual(Array.from(new Uint8Array(await afterMissing.arrayBuffer())), fixtures.bytes, "missing body preserves selected content");
    const selectedFiles = await readdir(join(dataDir, "content"));
    assert.equal(selectedFiles.length, 1, "one complete fixture file and no abandoned attempt");
    for (const failure of fixtures.failures) {
      const payload = String.fromCharCode(...new Uint8Array(failure.length).fill(42));
      if (mode === "generated transport") {
        const failingClient = fixtureClient(baseUrl, { headers: {}, fetch: (request) => {
          if (failure.dataset === null) request.headers.delete("Atlas-Dataset-ID");
          if (failure.version === null) request.headers.delete("Atlas-Protocol-Version");
          if (failure.media === null) request.headers.delete("Content-Type");
          return timedFetch(request);
        } });
        const failingHeaders = { "Atlas-Dataset-ID": failure.dataset ?? dataset, "Atlas-Protocol-Version": failure.version ?? version };
        const rejected = await failingClient.PUT(path, {
          params: { header: failingHeaders, path: { content_id: failure.path } },
          headers: { "Content-Type": failure.media ?? "application/octet-stream" }, body: payload,
          bodySerializer: (value) => Uint8Array.from(value, (character) => character.charCodeAt(0)),
        });
        assert.equal(rejected.response.status, failure.status, failure.name);
        assert(validateError(rejected.error), `${failure.name}: shared typed error`);
        assert.equal(rejected.error.error.code, failure.code, failure.name);
        assert.equal(rejected.error.dataset_id, dataset);
        assert.notEqual(rejected.error.error.request_id, unallocatedRequestId);
        assert(!JSON.stringify(rejected.error).includes("sensitive"));
        const unchanged = await client.GET(path, { params: { header: headers, path: { content_id: contentId } }, parseAs: "arrayBuffer" });
        assert.equal(unchanged.response.status, 200);
        assert(unchanged.data);
        assert.deepEqual(Array.from(new Uint8Array(unchanged.data)), fixtures.bytes, failure.name);
        assert.equal(unchanged.response.headers.get("Content-Length"), "7", failure.name);
        assert.equal(unchanged.response.headers.get("Fixture-Digest"), fixtures.sha256, failure.name);
      } else {
        const failingHeaders = new Headers();
        if (failure.dataset !== null) failingHeaders.set("Atlas-Dataset-ID", failure.dataset);
        if (failure.version !== null) failingHeaders.set("Atlas-Protocol-Version", failure.version);
        if (failure.media !== null) failingHeaders.set("Content-Type", failure.media);
        const rejected = await timedFetch(`${baseUrl}/__fixture/content/${failure.path}`, {
          method: "PUT", headers: failingHeaders, body: new Uint8Array(failure.length).fill(42),
        });
        assert.equal(rejected.status, failure.status, failure.name);
        assert.equal(rejected.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(rejected.headers.get("Atlas-Protocol-Version"), version);
        assert.equal(rejected.headers.get("Content-Type"), "application/json");
        const error: unknown = await rejected.json();
        assert(validateError(error), `${failure.name}: shared typed error`);
        assert.equal(error.error.code, failure.code, failure.name);
        assert.equal(error.dataset_id, dataset);
        assert.notEqual(error.error.request_id, unallocatedRequestId);
        assert(!JSON.stringify(error).includes("sensitive"));
        const unchanged = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, { headers });
        assert.equal(unchanged.status, 200);
        assert.deepEqual(Array.from(new Uint8Array(await unchanged.arrayBuffer())), fixtures.bytes, failure.name);
        assert.equal(unchanged.headers.get("Content-Length"), "7", failure.name);
        assert.equal(unchanged.headers.get("Fixture-Digest"), fixtures.sha256, failure.name);
      }
      assert.deepEqual(await readdir(join(dataDir, "content")), selectedFiles, `${failure.name}: failed attempt cleanup preserves only prior content`);
    }

    // Empty content is legal when a body stream is explicitly supplied. Go can
    // distinguish empty chunked content from a bodyless Content-Length: 0 PUT.
    const empty = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/__fixture/content/${contentId}`, { method: "PUT",
        headers: { ...headers, "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.once("end", () => resolve({ status: response.statusCode, body }));
        response.once("error", reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error("empty binary upload timed out")));
      request.once("error", reject);
      request.end();
    });
    assert.equal(empty.status, 200, "intentionally empty chunked content is accepted");
    assert.deepEqual(JSON.parse(empty.body), { dataset_id: dataset, data: { byte_length: "0",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, commit_cursor: "fixture:content:1" });
    const emptyRead = await timedFetch(`${baseUrl}/__fixture/content/${contentId}`, { headers });
    assert.equal(emptyRead.status, 200);
    assert.equal((await emptyRead.arrayBuffer()).byteLength, 0);
  });
  await assert.rejects(stat(ownedDirectory), { code: "ENOENT" });
  console.log(`PASS ${mode}: exact binary bytes, metadata, typed validation failures, failed-attempt and runner cleanup`);
}
