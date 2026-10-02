// fork 自有回归测试：recap 对瞬时故障重试一次（RECAP_ATTEMPTS）。
// 起因：上游渠道偶发返回 HTTP 200 + 空 completion（没有 finish_reason），pi 的
// openai-completions 会 resolve 成 stopReason:"error"（不是 reject），widget 直接显示
// "Failed / Recap model failed: Stream ended without finish_reason"。pi 侧
// modelRegistry.complete = stream(...).result() 不注入任何 retry，网关 RetryTimes=0
// 也不跨渠道重试，所以这一层必须自己重试。
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	createRecapState,
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

function createHarness(results: StubResult[], onCall?: (callIndex: number) => void) {
	const appended: RecapEntryData[] = [];
	const progressLines: string[] = [];
	const widgetText: string[] = [];
	const errorTexts: string[] = [];
	let calls = 0;

	const entries = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Fix the recap retry behavior" }], timestamp: 1 },
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

	// TUI 失败态是 factory，文案藏在闭包里——用录制型 theme 把 fg() 收到的字符串取回来。
	// displayRecapWidget 只用 muted/warning，displayRecapError 才会用 error —— 据此区分成败。
	const recordedTheme = {
		fg: (kind: string, text: unknown) => {
			widgetText.push(String(text));
			if (kind === "error") errorTexts.push(String(text));
			return String(text);
		},
		bold: (text: unknown) => String(text),
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
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionName: () => undefined,
			getSessionId: () => "session-id",
		},
		ui: {
			setStatus() {},
			notify() {},
			setWidget(_key: string, value: unknown) {
				if (value === undefined) return;
				// TUI 下失败态是 factory 形式（displayRecapError），进度/成功是字符串行
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
	const state = createRecapState(config);

	const completeModel: NonNullable<RunRecapOptions["completeModel"]> = async () => {
		const index = calls++;
		onCall?.(index);
		const result = results[Math.min(index, results.length - 1)]!;
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
		widgetText,
		errorTexts,
		getErrorShown: () => errorTexts.length > 0,
		calls: () => calls,
	};
}

const OK = { text: '{"recap":"修好了 recap 重试","title":"recap 重试"}' } satisfies StubResult;

test("transient provider error is retried once and then saves", async () => {
	const harness = createHarness([
		{ stopReason: "error", errorMessage: "Stream ended without finish_reason" },
		OK,
	]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.ok(result, "retry should let the recap through");
	assert.equal(harness.calls(), 2, "expected exactly one retry");
	assert.equal(harness.appended.length, 1);
	assert.equal(harness.getErrorShown(), false, "a recovered retry must not show Failed");
});

test("both attempts failing shows one failure and saves nothing", async () => {
	const harness = createHarness([{ stopReason: "error", errorMessage: "Stream ended without finish_reason" }]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls(), 2, "expected exactly one retry before giving up");
	assert.equal(harness.appended.length, 0);
	assert.equal(harness.getErrorShown(), true);
	assert.ok(
		harness.progressLines.some((line) => line.includes("retry 1/1")),
		`expected a retry hint in the progress widget, got ${JSON.stringify(harness.progressLines)}`,
	);
});

test("an aborted run is not retried and not reported as a failure", async () => {
	const harness = createHarness([{ stopReason: "aborted" }, OK]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls(), 1, "abort must not burn a second request");
	assert.equal(harness.getErrorShown(), false);
});

test("a thrown error is retried and keeps its own message instead of empty-output", async () => {
	const harness = createHarness([{ throwError: "socket hang up" }]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
		retryDelayMs: 0,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls(), 2, "thrown errors must also be retried once");
	assert.equal(harness.appended.length, 0);
	assert.ok(
		harness.errorTexts.some((text) => text.includes("socket hang up")),
		`expected the thrown reason to survive into the failure text, got ${JSON.stringify(harness.errorTexts)}`,
	);
	assert.ok(
		!harness.errorTexts.some((text) => text.includes("empty output")),
		"a throw must not be relabelled as empty model output",
	);
});

test("a superseded run stops immediately without a second request", async () => {
	const harness = createHarness([OK, OK], (callIndex) => {
		// 第一次调用后被更新的 run 取代
		if (callIndex === 0) harness.state.activeRun = undefined;
	});

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
	});

	assert.equal(result, undefined);
	assert.equal(harness.calls(), 1, "a superseded run must not issue another request");
});

test("success on the first attempt does not issue a second request", async () => {
	const harness = createHarness([OK]);

	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		completeModel: harness.completeModel,
	});

	assert.ok(result);
	assert.equal(harness.calls(), 1);
});
