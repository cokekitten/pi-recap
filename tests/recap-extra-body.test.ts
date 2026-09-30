// fork 自有回归测试：recap 必须能把 provider 特有字段透传到 recap 请求体
// （config.recap.extraBody → pi 的 StreamOptions.samplingParams，pi 在具名字段之后合并，所以会覆盖）。
// 典型用途：MiniMax M3 这类默认强制思考的模型，用 {"thinking":{"type":"disabled"}} 关掉思考，
// 否则思考 token 会吃光 RECAP_MAX_TOKENS，recap 直接报 "output was truncated by the token limit"。
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	createRecapState,
	normalizeConfig,
	recapCompleteOptions,
	runRecap,
	type RecapConfig,
	type RecapEntryData,
	type RunRecapOptions,
} from "../extensions/recap.ts";

const BASE = structuredClone(DEFAULT_CONFIG) as RecapConfig;

function createHarness(spec: { text?: string; stopReason?: string }) {
	const appended: Array<{ customType: string; data: RecapEntryData }> = [];
	const entries = [
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix the recap title behavior" }],
				timestamp: 1,
			},
		},
	] as unknown as SessionEntry[];
	const pi = {
		appendEntry(customType: string, data: RecapEntryData) {
			appended.push({ customType, data });
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		signal: new AbortController().signal,
		model: { provider: "test", id: "recap-model" },
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionName: () => undefined,
			getSessionId: () => "session-id",
		},
		ui: { setStatus() {}, setWidget() {}, notify() {} },
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	const state = createRecapState(config);
	const completeModel: NonNullable<RunRecapOptions["completeModel"]> = async () =>
		({
			role: "assistant",
			content: spec.text ? [{ type: "text", text: spec.text }] : [],
			stopReason: spec.stopReason,
		}) as never;

	return { pi, ctx, config, state, completeModel, appended };
}

test("normalizeConfig keeps a non-empty recap.extraBody object", () => {
	const config = normalizeConfig({
		...BASE,
		recap: { ...BASE.recap, extraBody: { thinking: { type: "disabled" } } },
	} as RecapConfig);
	assert.deepEqual(config.recap.extraBody, { thinking: { type: "disabled" } });
});

test("normalizeConfig drops empty or non-object recap.extraBody", () => {
	for (const value of [{}, "nope", [], null, 3] as unknown[]) {
		const config = normalizeConfig({ ...BASE, recap: { ...BASE.recap, extraBody: value } } as RecapConfig);
		assert.equal("extraBody" in config.recap, false, `expected ${JSON.stringify(value)} to be dropped`);
	}
});

test("recapCompleteOptions forwards extraBody as samplingParams and omits it when unset", () => {
	const withBody = recapCompleteOptions(
		{ ...BASE, recap: { ...BASE.recap, extraBody: { thinking: { type: "disabled" } } } },
		{ maxTokens: 300, sessionId: "s1", headers: { "x-a": "1" } },
	);
	assert.deepEqual(withBody.samplingParams, { thinking: { type: "disabled" } });
	assert.equal(withBody.maxTokens, 300);
	assert.equal(withBody.sessionId, "s1");
	assert.deepEqual(withBody.headers, { "x-a": "1" });

	const withoutBody = recapCompleteOptions(BASE, { maxTokens: 300 });
	assert.equal("samplingParams" in withoutBody, false);
	assert.equal("headers" in withoutBody, false);
});

test("runRecap puts the configured extraBody on the completion options", async () => {
	const harness = createHarness({ text: "关思考后 recap 正常返回", stopReason: "stop" });
	const config = {
		...harness.config,
		recap: { ...harness.config.recap, extraBody: { thinking: { type: "disabled" } } },
	} as RecapConfig;
	let captured: Record<string, unknown> | undefined;

	const result = await runRecap(harness.pi, harness.ctx, config, harness.state, "manual", {
		force: true,
		showProgress: false,
		completeModel: async (model, context, opts) => {
			captured = opts as unknown as Record<string, unknown>;
			return harness.completeModel(model, context, opts);
		},
	});

	assert.ok(result);
	assert.deepEqual(captured?.samplingParams, { thinking: { type: "disabled" } });
});
