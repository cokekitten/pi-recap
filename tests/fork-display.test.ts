// fork 自有回归测试：本 fork 的两处装饰性改动必须由这两个用例守住 —
//   1. TUI：单行紧凑渲染（`※ recap  {time} {recap}`），不渲染标题行与 "Generated {time}"；
//   2. 非 TUI（RPC，pi-web 等）：widget 下发纯字符串行，而不是 RPC 端不可见的 factory。
// 上游升级后若这两个用例失败，说明渲染函数被改写，需要重打 fork patch。
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	WIDGET_PREFIX,
	displayRecapError,
	displayRecapWidget,
	type RecapConfig,
	type RecapEntryData,
} from "../extensions/recap.ts";

const CONFIG = structuredClone(DEFAULT_CONFIG) as RecapConfig;

function createHarness(mode: "tui" | "rpc") {
	const widgets: unknown[] = [];
	const ctx = {
		mode,
		hasUI: true,
		ui: {
			setStatus() {},
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
			notify() {},
		},
	} as unknown as ExtensionContext;
	return { ctx, widgets };
}

function recapData(overrides: Partial<RecapEntryData> = {}): RecapEntryData {
	return {
		recap: "把 recap 渲染改成单行",
		title: "recap 单行化",
		reason: "manual",
		source: { fromEntryId: "a", toEntryId: "b" },
		// 16:39（24 小时制）——上游 0.4.3 起用 hourCycle h23
		generatedAt: Date.parse("2026-09-30T16:39:00"),
		appliedSessionName: false,
		sessionNamePolicy: "never",
		...overrides,
	} as RecapEntryData;
}

function render(value: unknown): string {
	const renderer = value as (
		tui: unknown,
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
	) => { render: (width: number) => string[] };
	const widget = renderer(undefined, { fg: (_color, text) => text, bold: (text) => text });
	// Text(paddingX=1) 会在两侧补空格，断言前去掉
	return widget.render(200).map((line) => line.trim()).join("\n");
}

test("tui recap widget is a single compact line without title or generated-at footer", () => {
	const { ctx, widgets } = createHarness("tui");
	displayRecapWidget(ctx, CONFIG, recapData());

	const text = render(widgets.at(-1));
	assert.equal(text.split("\n").length, 1);
	assert.match(text, /^※ recap {2}\d{2}:\d{2} 把 recap 渲染改成单行$/);
	assert.doesNotMatch(text, /Generated/i);
	// 标题不渲染（仍保留在 data 里用于会话名/多路复用器同步）
	assert.doesNotMatch(text, /recap 单行化/);
});

test("tui recap widget appends a warning line when the title was derived from recap", () => {
	const { ctx, widgets } = createHarness("tui");
	displayRecapWidget(ctx, CONFIG, recapData({ titleSource: "recap-fallback" }));

	const lines = render(widgets.at(-1)).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[1] ?? "", /^⚠ /);
});

test("tui recap error keeps the ※ recap prefix", () => {
	const { ctx, widgets } = createHarness("tui");
	displayRecapError(ctx, CONFIG, "boom");

	assert.match(render(widgets.at(-1)), new RegExp(`^※ recap {2}Failed\\nboom$`));
});

test("rpc recap widget is plain string lines (not an invisible factory)", () => {
	const { ctx, widgets } = createHarness("rpc");
	displayRecapWidget(ctx, CONFIG, recapData());

	const value = widgets.at(-1);
	assert.ok(Array.isArray(value), "widget must be a serializable string array in RPC mode");
	assert.deepEqual(value, [`${WIDGET_PREFIX}16:39 把 recap 渲染改成单行`]);
});

test("rpc recap error overwrites the generating placeholder with a plain line", () => {
	const { ctx, widgets } = createHarness("rpc");
	displayRecapError(ctx, CONFIG, "no model");

	assert.deepEqual(widgets.at(-1), [`${WIDGET_PREFIX}Failed — no model`]);
});
