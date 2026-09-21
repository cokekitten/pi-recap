import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import recapExtension, { setRecapCompletionForTesting } from "../extensions/recap.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type Harness = {
	api: ExtensionAPI;
	context: ExtensionCommandContext;
	entries: Array<{ customType: string; data: unknown }>;
	titles: string[];
	widgets: unknown[];
	lastWidget: unknown;
	model: unknown;
	hostCompletionCalls: Array<[unknown, unknown, unknown]>;
	invokeRecap(): Promise<void>;
	invokeEvent(name: string): Promise<void>;
	widgetText(): string;
};

const SESSION_SENTINEL = "SESSION_CONTENT_MUST_NOT_LEAK";
const HEADER_SENTINEL = "HEADER_VALUE_MUST_NOT_LEAK";
const API_KEY_SENTINEL = "API_KEY_MUST_NOT_LEAK";
const TOOL_ARGUMENT_SENTINEL = "TOOL_ARGUMENT_MUST_NOT_LEAK";
const STOP_REASON_SENTINEL = "STOP_REASON_MUST_NOT_LEAK";
const CONTENT_TYPE_SENTINEL = "CONTENT_TYPE_MUST_NOT_LEAK";
const MODEL_SENTINEL = "MODEL_ID_MUST_NOT_LEAK";
const PROVIDER_ERROR_SENTINEL = "PROVIDER_ERROR_DETAIL_MUST_NOT_LEAK";

function completionResponse(content: unknown[], stopReason: unknown = "stop"): any {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
		responseId: "RESPONSE_ID_MUST_NOT_LEAK",
		rawStopReason: STOP_REASON_SENTINEL,
		errorMessage: "RESPONSE_ERROR_MUST_NOT_LEAK",
	};
}

