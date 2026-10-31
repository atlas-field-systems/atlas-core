import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './process.js';
import type { Core } from './core.js';
import { z } from 'zod';
export class Measurements {
  private readonly elapsed: number[] = [];
  attempts = 0;
  acceptedReports = 0;
  latencyOmissions = 0;
  readonly pictureLag: number[] = [];
  initialLoadMs: number | null = null;
  coreCpuMs = 0;
  corePeakMemory = 0;
  coreSamples = 0;
  coreSampleFailures = 0;
  simulatorPeakMemory = process.memoryUsage().rss;
  readonly failures: string[] = [];
  attempt(result: unknown): void {
    this.attempts++;
    const parsed = z
      .object({ context: z.object({ elapsedMs: z.number().nonnegative().finite() }) })
      .safeParse(result);
    if (parsed.success) {
      if (this.elapsed.length >= 100000) throw new Error('Latency sample budget');
      this.elapsed.push(parsed.data.context.elapsedMs);
    } else this.latencyOmissions++;
  }
  start(core: Core): () => Promise<void> {
    let pending: Promise<void> | undefined;
    let previous = performance.now();
    const timer = setInterval(() => {
      this.simulatorPeakMemory = Math.max(this.simulatorPeakMemory, process.memoryUsage().rss);
      if (pending || !core.containerId) return;
      const now = performance.now();
      const span = now - previous;
      previous = now;
      pending = (async () => {
        const sample = JSON.parse(
          await command('docker', [
            'stats',
            '--no-stream',
            '--format',
            '{{json .}}',
            core.containerId ?? '',
          ]),
        );
        const row = z.object({ CPUPerc: z.string(), MemUsage: z.string() }).parse(sample);
        const cpu = Number(row.CPUPerc.replace('%', ''));
        const memory = /^(\d+(?:\.\d+)?)\s*([KMGT]?i?B)/.exec(row.MemUsage);
        if (!Number.isFinite(cpu) || !memory) throw new Error('Docker stats units');
        const unit = memory[2],
          factors: Record<string, number> = {
            B: 1,
            kB: 1000,
            KB: 1000,
            MB: 1e6,
            GB: 1e9,
            KiB: 1024,
            MiB: 1048576,
            GiB: 1073741824,
          };
        const factor = unit && factors[unit];
        if (!factor) throw new Error('Docker memory unit');
        this.coreCpuMs += (cpu / 100) * span;
        this.corePeakMemory = Math.max(this.corePeakMemory, Number(memory[1]) * factor);
        this.coreSamples++;
      })()
        .catch((e: unknown) => {
          this.coreSampleFailures++;
          if (this.failures.length < 10) this.failures.push(String(e).slice(0, 256));
        })
        .finally(() => {
          pending = undefined;
        });
    }, 1000);
    return async () => {
      clearInterval(timer);
      await pending;
    };
  }
  values(): Record<string, number | null> {
    const percentile = (values: number[], quantile: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
    };
    return {
      observedAttempts: this.attempts,
      acceptedReports: this.acceptedReports,
      latencyCoverage: this.elapsed.length,
      latencyOmissions: this.latencyOmissions,
      latencyP50Ms: percentile(this.elapsed, 0.5),
      latencyP95Ms: percentile(this.elapsed, 0.95),
      latencyP99Ms: percentile(this.elapsed, 0.99),
      pictureInitialLoadMs: this.initialLoadMs,
      pictureLagP95Ms: percentile(this.pictureLag, 0.95),
      pictureLagCoverage: this.pictureLag.length,
      coreCpuMs: this.coreSamples ? this.coreCpuMs : null,
      corePeakMemory: this.coreSamples ? this.corePeakMemory : null,
      coreSamples: this.coreSamples,
      coreSampleFailures: this.coreSampleFailures,
    };
  }
}
export async function storageBytes(root: string): Promise<Record<string, number>> {
  const result = { databaseBytes: 0, walBytes: 0, installationBytes: 0 };
  let count = 0;
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (++count > 100000) throw new Error('Installation entry budget');
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Installation symlink');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const size = (await stat(child)).size;
        result.installationBytes += size;
        if (/\.(sqlite|db)$/.test(entry.name)) result.databaseBytes += size;
        if (entry.name.endsWith('-wal')) result.walBytes += size;
      }
    }
  }
  await visit(root);
  return result;
}
