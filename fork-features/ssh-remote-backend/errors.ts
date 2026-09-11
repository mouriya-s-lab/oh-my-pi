/**
 * Fork-side SSH backend failure taxonomy.
 *
 * Every failure the backend surfaces is one of the codes below, so the factory,
 * the endpoint adapter and tests classify by code instead of parsing OpenSSH or
 * RPC prose. Host lookup raises `unknown-host` / `no-agent-directory`, the
 * factory's executable probe raises `executable-missing`, and the transport
 * raises `connection-failed` / `protocol-incompatible`.
 */

export type SshBackendErrorCode =
	| "unknown-host"
	| "no-agent-directory"
	| "executable-missing"
	| "connection-failed"
	| "protocol-incompatible";

/** The single error type every backend stage throws, carrying its classified code. */
export class SshBackendError extends Error {
	readonly code: SshBackendErrorCode;

	constructor(code: SshBackendErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SshBackendError";
		this.code = code;
	}
}
