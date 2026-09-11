/**
 * Endpoint implementations.
 *
 * The contract itself lives in `../endpoint.ts` (importable as
 * `@oh-my-pi/pi-coding-agent/task/endpoint`, together with the event stream
 * every implementation stamps its events with); this barrel exposes the
 * concrete adapters and the reply-drained barrier they share.
 */

export * from "./local";
export * from "../reply-drained";
