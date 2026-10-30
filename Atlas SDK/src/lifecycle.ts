import type { RemoteCloseResult } from './remote-reads.js';

export type ClientCloseResult = Readonly<{ remote: RemoteCloseResult }>;

/** Local cleanup failed. Available remote evidence never implies unobserved releases. */
export class ClientCloseError extends AggregateError {
  readonly remote: RemoteCloseResult | undefined;
  constructor(errors: readonly unknown[], remote: RemoteCloseResult | undefined) {
    super(errors, 'Client cleanup failed');
    this.name = 'ClientCloseError';
    this.remote = remote;
  }
}
