export type BoundaryCode =
  | 'invalid_json'
  | 'invalid_utf8'
  | 'invalid_value'
  | 'payload_too_large'
  | 'resource_limit'
  | 'invalid_geometry'
  | 'unsupported_geometry'
  | 'geometry_limit_exceeded'
  | 'invalid_http'
  | 'invalid_budget';

export class ProtocolError extends Error {
  readonly code: BoundaryCode;
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(code: BoundaryCode, issues: readonly { path: string; message: string }[] = []) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.issues = issues.slice(0, 16).map((issue) => ({
      path: issue.path.slice(0, 256),
      message: issue.message.slice(0, 160),
    }));
  }
}
