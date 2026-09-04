/**
 * A2A v1.0 binding.
 *
 * A real A2A server, not an agent card pointing at an MCP endpoint. The measured state of
 * the world (APIs.io, 2026-07-29): 65 of 22,341 hosts serve a card, 10 are conformant, and
 * every publicly reachable card that could be checked — Attio, Pinecone, Monday, Apideck,
 * Pydantic, QuickNode, Buddy — has its `url` pointing at an MCP server, which is not a
 * valid A2A interface. Marian's call on 2026-09-04 was to build the real thing.
 *
 * v1.0 breaking changes this file depends on, all verified against @a2a-js/sdk@1.1.0:
 *   - methods are PascalCase (`SendMessage`), not `message/send`
 *   - AgentCard has `supportedInterfaces[]`; `url`, `protocolVersion` and
 *     `preferredTransport` were REMOVED
 *   - task states are the numeric proto enum `TaskState.TASK_STATE_*`
 *   - the `kind` discriminator is gone; `Part.content` is a `$case` union in TypeScript,
 *     which flattens back to `{"text": "..."}` on the wire
 *
 * Pricing has no home in A2A — the spec contains zero occurrences of payment, price or
 * billing — so per-skill prices are declared through our own extension URI in
 * `capabilities.extensions[].params`, which is the only spec-sanctioned structured slot.
 */

import {
	A2A_PROTOCOL_VERSION,
	type AgentCard,
	type AgentSkill,
	Role,
	type Task,
	TaskState,
} from "@a2a-js/sdk";
import {
	AgentEvent,
	type AgentExecutor,
	type ExecutionEventBus,
	type RequestContext,
} from "@a2a-js/sdk/server";
import { dispatch } from "./core/dispatch";
import type { DispatchContext } from "./core/dispatch";
import { LIVE_SERVICES } from "./core/services";
import type { ServiceDefinition } from "./core/types";

export const ORIGIN = "https://www.engineeringleaders.io";
export const A2A_PATH = "/a2a/v1";

/** Our own namespace. A2A reserves a2a-protocol.org/extensions/* for official ones. */
export const PRICING_EXTENSION_URI = `${ORIGIN}/extensions/pricing/v1`;

function skillFrom(s: ServiceDefinition): AgentSkill {
	return {
		id: s.id,
		name: s.title,
		description: s.description,
		tags: s.tags,
		examples: s.examples,
		inputModes: [],
		outputModes: [],
		securityRequirements: [],
	};
}

/** What the pricing extension publishes, so an agent can budget before it calls. */
function pricingParams(): Record<string, unknown> {
	return {
		currency: "EUR",
		vat: "excluded",
		note: "Quoted services are fulfilled by a person and close on an invoice, not in-protocol. Metered services are per call.",
		skills: Object.fromEntries(
			LIVE_SERVICES.map((s) => [
				s.id,
				s.price.model === "free"
					? { model: "free" }
					: s.price.model === "metered"
						? { model: "metered", amount: s.price.amountEur, per: "call" }
						: { model: "quote", from: s.price.fromEur, fulfilment: s.fulfilment },
			]),
		),
	};
}

export function buildAgentCard(): AgentCard {
	return {
		name: "Engineering Leaders Community",
		description:
			"Agent-callable services from the Engineering Leaders Community: meetup topic evaluation, speaker stage placement, and community reach — grounded in 3,300+ CEE engineering leaders and 12 meetups a year at 120+ attendees since 2019.",
		version: "1.0.0",
		iconUrl: `${ORIGIN}/favicon/icon-192.png`,
		documentationUrl: `${ORIGIN}/agents/`,
		provider: {
			organization: "Engineering Leaders Community",
			url: ORIGIN,
		},
		supportedInterfaces: [
			{
				url: `${ORIGIN}${A2A_PATH}`,
				protocolBinding: "JSONRPC",
				protocolVersion: A2A_PROTOCOL_VERSION,
				tenant: "",
			},
		],
		capabilities: {
			streaming: true,
			pushNotifications: false,
			extensions: [
				{
					uri: PRICING_EXTENSION_URI,
					description: "Per-skill list prices in EUR, excluding VAT.",
					required: false,
					params: pricingParams(),
				},
			],
		},
		// Authless, like every other ELC MCP server. Nothing here reads member data or
		// mutates anything; the services that would are withheld until they have auth.
		securitySchemes: {},
		securityRequirements: [],
		defaultInputModes: ["text/plain", "application/json"],
		defaultOutputModes: ["text/plain", "application/json"],
		skills: LIVE_SERVICES.map(skillFrom),
		signatures: [],
	};
}

