/**
 * Receive boundary of the native IRC transport (D3): the conversions between
 * the transport-facing receipt an endpoint answers with and the delivery
 * result the bus speaks in.
 *
 * Nothing here rewrites an envelope — `id`/`ts`/`from`/`to`/`replyTo` belong
 * to the sender and stay verbatim from the frame to the recipient — and
 * nothing here chooses a transport. The bus owns the inbound delivery (and its
 * per-generation deduplication); these are the two pure mappings between the
 * result shapes on either side of that boundary.
 */

import type { IrcDeliveryReceipt } from "../task/endpoint";
import type { DeliveryResult, IrcBus, IrcDeliveryOptions, IrcEnvelope } from "./bus";
/**
 * Receive boundary entrypoint: deliver one inbound frame's envelope through
 * the bus's deduplicated inbound pipeline. The caller owns the deduplication
 * identity — `operationId` with its `generation` scope — and any hand-over
 * switches in `options` ride beside the envelope; this wrapper never sends
 * anything, so a received message can never become a new one.
 */
export function deliverInboundEnvelope(
	bus: IrcBus,
	envelope: IrcEnvelope,
	operationId: string,
	generation: number,
	options?: IrcDeliveryOptions,
): Promise<DeliveryResult> {
	return bus.injectInbound(envelope, { ...options, operationId, generation });
}

/** The endpoint-facing receipt for one bus delivery result. */
export function toIrcDeliveryReceipt(result: DeliveryResult): IrcDeliveryReceipt {
	if (result.outcome === "failed") {
		return { status: "failed", to: result.to, error: result.error ?? "IRC delivery failed." };
	}
	if (result.outcome === "indeterminate") {
		return { status: "indeterminate", to: result.to, error: result.error ?? "IRC delivery was not confirmed." };
	}
	return { status: "delivered", to: result.to, outcome: result.outcome };
}

/** The bus delivery result for one endpoint receipt. */
export function toDeliveryResult(receipt: IrcDeliveryReceipt): DeliveryResult {
	switch (receipt.status) {
		case "delivered":
			return { to: receipt.to, outcome: receipt.outcome };
		case "failed":
			return { to: receipt.to, outcome: "failed", error: receipt.error };
		case "indeterminate":
			return { to: receipt.to, outcome: "indeterminate", error: receipt.error };
	}
}