function createHarness(
	options: {
		mode?: "rpc" | "tui";
		signal?: AbortSignal;
		model?: unknown;
		complete?: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
		onCustomComponent?: (component: { handleInput(data: string): void }) => void;
		onWidgetUpdate?: (widget: unknown) => void;
	} = {},
): Harness {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const titles: string[] = [];
	const widgets: unknown[] = [];
	let lastWidget: unknown;
	const hostCompletionCalls: Array<[unknown, unknown, unknown]> = [];
	const model = options.model ?? { provider: "safe.provider", id: "recap-v1", api: "test-api" };
	const tui = { requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const branch = [
		{
			id: "user-1",
			type: "message",
			message: { role: "user", content: SESSION_SENTINEL, timestamp: 0 },
		},
		{
			id: "user-2",
			type: "message",
			message: { role: "user", content: "Second user turn", timestamp: 0 },
		},
		{
			id: "user-3",
			type: "message",
			message: { role: "user", content: "Third user turn", timestamp: 0 },
		},
	];

	const api = {
		on(name: string, handler: EventHandler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		setSessionName(name: string) {
			titles.push(name);
		},
		getSessionName() {
			return undefined;
		},
	} as unknown as ExtensionAPI;

	const context = {
		// /recap runs its manual completion path only through the TUI loader.
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/safe/project",
		signal: options.signal,
		model,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		waitForIdle: async () => {},
		ui: {
			setStatus() {},
			setWidget(_key: string, widget: unknown) {
				widgets.push(widget);
				lastWidget = widget;
				options.onWidgetUpdate?.(widget);
			},
			async custom(factory: (...args: any[]) => { dispose?(): void }) {
				return await new Promise<unknown>((resolve, reject) => {
					let component: { dispose?(): void } | undefined;
					const done = (result: unknown) => {
						component?.dispose?.();
						resolve(result);
					};
					try {
						component = factory(tui, theme, {}, done);
						options.onCustomComponent?.(component as { handleInput(data: string): void });
					} catch (error) {
						reject(error);
					}
				});
			},
			notify() {},
			setTitle() {},
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionName: () => undefined,
			getSessionId: () => "session-1",
		},
		modelRegistry: {
			async complete(model: unknown, completionContext: unknown, completionOptions: unknown) {
				hostCompletionCalls.push([model, completionContext, completionOptions]);
				return await (options.complete?.(model, completionContext, completionOptions) ?? completionResponse([{ type: "text", text: '{"recap":"Host recap"}' }]));
			},
		},
	} as unknown as ExtensionCommandContext;

	recapExtension(api);
	return {
		api,
		context,
		entries,
		titles,
		widgets,
		get lastWidget() {
			return lastWidget;
		},
		model,
		hostCompletionCalls,
		async invokeRecap() {
			const handler = commands.get("recap");
			assert.ok(handler, "the extension must register /recap");
			await handler("", context);
		},
		async invokeEvent(name: string) {
			for (const handler of events.get(name) ?? []) await handler({}, context);
		},
		widgetText() {
			return widgets
				.flatMap((widget) => {
					if (Array.isArray(widget)) return widget.filter((line): line is string => typeof line === "string");
					if (typeof widget !== "function") return [];
					const component = widget(tui, theme) as { render?: (width: number) => string[] };
					return component.render?.(200) ?? [];
				})
				.join("\n");
		},
	};
}

test("/recap uses the Pi host model registry completion with its selected model, token limit, and cancellation signal", async () => {
	const harness = createHarness();

	await harness.invokeRecap();

	assert.equal(harness.hostCompletionCalls.length, 1);
	const [model, context, options] = harness.hostCompletionCalls[0]!;
	assert.equal(model, harness.model);
	assert.ok(context && typeof context === "object", "host completion must receive the recap context");
	assert.equal((options as { maxTokens?: unknown }).maxTokens, 300);
	assert.ok((options as { signal?: unknown }).signal instanceof AbortSignal, "host completion must receive the recap cancellation signal");
	assert.equal(harness.entries.length, 1);
	assert.equal((harness.entries[0]!.data as { recap: string }).recap, "Host recap");
});

test("a provider error response is not retried and exposes only a fixed safe request-failure diagnostic", async () => {
	const harness = createHarness({
		complete: async () => ({
			...completionResponse([], "error"),
			errorMessage: PROVIDER_ERROR_SENTINEL,
		}),
	});

	await harness.invokeRecap();

	assert.equal(harness.hostCompletionCalls.length, 1);
	assert.deepEqual(harness.entries, []);
	assert.deepEqual(harness.titles, []);
	const widget = harness.widgetText();
	assert.match(widget, /request failed/i);
	assert.doesNotMatch(widget, /empty output/i);
	for (const forbidden of [
		PROVIDER_ERROR_SENTINEL,
		SESSION_SENTINEL,
		HEADER_SENTINEL,
		API_KEY_SENTINEL,
		"RESPONSE_ID_MUST_NOT_LEAK",
		"RESPONSE_ERROR_MUST_NOT_LEAK",
	]) {
		assert.doesNotMatch(widget, new RegExp(forbidden));
	}
});

function assertNoRecapSideEffects(harness: Harness): void {
	assert.deepEqual(harness.entries, []);
	assert.deepEqual(harness.titles, []);
	assert.equal(harness.lastWidget, undefined, "an inactive or aborted run must clear its recap display");
}


test("/recap retries one empty completion with the same model and parameters, then persists the retry text", async () => {
	const harness = createHarness();
	const calls: Array<[unknown, unknown, unknown]> = [];
	const restore = setRecapCompletionForTesting(async (model: any, context: any, options: any) => {
		calls.push([model, context, options]);
		if (calls.length === 1) return completionResponse([{ type: "text", text: " \t\n " }]);
		return completionResponse([{ type: "text", text: '{"recap":"Recovered recap","title":"Recovered title"}' }]);
	});

	try {
		await harness.invokeRecap();
	} finally {
		restore();
	}

	assert.equal(calls.length, 2);
	assert.equal(calls[0]![0], harness.model);
	assert.equal(calls[1]![0], harness.model);
	assert.deepEqual(calls[1]!.slice(1), calls[0]!.slice(1), "the retry must use the original completion parameters");
	assert.equal(harness.entries.length, 1);
	assert.equal(harness.entries[0]!.customType, "recap");
	const recap = harness.entries[0]!.data as { recap?: string; title?: string };
	assert.equal(recap.recap, "Recovered recap");
	assert.equal(recap.title, "Recovered title");
	assert.match(harness.widgetText(), /Recovered recap/);
});

test("/recap never retries a first completion that includes text", async () => {
	const harness = createHarness();
	let calls = 0;
	const restore = setRecapCompletionForTesting(async () => {
		calls++;
		return completionResponse([{ type: "text", text: '{"recap":"First response"}' }]);
	});

	try {
		await harness.invokeRecap();
	} finally {
		restore();
	}

	assert.equal(calls, 1);
	assert.equal(harness.entries.length, 1);
	assert.equal((harness.entries[0]!.data as { recap: string }).recap, "First response");
});

test("two empty completions persist nothing and expose only whitelisted diagnostic metadata", async () => {
	const harness = createHarness({
		model: { provider: `unsafe:${MODEL_SENTINEL}`, id: "recap-v1", api: "test-api" },
	});
	let calls = 0;
	const restore = setRecapCompletionForTesting(async () => {
		calls++;
		if (calls === 1) {
			return completionResponse(
				[
					{ type: { value: CONTENT_TYPE_SENTINEL }, arguments: TOOL_ARGUMENT_SENTINEL },
					{ type: "thinking", text: " " },
				],
				{ value: STOP_REASON_SENTINEL },
			);
		}
		return completionResponse(
			[
				{ type: "toolCall", arguments: TOOL_ARGUMENT_SENTINEL },
				{ type: "image", url: "IMAGE_URL_MUST_NOT_LEAK" },
			],
			"tool_use",
		);
	});

	try {
		await harness.invokeRecap();
	} finally {
		restore();
	}

	assert.equal(calls, 2);
	assert.deepEqual(harness.entries, []);
	assert.deepEqual(harness.titles, []);
	const widget = harness.widgetText();
	assert.match(widget, /unknown-model/);
	assert.match(widget, /unknown/);
	assert.match(widget, /thinking/);
	assert.match(widget, /tool-use/);
	assert.match(widget, /tool-call/);
	assert.match(widget, /image/);
	for (const forbidden of [
		SESSION_SENTINEL,
		HEADER_SENTINEL,
		API_KEY_SENTINEL,
		TOOL_ARGUMENT_SENTINEL,
		STOP_REASON_SENTINEL,
		CONTENT_TYPE_SENTINEL,
		MODEL_SENTINEL,
		"RESPONSE_ID_MUST_NOT_LEAK",
		"RESPONSE_ERROR_MUST_NOT_LEAK",
		"IMAGE_URL_MUST_NOT_LEAK",
	]) {
		assert.doesNotMatch(widget, new RegExp(forbidden));
	}
});

test("aborted responses and cancelled manual runs do not retry or render an empty-output diagnostic", async (t) => {
	await t.test("aborted completion", async () => {
		const harness = createHarness();
		let calls = 0;
		const restore = setRecapCompletionForTesting(async () => {
			calls++;
			return completionResponse([], "aborted");
		});
		try {
			await harness.invokeRecap();
		} finally {
			restore();
		}
		assert.equal(calls, 1);
		assertNoRecapSideEffects(harness);
	});

	await t.test("manual signal cancellation after completion", async () => {
		let loader: { handleInput(data: string): void } | undefined;
		let cancelled = false;
		let observeBackgroundClear!: () => void;
		const backgroundCleared = new Promise<void>((resolve) => {
			observeBackgroundClear = resolve;
		});
		const harness = createHarness({
			onCustomComponent(component) {
				loader = component;
			},
			onWidgetUpdate(widget) {
				if (cancelled && widget === undefined) observeBackgroundClear();
			},
		});
		let releaseCompletion!: (response: any) => void;
		const completion = new Promise<any>((resolve) => {
			releaseCompletion = resolve;
		});
		let observeCompletionStart!: () => void;
		const completionStarted = new Promise<void>((resolve) => {
			observeCompletionStart = resolve;
		});
		let calls = 0;
		const restore = setRecapCompletionForTesting(async () => {
			calls++;
			observeCompletionStart();
			return await completion;
		});
		try {
			const recapCommand = harness.invokeRecap();
			await completionStarted;
			assert.ok(loader, "the manual recap loader must be mounted before completion completes");
			cancelled = true;
			loader.handleInput("\x1b");
			await recapCommand;
			releaseCompletion(completionResponse([]));
			await backgroundCleared;
		} finally {
			restore();
		}
		assert.equal(calls, 1);
		assertNoRecapSideEffects(harness);
	});
});

test("an inactive automatic recap does not retry its completed empty response", async () => {
	const harness = createHarness({ mode: "tui" });
	let calls = 0;
	let resolveFirst!: (response: any) => void;
	const firstResponse = new Promise<any>((resolve) => {
		resolveFirst = resolve;
	});
	let begin!: () => void;
	const completionStarted = new Promise<void>((resolve) => {
		begin = resolve;
	});
	const restore = setRecapCompletionForTesting(async () => {
		calls++;
		begin();
		return firstResponse;
	});
	const originalSetTimeout = globalThis.setTimeout;
	(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((callback: () => void) => {
		void Promise.resolve().then(callback);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;

	try {
		await harness.invokeEvent("agent_end");
		await completionStarted;
		await harness.invokeEvent("input");
		resolveFirst(completionResponse([]));
		await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
	} finally {
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
		restore();
	}

	assert.equal(calls, 1);
	assertNoRecapSideEffects(harness);
});

test("thrown completion failures do not retry and use the normal TUI error path", async (t) => {
	await t.test("host completion rejection makes one request", async () => {
		const failure = new Error("host completion failure");
		const harness = createHarness({
			complete: async () => {
				throw failure;
			},
		});
		await harness.invokeRecap();
		assert.equal(harness.hostCompletionCalls.length, 1);
		assert.deepEqual(harness.entries, []);
		assert.deepEqual(harness.titles, []);
		assert.match(harness.widgetText(), /host completion failure/);
		assert.doesNotMatch(harness.widgetText(), /empty output/);
	});

	await t.test("first completion rejects after one call", async () => {
		const harness = createHarness();
		const failure = new Error("transport failure");
		let calls = 0;
		const restore = setRecapCompletionForTesting(async () => {
			calls++;
			throw failure;
		});
		try {
			await harness.invokeRecap();
		} finally {
			restore();
		}
		assert.equal(calls, 1);
		assert.deepEqual(harness.entries, []);
		assert.match(harness.widgetText(), /transport failure/);
		assert.doesNotMatch(harness.widgetText(), /empty output/);
	});

	await t.test("second completion rejects after one empty result", async () => {
		const harness = createHarness();
		const failure = new Error("completion failure");
		let calls = 0;
		const restore = setRecapCompletionForTesting(async () => {
			calls++;
			if (calls === 1) return completionResponse([]);
			throw failure;
		});
		try {
			await harness.invokeRecap();
		} finally {
			restore();
		}
		assert.equal(calls, 2);
		assert.deepEqual(harness.entries, []);
		assert.match(harness.widgetText(), /completion failure/);
		assert.doesNotMatch(harness.widgetText(), /empty output/, "a thrown retry must not become an empty-output diagnostic");
	});
});
