/**
 * Endpoint implementations.
 *
 * The contract itself lives in `../endpoint.ts` (importable as
 * `@oh-my-pi/pi-coding-agent/task/endpoint`); this barrel exposes the concrete
 * adapters, starting with the local one.
 */

export * from "./local";
