import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
    await run("go", ["build", "-o", ctl, "./cmd/atlasctl"], { cwd: path.join(repository, "core") });
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

  async remove() {
    try {
      await run("docker", ["compose", "-f", path.join(this.root, "compose.yaml"), "down", "--remove-orphans"], { env: this.env });
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }
}

let imageBuilt;

/** Builds the Core image from this checkout once per test process, so a stale image is never tested. */
function ensureImage() {
  imageBuilt ??= run("docker", ["compose", "-f", path.join(repository, "compose.yaml"), "build", "core"]);
  return imageBuilt;
}
