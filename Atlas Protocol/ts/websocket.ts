import {Version} from './metadata.gen.js';
import {Decode} from './index.js';
import {DefaultLimits} from './scan.js';
import type {Limits} from './scan.js';
export interface FrameContext {datasetID: string; coreRunID: string; authenticated: boolean; subscribed: boolean}
export function ValidateFrame(direction: 'client' | 'server', wire: Uint8Array, ctx: FrameContext, limits: Limits = DefaultLimits()): void {
 const frame = direction === 'client' ? Decode('ClientFrame', wire, limits) : Decode('ServerFrame', wire, limits);
 if (frame.type === 'error') {
  if (frame.response.dataset_id && frame.response.dataset_id.toLowerCase() !== frame.dataset_id.toLowerCase()) throw new Error('error Dataset mismatch');
  if (ctx.datasetID && frame.dataset_id.toLowerCase() !== ctx.datasetID.toLowerCase() && frame.response.error.code !== 'dataset_mismatch') throw new Error('error Dataset mismatch');
  if (frame.protocol_version !== Version && frame.response.error.code !== 'protocol_mismatch') throw new Error('error Protocol mismatch');
  return;
 }
 if (frame.type === 'authenticate') {if (ctx.authenticated) throw new Error('already authenticated');}
 else if (frame.type !== 'authenticated' && !ctx.authenticated) throw new Error('authentication required');
 if (ctx.datasetID && frame.dataset_id.toLowerCase() !== ctx.datasetID.toLowerCase()) throw new Error('dataset_mismatch');
 if ('core_run_id' in frame && ctx.coreRunID && frame.core_run_id.toLowerCase() !== ctx.coreRunID.toLowerCase()) throw new Error('Core run mismatch');
 if (['changes', 'handoff_complete', 'gap'].includes(frame.type) && !ctx.subscribed) throw new Error('subscription required');
 if (frame.type === 'release_snapshot' && frame.request.core_run_id !== frame.core_run_id) throw new Error('release Core run mismatch');
}
