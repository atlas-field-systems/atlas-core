import { after } from "node:test";

/**
 * Child processes this test file started. A scenario that fails or times
 * out can leave one running after its own cleanup; killing the rest when the
 * file finishes keeps the run from hanging on them.
 */
const children = new Set();

export function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

after(() => {
  for (const child of children) child.kill("SIGKILL");
});
