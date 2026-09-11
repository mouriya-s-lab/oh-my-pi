/**
 * D2 status widening (mouriya-s-lab/oh-my-pi#8): `execution-unknown` is a
 * first-class terminal *observation*, and the widened unions have to reach
 * every surface that branches on them instead of being folded into `running`,
 * `parked`, `aborted` or `failed`.
 *
 * This file pins the shape and the classifiers only — how each union member
 * behaves end to end (registry, monitor, hub, eval handle) is exercised by the
 * D2 migration driver in `d2-migration.test.ts`.
 */
import { describe, expect, expectTypeOf, it } from "bun:test";
import type { AsyncJob, AsyncJobStatus } from "@oh-my-pi/pi-coding-agent/async";
import {
	type AgentRef,
	type AgentRefEndpoint,
	type AgentStatus,
	isAgentUnknown,
	isTerminalAgentStatus,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentEndpoint } from "@oh-my-pi/pi-coding-agent/task/endpoint";
import type { JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub/types";

/** Widened statuses, spelled out here so a narrowing change cannot pass silently. */
type WidenedAgentStatus = "running" | "idle" | "parked" | "aborted" | "execution-unknown";
type WidenedJobStatus = "running" | "completed" | "failed" | "cancelled" | "execution-unknown";

describe("D2 status widening", () => {
	it("keeps the widened unions and the tagged reference exact", () => {
		expectTypeOf<AgentStatus>().toEqualTypeOf<WidenedAgentStatus>();
		expectTypeOf<AsyncJob["status"]>().toEqualTypeOf<WidenedJobStatus>();
		expectTypeOf<AsyncJobStatus>().toEqualTypeOf<WidenedJobStatus>();
		expectTypeOf<AgentRef["endpoint"]>().toEqualTypeOf<AgentRefEndpoint>();
		expectTypeOf<AgentRefEndpoint>().toEqualTypeOf<
			| { kind: "local"; session: AgentSession | null; sessionFile: string | null }
			| { kind: "remote"; reference: string; endpoint: AgentEndpoint | null }
		>();

		// The hub row is a consumer of the job union and must not re-narrow it,
		// and an unknown run cannot claim a process exit code.
		expectTypeOf<JobSnapshot["status"]>().toEqualTypeOf<WidenedJobStatus>();
		expectTypeOf<JobSnapshot["exitCode"]>().toEqualTypeOf<number | null>();
	});

	it("classifies every widened status without folding unknown into a live one", () => {
		const expected: Array<{ status: AgentStatus; unknown: boolean; terminal: boolean }> = [
			{ status: "running", unknown: false, terminal: false },
			{ status: "idle", unknown: false, terminal: false },
			{ status: "parked", unknown: false, terminal: true },
			{ status: "aborted", unknown: false, terminal: true },
			{ status: "execution-unknown", unknown: true, terminal: true },
		];

		for (const { status, unknown, terminal } of expected) {
			expect({ status, unknown: isAgentUnknown(status), terminal: isTerminalAgentStatus(status) }).toEqual({
				status,
				unknown,
				terminal,
			});
		}
	});
});
