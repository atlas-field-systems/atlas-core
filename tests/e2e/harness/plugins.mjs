import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { repository } from "./core.mjs";
import { track } from "./processes.mjs";

export const elevationPlugin = path.join(repository, "plugins", "elevation");
export const fixturePlugin = path.join(repository, "tests", "e2e", "fixtures", "plugin");

// Covers Node startup of a Plugin process.
const healthTimeoutMs = 10_000;

/**
 * Installs a Plugin through atlasctl to run as a local process on a free
 * port, and returns its manifest ID and container environment.
 */
export async function installProcessPlugin(installation, pluginDir) {
  const port = await freePort();
  await installation.atlasctl("plugin-install", "-endpoint", `http://127.0.0.1:${port}`, pluginDir);
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "atlas-plugin.json"), "utf8"));
  const env = parseEnv(await readFile(path.join(installation.setupDir, "plugins", `${manifest.id}.env`), "utf8"));
  return { id: manifest.id, dir: pluginDir, env: { ...env, ATLAS_PLUGIN_PORT: String(port) }, port };
}

/** A Plugin server running as a child process, as its container would. */
export class PluginProcess {
  static async start(plugin, core) {
    const child = track(spawn(process.execPath, [path.join(plugin.dir, "server.mjs")], {
      env: { ...process.env, ...plugin.env, ATLAS_CORE_URL: core.baseUrl },
      stdio: ["ignore", "inherit", "inherit"],
    }));
    const started = new PluginProcess(child, plugin);
    await started.#waitHealthy();
    return started;
  }

  constructor(child, plugin) {
    this.child = child;
    this.url = `http://127.0.0.1:${plugin.port}`;
  }

  /** Calls one of the fixture Plugin's test controls. */
  async control(method, route) {
    const response = await fetch(this.url + route, { method });
    return response.status === 204 ? undefined : response.json();
  }

  /** Ends the process abruptly, as a crashed container would. */
  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await exited;
  }

  async #waitHealthy() {
    const deadline = Date.now() + healthTimeoutMs;
    while (Date.now() < deadline) {
      if (await fetch(`${this.url}/health`).then((response) => response.ok, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Plugin process did not become healthy");
  }
}

function parseEnv(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
