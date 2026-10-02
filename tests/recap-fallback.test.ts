// recap 运行时备援：主模型重试耗尽后换 recap.fallbackModel 再试一次。
// 起因：2026-10-02 上游 minimax-m3 "集群负载较高"(2064)，重试两次都撞墙——立即重试
// 对瞬时过载无效，且没有任何模型级故障切换。现行为：主模型 2 次（间隔
// RECAP_RETRY_DELAY_MS）→ 备模型 1 次（用 fallbackExtraBody，例如关思考）。
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	applyConfigSetting,
	createRecapState,
	fallbackModelSelectItems,
	normalizeConfig,
	runRecap,
	type RecapConfig,
	type RecapEntryData,
	type RunRecapOptions,
} from "../extensions/recap.ts";

type StubResult =
	| { text: string; stopReason?: string }
	| { stopReason: "error"; errorMessage: string }
	| { stopReason: "aborted" }
	| { throwError: string };

const FALLBACK_MODEL = { provider: "sc", id: "deepseek-v4.1-flash" };

function createHarness(results: StubResult[]) {
	const appended: RecapEntryData[] = [];
	const progressLines: string[] = [];
	const errorTexts: string[] = [];
	const notifications: string[] = [];
	const calls: { model: string; samplingParams: unknown }[] = [];

	const entries = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Add a runtime fallback model" }], timestamp: 1 },
		},
	] as unknown as SessionEntry[];

	const pi = {
		appendEntry(_customType: string, data: RecapEntryData) {
			appended.push(data);
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
	} as unknown as ExtensionAPI;

	const recordedTheme = {
		fg: (kind: string, text: unknown) => {
			widgetTextFrame(text);
			if (kind === "error") errorTexts.push(String(text));
			return String(text);
		},
		bold: (text: unknown) => String(text),
	};
	const widgetTextFrame = (text: unknown) => {
		// displayRecapError 的 factory 只用 fg 收字符串；进度行走数组分支。
		void text;
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		signal: new AbortController().signal,
		model: { provider: "test", id: "recap-model" },
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
			find(provider: string, id: string) {
				return provider === FALLBACK_MODEL.provider && id === FALLBACK_MODEL.id
					? { ...FALLBACK_MODEL }
					: undefined;
			},
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionName: () => undefined,
			getSessionId: () => "session-id",
		},
		ui: {
			setStatus() {},
			notify(message: string) {
				notifications.push(String(message));
			},
			setWidget(_key: string, value: unknown) {
				if (value === undefined) return;
				if (typeof value === "function") {
					try {
						(value as (tui: unknown, theme: unknown) => unknown)({}, recordedTheme);
					} catch {
						/* 渲染细节不影响断言 */
					}
				} else if (Array.isArray(value)) {
					progressLines.push(...value.map(String));
				}
			},
		},
	} as unknown as ExtensionContext;

	const config = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	config.recap.fallbackModel = "sc/deepseek-v4.1-flash";
	config.recap.fallbackExtraBody = { thinking: { type: "disabled" } };
	const state = createRecapState(config);

	let callIndex = 0;
	const completeModel: NonNullable<RunRecapOptions["completeModel"]> = async (model, _context, opts) => {
		calls.push({
			model: `${(model as { provider: string }).provider}/${(model as { id: string }).id}`,
			samplingParams: (opts as { samplingParams?: unknown } | undefined)?.samplingParams,
		});
		const result = results[Math.min(callIndex++, results.length - 1)]!;
		if ("throwError" in result) throw new Error(result.throwError);
		return {
			role: "assistant",
			content: "text" in result && result.text ? [{ type: "text", text: result.text }] : [],
			stopReason: result.stopReason,
			...("errorMessage" in result ? { errorMessage: result.errorMessage } : {}),
		} as never;
	};

	return {
		pi,
		ctx,
		config,
		state,
		completeModel,
		appended,
		progressLines,
		errorTexts,
		notifications,
		calls,
	};
}

const OK = { text: '{"recap":"备援模型救回来了","title":"recap 备援"}' } satisfies StubResult;
const OVERLOAD = { stopReason: "error", errorMessage: "当前服务集群负载较高 (2064)" } satisfies StubResult;