/** Pulls the caller's arguments out of an A2A message. */
function argsFrom(ctx: RequestContext): { skill: string; args: Record<string, unknown> } {
	const parts = ctx.userMessage.parts ?? [];
	const text = parts
		.map((p) => (p.content?.$case === "text" ? p.content.value : ""))
		.join("")
		.trim();

	// An A2A client addresses a skill either through message metadata or by sending JSON.
	// Accept both; a bare sentence is not enough to dispatch on and is refused explicitly
	// rather than guessed at.
	const meta = (ctx.userMessage.metadata ?? {}) as Record<string, unknown>;
	if (typeof meta.skill === "string") {
		return { skill: meta.skill, args: (meta.args as Record<string, unknown>) ?? {} };
	}

	try {
		const parsed = JSON.parse(text) as { skill?: string; args?: Record<string, unknown> };
		if (parsed?.skill) return { skill: parsed.skill, args: parsed.args ?? {} };
	} catch {
		// not JSON — fall through
	}

	return { skill: "", args: {} };
}

const MENU = () =>
	[
		"# Engineering Leaders Community — A2A",
		"",
		"Address a skill by sending JSON, or by setting `skill` and `args` in the message metadata:",
		"",
		'```json\n{"skill": "evaluate_meetup_topic", "args": {"title": "Your title here"}}\n```',
		"",
		"## Skills",
		"",
		...LIVE_SERVICES.map((s) => `- \`${s.id}\` — ${s.description}`),
		"",
		`Prices are published in the agent card under the extension \`${PRICING_EXTENSION_URI}\`.`,
	].join("\n");

export class ElcTradeExecutor implements AgentExecutor {
	/**
	 * Service bindings for bridged skills plus the Slack/deal context. Handed in per
	 * request by the Worker entry, because none of it exists at module scope.
	 */
	constructor(private readonly ctx: DispatchContext) {}

	async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
		const { taskId, contextId } = ctx;
		const now = () => new Date().toISOString();

		// The spec requires a `task` or `message` event first.
		const task: Task = {
			id: taskId,
			contextId,
			status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
			artifacts: [],
			history: [ctx.userMessage],
			metadata: undefined,
		};
		bus.publish(AgentEvent.task(task));
		bus.publish(
			AgentEvent.statusUpdate({
				taskId,
				contextId,
				metadata: undefined,
				status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() },
			}),
		);

		const reply = (text: string, state: TaskState) =>
			bus.publish(
				AgentEvent.statusUpdate({
					taskId,
					contextId,
					metadata: undefined,
					status: {
						state,
						timestamp: now(),
						message: {
							messageId: crypto.randomUUID(),
							contextId,
							taskId,
							role: Role.ROLE_AGENT,
							parts: [
								{
									content: { $case: "text", value: text },
									metadata: undefined,
									filename: "",
									mediaType: "text/plain",
								},
							],
							metadata: undefined,
							extensions: [],
							referenceTaskIds: [],
						},
					},
				}),
			);

		try {
			const { skill, args } = argsFrom(ctx);
			if (!skill) {
				// Not a failure — the caller just has not said what they want yet.
				reply(MENU(), TaskState.TASK_STATE_INPUT_REQUIRED);
				bus.finished();
				return;
			}

			const result = await dispatch(skill, args, this.ctx);
			reply(result.report, TaskState.TASK_STATE_COMPLETED);
		} catch (err) {
			reply(
				`${err instanceof Error ? err.message : String(err)}\n\n${MENU()}`,
				TaskState.TASK_STATE_FAILED,
			);
		}
		bus.finished();
	}

	async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
		bus.publish(
			AgentEvent.statusUpdate({
				taskId,
				contextId: "",
				metadata: undefined,
				status: {
					state: TaskState.TASK_STATE_CANCELED,
					message: undefined,
					timestamp: new Date().toISOString(),
				},
			}),
		);
		bus.finished();
	}
}
