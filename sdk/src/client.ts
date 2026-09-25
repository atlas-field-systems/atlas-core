import createClient from "openapi-fetch";
import type { components, paths } from "./generated/protocol.js";
import { newAssetCredential } from "./credentials.js";
import { unwrap } from "./errors.js";

type Schemas = components["schemas"];
export type Readiness = Schemas["Readiness"];
export type Entity = Schemas["Entity"];
export type AssetStatus = Schemas["AssetStatus"];
export type AssetEnrollmentFacts = Pick<Schemas["AssetEnrollmentRequest"], "alias" | "subtype" | "components" | "command_manifest">;

/**
 * Everything an Asset needs to enroll and retry. Persist it before the first
 * attempt: a retry must reuse the same request ID and credential.
 */
export interface AssetEnrollmentIdentity {
  datasetId: string;
  assetId: string;
  requestId: string;
  credential: string;
}

export interface AssetStatusReport {
  datasetId: string;
  reportId: string;
  sequence: number;
  status: AssetStatus;
}

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

  /** Allocates a new Asset identity for the current Dataset without contacting the Asset. */
  async prepareAssetEnrollment(): Promise<AssetEnrollmentIdentity> {
    const dataset = await this.dataset();
    return { datasetId: dataset.id, assetId: crypto.randomUUID(), requestId: crypto.randomUUID(), credential: newAssetCredential() };
  }

  /** Enrolls, or retries an enrollment of, a prepared Asset identity. */
  async enrollAsset(identity: AssetEnrollmentIdentity, facts: AssetEnrollmentFacts = {}) {
    const body = { dataset_id: identity.datasetId, id: identity.assetId, request_id: identity.requestId, kind: "asset" as const, credential: identity.credential, ...facts };
    return unwrap(await this.client.POST("/entities", { body }));
  }

  async entity(id: string) {
    return unwrap(await this.client.GET("/entities/{entity_id}", { params: { path: { entity_id: id } } }));
  }

  /** Reports this Asset's status. Resending a report ID with the same facts is safe. */
  async reportAssetStatus(id: string, report: AssetStatusReport) {
    const body = { dataset_id: report.datasetId, report_id: report.reportId, sequence: report.sequence, status: report.status };
    return unwrap(await this.client.PATCH("/entities/{entity_id}/status", { params: { path: { entity_id: id } }, body }));
  }
}