test("fallback model recovers after the primary model fails twice", async () => {
	const harness = createHarness([OVERLOAD, OVERLOAD, OK]);
	harness.config.recap.extraBody = { thinking: { type: "disabled" } };

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.ok(result, "the fallback attempt should let the recap through");
	assert.equal(harness.calls.length, 3, "two primary attempts + one fallback attempt");
	assert.deepEqual(
		harness.calls.map((call) => call.model),
		["test/recap-model", "test/recap-model", "sc/deepseek-v4.1-flash"],
	);
	assert.deepEqual(harness.calls[0]!.samplingParams, { thinking: { type: "disabled" } }, "primary uses extraBody");
	assert.deepEqual(
		harness.calls[2]!.samplingParams,
		{ thinking: { type: "disabled" } },
		"fallback attempt must carry fallbackExtraBody (thinking off for deepseek)",
	);
	assert.equal(harness.appended.length, 1);
	assert.equal(harness.appended[0]!.model, "sc/deepseek-v4.1-flash", "the entry records the model that worked");
	assert.ok(
		harness.progressLines.some((line) => line.includes("fallback deepseek-v4.1-flash")),
		`expected a fallback note in the progress widget, got ${JSON.stringify(harness.progressLines)}`,
	);
	assert.ok(harness.errorTexts.length === 0, "a recovered fallback must not show Failed");
});

test("everything failing shows one annotated failure with per-model attempt counts", async () => {
	const harness = createHarness([OVERLOAD]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls.length, 3);
	assert.equal(harness.appended.length, 0);
	const header = harness.errorTexts.find((text) => text.includes("Failed")) ?? "";
	assert.match(header, /recap-model×2/, "primary attempt count is visible");
	assert.match(header, /deepseek-v4\.1-flash×1/, "fallback attempt count is visible");
	assert.ok(
		harness.errorTexts.some((text) => text.includes("当前服务集群负载较高")),
		"the last upstream error survives into the failure text",
	);
});

test("no fallback configured keeps exactly two primary attempts", async () => {
	const harness = createHarness([OVERLOAD]);
	harness.config.recap.fallbackModel = "";

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls.length, 2);
	const header = harness.errorTexts.find((text) => text.includes("Failed")) ?? "";
	assert.match(header, /recap-model×2/);
	assert.doesNotMatch(header, /deepseek/);
});

test("an unavailable fallback model warns once and is skipped", async () => {
	const harness = createHarness([OVERLOAD]);
	harness.config.recap.fallbackModel = "sc/ghost-model";

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls.length, 2, "the missing fallback must not burn a third request");
	assert.ok(
		harness.notifications.some((message) => message.includes("sc/ghost-model") && message.includes("unavailable")),
		`expected an unavailability warning, got ${JSON.stringify(harness.notifications)}`,
	);
});

test("a fallback equal to the primary model is skipped", async () => {
	const harness = createHarness([OVERLOAD]);
	harness.config.recap.fallbackModel = "current"; // primary is "current" too

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls.length, 2, "retrying the identical model would be pointless");
});

test("retry backoff is awaited between same-model attempts", async () => {
	const harness = createHarness([OVERLOAD, OK]);
	const startedAt = Date.now();

	await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 30,
	});

	assert.ok(Date.now() - startedAt >= 25, "the backoff delay must actually be awaited");
});

test("fallback model settings", () => {
	const items = fallbackModelSelectItems(
		[{ provider: "sc", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
		"",
	);
	assert.deepEqual(
		items.map((item) => item.value),
		["none", "current", "sc/deepseek-v4.1-flash"],
	);

	const cleared = applyConfigSetting(DEFAULT_CONFIG, "recap.fallbackModel", "none");
	assert.equal(cleared.recap.fallbackModel, "");
	const picked = applyConfigSetting(DEFAULT_CONFIG, "recap.fallbackModel", " sc/deepseek-v4.1-flash ");
	assert.equal(picked.recap.fallbackModel, "sc/deepseek-v4.1-flash");

	const normalized = normalizeConfig({
		...structuredClone(DEFAULT_CONFIG),
		recap: {
			...structuredClone(DEFAULT_CONFIG.recap),
			fallbackModel: "  sc/kimi-k3  ",
			fallbackExtraBody: { thinking: { type: "disabled" } },
		},
	} as RecapConfig);
	assert.equal(normalized.recap.fallbackModel, "sc/kimi-k3", "fallbackModel is trimmed");
	assert.deepEqual(normalized.recap.fallbackExtraBody, { thinking: { type: "disabled" } });

	const junkDropped = normalizeConfig({
		...structuredClone(DEFAULT_CONFIG),
		recap: {
			...structuredClone(DEFAULT_CONFIG.recap),
			fallbackExtraBody: "nope" as unknown as Record<string, unknown>,
		},
	} as RecapConfig);
	assert.equal(junkDropped.recap.fallbackExtraBody, undefined, "non-object fallbackExtraBody is dropped");
});
