export interface RenderRequest {
  code: string;
  /** Musical duration in seconds: events are scheduled in [0, seconds). */
  seconds: number;
  /** Extra seconds rendered after `seconds` so releases/reverb can ring out. */
  tail: number;
  sampleRate: number;
  cpsOverride?: number;
  prebake: boolean;
  extraSamples: string[];
  /** Schedule everything (to discover network needs) but skip the actual render. */
  dryRun: boolean;
  maxPolyphony: number;
}

export interface RenderResult {
  ok: boolean;
  error?: string;
  logs: { level: 'info' | 'warning' | 'error'; message: string }[];
  haps: number;
  cps?: number;
  frames?: number;
  channels?: number;
  sampleRate?: number;
}
