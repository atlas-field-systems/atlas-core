import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { repository } from "./core.mjs";

const run = promisify(execFile);
const workDir = path.join(repository, "tests", "e2e", ".work");

/**
 * A temporary Compose installation managed through atlasctl, isolated by its
 * own Compose project name and a random host port.
 */
export class ComposeInstallation {
  static async create() {
    await ensureImage();
    // Docker Desktop shares the checkout with its VM but not the system temp
    // directory, so bind-mounted state must live inside the repository.
    await mkdir(workDir, { recursive: true });
    const root = await mkdtemp(path.join(workDir, "compose-"));
    const ctl = path.join(root, "atlasctl");
    if (process.env.ATLAS_E2E_BIN_DIR) await copyFile(path.join(process.env.ATLAS_E2E_BIN_DIR, "atlasctl"), ctl);
    else await run("go", ["build", "-o", ctl, "./cmd/atlasctl"], { cwd: path.join(repository, "core") });
    await chmod(ctl, 0o755);
    await copyFile(path.join(repository, "compose.yaml"), path.join(root, "compose.yaml"));
    await symlink(path.join(repository, "core"), path.join(root, "core"));
    const installation = new ComposeInstallation(root, ctl, `atlas-e2e-${randomBytes(4).toString("hex")}`);
    await installation.atlasctl("setup");
    installation.operatorKey = (await readFile(path.join(root, "state", "setup", "first-key"), "utf8")).trim();
    return installation;
  }

  constructor(root, ctl, project) {
    this.root = root;
    this.ctl = ctl;
    this.env = { ...process.env, COMPOSE_PROJECT_NAME: project, ATLAS_PORT: "0" };
  }

  get operationalDir() { return path.join(this.root, "state", "operational"); }

  async atlasctl(...args) {
    const { stdout } = await run(this.ctl, ["-root", this.root, ...args], { env: this.env });
    return stdout;
  }

  /** Starts Core through atlasctl and returns its published base URL. */
  async start() {
    await this.atlasctl("start");
    const { stdout } = await run("docker", ["compose", "-f", path.join(this.root, "compose.yaml"), "port", "core", "8080"], { env: this.env });
    return { baseUrl: `http://${stdout.trim()}`, installation: this };
  }

  /** Lists the Compose services currently running. */
  async runningServices() {
    const files = ["-f", path.join(this.root, "compose.yaml"), ...(await this.#pluginFiles())];
    const { stdout } = await run("docker", ["compose", ...files, "ps", "--status", "running", "--services"], { env: this.env });
    return stdout.trim().split("\n").filter(Boolean).sort();
  }

  async #pluginFiles() {
    const dir = path.join(this.root, "state", "setup", "plugins");
    const names = await readdir(dir).catch(() => []);
    return names.filter((name) => name.endsWith(".compose.yaml")).flatMap((name) => ["-f", path.join(dir, name)]);
  }

  async remove() {
    try {
      await run("docker", ["compose", "-f", path.join(this.root, "compose.yaml"), ...(await this.#pluginFiles()), "down", "--remove-orphans"], { env: this.env });
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }
}

const pluginImages = new Map();

/** Builds a Plugin's image from its Dockerfile once per test process. */
export function buildPluginImage(pluginDir, image) {
  if (!pluginImages.has(image)) {
    pluginImages.set(image, run("docker", ["build", "-q", "-t", image, "-f", path.join(pluginDir, "Dockerfile"), repository]));
  }
  return pluginImages.get(image);
}

let imageBuilt;

/** Builds the Core image from this checkout once per test process, so a stale image is never tested. */
function ensureImage() {
  imageBuilt ??= run("docker", ["compose", "-f", path.join(repository, "compose.yaml"), "build", "core"]);
  return imageBuilt;
}
