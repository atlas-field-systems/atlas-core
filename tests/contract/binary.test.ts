import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTransport, responseValidation, contractValidator } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import fixtures from "./binary-fixtures.json" with { type: "json" };
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths, components } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const contentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const path = "/__fixture/content/{content_id}";
const body = String.fromCharCode(...fixtures.bytes);
const boundaryInput = await readFile(new URL("./binary-limit.bin", import.meta.url));
const boundaryExpected = Array.from(new Uint8Array(1024).fill(165));
const boundaryReceipt = { dataset_id: dataset, data: { byte_length: fixtures.boundary.byte_length, sha256: fixtures.boundary.sha256 }, commit_cursor: "fixture:content:1" };
const validateError = contractValidator(protocol).compile<components["schemas"]["Error"]>({ $ref: "atlas#/components/schemas/Error" });
const receipt = { dataset_id: dataset, data: { byte_length: fixtures.byte_length, sha256: fixtures.sha256 }, commit_cursor: "fixture:content:1" };

for (const mode of ["generated transport", "direct Protocol"]) {
  let ownedDirectory = "";
  await withFixture(async ({ baseUrl, dataDir }) => {
    ownedDirectory = dataDir;
    const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
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
      const atLimit = await fetch(`${baseUrl}/__fixture/content/${contentId}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: boundaryInput, signal: AbortSignal.timeout(5000),
      });
      assert.equal(atLimit.status, 200, "documented exact body limit is accepted");
      assert.deepEqual(await atLimit.json(), boundaryReceipt);
      const boundary = await fetch(`${baseUrl}/__fixture/content/${contentId}`, { headers, signal: AbortSignal.timeout(5000) });
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
      const uploaded = await fetch(`${baseUrl}/__fixture/content/${contentId}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: Uint8Array.from(fixtures.bytes), signal: AbortSignal.timeout(5000),
      });
      assert.equal(uploaded.status, 200);
      assert.deepEqual(await uploaded.json(), receipt);
      const retrieved = await fetch(`${baseUrl}/__fixture/content/${contentId}`, { headers, signal: AbortSignal.timeout(5000) });
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
    const selectedFiles = await readdir(join(dataDir, "content"));
    assert.equal(selectedFiles.length, 1, "one complete fixture file and no abandoned attempt");
    for (const failure of fixtures.failures) {
      const payload = String.fromCharCode(...new Uint8Array(failure.length).fill(42));
      if (mode === "generated transport") {
        const failingClient = createTransport<paths>({ baseUrl, fetch: (request) => {
          if (failure.dataset === null) request.headers.delete("Atlas-Dataset-ID");
          if (failure.version === null) request.headers.delete("Atlas-Protocol-Version");
          if (failure.media === null) request.headers.delete("Content-Type");
          return fetch(request, { signal: AbortSignal.timeout(5000) });
        } });
        failingClient.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
        const rejected = await failingClient.PUT(path, {
          params: { header: { "Atlas-Dataset-ID": failure.dataset ?? dataset, "Atlas-Protocol-Version": failure.version ?? version }, path: { content_id: failure.path } },
          headers: { "Content-Type": failure.media ?? "application/octet-stream" }, body: payload,
          bodySerializer: (value) => Uint8Array.from(value, (character) => character.charCodeAt(0)),
        });
        assert.equal(rejected.response.status, failure.status, failure.name);
        assert(validateError(rejected.error), `${failure.name}: shared typed error`);
        assert.equal(rejected.error.error.code, failure.code, failure.name);
        assert.equal(rejected.error.dataset_id, dataset);
        assert.notEqual(rejected.error.error.request_id, "00000000-0000-0000-0000-000000000000");
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
        const rejected = await fetch(`${baseUrl}/__fixture/content/${failure.path}`, {
          method: "PUT", headers: failingHeaders, body: new Uint8Array(failure.length).fill(42), signal: AbortSignal.timeout(5000),
        });
        assert.equal(rejected.status, failure.status, failure.name);
        assert.equal(rejected.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(rejected.headers.get("Atlas-Protocol-Version"), version);
        assert.equal(rejected.headers.get("Content-Type"), "application/json");
        const error: unknown = await rejected.json();
        assert(validateError(error), `${failure.name}: shared typed error`);
        assert.equal(error.error.code, failure.code, failure.name);
        assert.equal(error.dataset_id, dataset);
        assert.notEqual(error.error.request_id, "00000000-0000-0000-0000-000000000000");
        assert(!JSON.stringify(error).includes("sensitive"));
        const unchanged = await fetch(`${baseUrl}/__fixture/content/${contentId}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(unchanged.status, 200);
        assert.deepEqual(Array.from(new Uint8Array(await unchanged.arrayBuffer())), fixtures.bytes, failure.name);
        assert.equal(unchanged.headers.get("Content-Length"), "7", failure.name);
        assert.equal(unchanged.headers.get("Fixture-Digest"), fixtures.sha256, failure.name);
      }
      assert.deepEqual(await readdir(join(dataDir, "content")), selectedFiles, `${failure.name}: failed attempt cleanup preserves only prior content`);
    }
  });
  await assert.rejects(stat(ownedDirectory), { code: "ENOENT" });
  console.log(`PASS ${mode}: exact binary bytes, metadata, typed validation failures, failed-attempt and runner cleanup`);
}
