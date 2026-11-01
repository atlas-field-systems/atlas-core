export class Shutdown {
  readonly deadline: number;
  readonly failures: string[] = [];
  constructor(milliseconds = 30000) {
    this.deadline = performance.now() + milliseconds;
  }
  async finish(label: string, action: () => Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Unresolved cleanup owner ${label}`)),
            Math.max(0, this.deadline - performance.now()),
          );
        }),
      ]);
      return true;
    } catch (error) {
      this.failures.push(
        `${label} ${error instanceof Error ? error.message : String(error)}`.slice(0, 1024),
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
