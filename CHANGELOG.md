# Changelog

## Fork — recap 请求体透传 `recap.extraBody` (2026-09-30)

fork 自有配置项（上游没有），用于把 provider 特有字段带进 recap 的请求体：

- `recap.extraBody`（对象）→ 作为 pi 的 `StreamOptions.samplingParams` 下发；pi 在自身具名字段之后合并，所以这里的键会覆盖。典型用法 `{"thinking":{"type":"disabled"}}` 关掉 MiniMax M3 这类默认强制思考模型的思考链：思考 token 与 recap 输出共用 300 token 预算，实测 ~10k 字符上下文下 5 次里 2–3 次被截断成失败，关掉后 5/5 成功、耗时 2.5–3.5s → 1.0–1.5s、输出 ~300 → ~60 token。
- 抽出 `recapCompleteOptions()` 统一构造 recap 的 completion options（原来在调用点内联），便于测试；未配置 `extraBody` 时不带 `samplingParams`，行为与上游一致。
- 新增 `tests/recap-extra-body.test.ts`（4 项）：`normalizeConfig` 保留非空对象、丢弃空对象/非对象；`recapCompleteOptions` 透传与省略；`runRecap` 真的把 `extraBody` 放到 completion options 上。全量 81 项通过。
- 只在 recap 调用里生效：不要把它写到 models.json 的 model/provider 级别，那会连带关掉交互使用同一模型时的思考。

## Fork — rebased onto upstream 0.4.3 (2026-09-30)

本地 fork 改动重新落到上游 0.4.3 基线上（`extensions/`、`tests/`、`examples/`、README、CHANGELOG 全部取自 `zhcsyncer/pi-extensions@f48a91b`），此前基于 0.4.0 的 4 处展示层改动手工重打：

- 单行紧凑 widget：`※ recap  {time} {recap}`，不再渲染标题行与 `Generated {time}`（标题仍用于 session name / multiplexer 同步）。
- 三态前缀 `RECAP  ` → `※ recap  `；fallback 标题提示由 `WARNING  {text}` 改为 `⚠ {text}`。
- 非 TUI（RPC，`pi-web` 等）下 recap 进度/结果/错误改用纯字符串行下发（原代码直接 `return`，RPC 端什么都看不到）。
- 为守住以上行为，`displayRecapWidget` / `displayRecapError` / `showRecapProgress` / `WIDGET_PREFIX` 改为导出，新增 `tests/fork-display.test.ts`。

本地开发依赖 pin 提到运行时同版本 `@earendil-works/*@0.99.1`（上游 pin 0.86.1）；typecheck 与 77 项测试通过。

## 0.4.3

### Patch Changes

- 100ce43: Recap no longer saves a long unstructured model dump as the recap: short plain-text replies still work, but oversized echoes fail instead of filling the widget and deriving a truncated title. The recap system prompt now says not to continue the conversation or copy it. Generated time in the widget uses a 24-hour local clock.
- a765209: Fix tmux name sync failing when window-level automatic-rename is unset. Query the option with `show-window-options -v` because tmux 3.4 rejects `-q` on that command, treat empty output as unset, and restore by unsetting the window option with `-u` instead of writing an empty value.

## 0.4.2

### Patch Changes

- 65466be: `/recap-config` now covers every recap option, including choosing a model from the currently enabled list. Fallback stays hidden while the model is `current`, and recap warns if a chosen model is missing and it falls back.
- 65466be: Recap no longer fails with 400 on OpenCode / OpenCode Go due to a missing `x-opencode-session` header. Out-of-band recap calls now go through Pi's model registry so they use the same authentication and custom endpoints as the main session.
- 65466be: Session-name handling is one setting again. `off` turns sync off; `if-empty`, `if-empty-or-auto`, and `always` keep their previous meaning.
- 65466be: Recap config is now thinner: `/recap` is always available, and `/recap-config` only keeps auto recap, idle wait, model, language, whether to write the title into the session name (on = do not overwrite a manual name), plus multiplexer enablement and template.

## 0.4.1

### Patch Changes

- f3582d5: Derive a bounded fallback title from valid recap text with a persisted widget warning, and reject truncated, failed, empty, or malformed JSON-like model output without saving partial recap state.

## 0.4.0

### Minor Changes

- 1683e4f: Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.

## 0.3.0

### Minor Changes

- da42f35: Add automatic nearest-layer terminal multiplexer naming to recap: Herdr pane labels now take precedence over inherited tmux windows, legacy `tmux` config migrates to `multiplexer`, and ownership-aware restore avoids clobbering later manual renames while handling disable, reload, and shutdown lifecycles.

## Unreleased

### Added

- Added automatic Herdr pane-label synchronization through Herdr's CLI, with Herdr taking precedence over inherited tmux sessions.
- Added ownership-aware restoration, serialized naming updates, failure warnings, and fake-runner contract tests for both supported multiplexers.

### Changed

- Replaced the public `tmux` config group with the shared `multiplexer` group; legacy config migrates automatically and explicit new fields take precedence.
- Restore owned multiplexer names on extension reload and preserve later manual renames during shutdown or runtime disablement.

## 0.2.0

## 0.1.4

### Patch Changes

- 5709a8a: Use the editor widget as the sole persistent recap surface, remove the footer display mode and duplicate success notification, keep manual generation in its cancellable loader, and persistently clean up legacy display config fields.

## 0.1.3

### Patch Changes

- 5e41607: Cancel in-flight automatic recaps when new input starts, prevent stale runs from writing results, and replace the independent widget toggle with mutually exclusive status/widget display modes.

## 0.1.2

### Patch Changes

- 24abac8: Improve the recap widget hierarchy, restore it after reload, and show a cancellable loading indicator while generating manual recaps.

## 0.1.1

- Remove `recap.interactiveOnly`; recap is now always disabled outside TUI mode.
- Split Chinese documentation into `README.zh-CN.md`; `README.md` is English by default.

## 0.1.0

- Initial release.
- Add `/recap` for recent activity recap generation.
- Add automatic idle recap.
- Generate optional session title as a recap side effect.
- Add `/recap-config` and `/recap-config json`.
- Add optional tmux window name sync.
