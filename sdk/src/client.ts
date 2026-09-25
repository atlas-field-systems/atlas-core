import createClient from "openapi-fetch";
import type { components, paths } from "./generated/protocol.js";
import { unwrap } from "./errors.js";

export type Readiness = components["schemas"]["Readiness"];

export interface AtlasClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

/** Authenticated access to one Core. */
export class AtlasClient {
  private readonly client: ReturnType<typeof createClient<paths>>;

  constructor(options: AtlasClientOptions) {
    this.client = createClient<paths>({
      baseUrl: options.baseUrl,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      fetch: options.fetch,
    });
  }

  async health() {
    return unwrap(await this.client.GET("/health"));
  }

  /** Returns dependency states; an unavailable dependency is a result, not an error. */
  async readiness(): Promise<Readiness> {
    const result = await this.client.GET("/readiness");
    if (result.error && "dependencies" in result.error) return result.error;
    return unwrap(result);
  }

  async dataset() {
    return unwrap(await this.client.GET("/dataset"));
  }
}
