import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AtlasClient } from "../../../sdk/dist/index.js";
import { ComposeInstallation } from "./compose.mjs";
import { Installation } from "./core.mjs";
import { Transcript } from "./transcript.mjs";

const artifacts = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "artifacts");
const updating = process.env.ATLAS_E2E_UPDATE === "1";

/**
 * Declares one end-to-end scenario. The body asserts its promise; the
 * recorded transcript is then compared with the committed artifact.
 */
export function scenario(title, body) {
  test(title, async (context) => {
    const run = new ScenarioRun(title, context);
    await body(run);
    await run.checkArtifact();
  });
}

class ScenarioRun {
  constructor(title, context) {
    this.title = title;
    this.transcript = new Transcript(title);
    this.context = context;
  }

  step(title, action) {
    return this.transcript.step(title, action);
  }

  /** Creates a set-up installation that is removed after the scenario. */
  async installation() {
    const installation = await Installation.create();
    this.transcript.name(installation.operatorKey, "operator key");
    this.transcript.name(installation.enrollmentKey, "enrollment key");
    this.context.after(() => installation.remove());
    return installation;
  }

  /** Creates a set-up Docker Compose installation that is removed after the scenario. */
  async composeInstallation() {
    const installation = await ComposeInstallation.create();
    this.transcript.name(installation.operatorKey, "operator key");
    this.context.after(() => installation.remove());
    return installation;
  }

  /** Starts Core on a new installation, or on the given one after a Stop. */
  async startCore(installation) {
    const core = await (installation ?? (await this.installation())).start();
    this.context.after(() => core.stop());
    return core;
  }

  /** An SDK client whose traffic is recorded under the credential's label. */
  client(core, apiKey, label) {
    if (label) this.transcript.name(apiKey, label);
    return new AtlasClient({ baseUrl: core.baseUrl, apiKey, fetch: this.transcript.fetch });
  }

  /**
   * An SDK client whose first matching response is lost after Core commits
   * it, as if the connection dropped. The exchange is still recorded.
   */
  clientLosingFirstResponse(core, apiKey, method) {
    let lost = false;
    const fetch = async (input, init) => {
      const requestMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
      const matches = !lost && requestMethod === method;
      const response = await this.transcript.fetch(input, init);
      if (!matches) return response;
      lost = true;
      this.transcript.note("The client never received this response.");
      throw new Error("response lost after Core committed");
    };
    return new AtlasClient({ baseUrl: core.baseUrl, apiKey, fetch });
  }

  /** A direct Protocol request, recorded like SDK traffic. */
  async request(core, target, { method = "GET", credential, body } = {}) {
    const headers = {};
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.transcript.directFetch(new URL(target, core.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }

  async checkArtifact() {
    const file = path.join(artifacts, `${slug(this.title)}.md`);
    const actual = this.transcript.render();
    if (updating) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(file, actual);
      return;
    }
    const expected = await readFile(file, "utf8").catch(() => {
      throw new Error(`No committed artifact at ${file}. Run with ATLAS_E2E_UPDATE=1 and review it.`);
    });
    assert.equal(actual, expected, `Transcript differs from ${path.relative(process.cwd(), file)}. If the change is intended, regenerate with ATLAS_E2E_UPDATE=1 and explain it in the PR.`);
  }
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
