# Changelog

## Fork — herdr-core（`hc`）名称同步 (2026-11-16)

上游只认两种外层多路复用器：Herdr pane（`HERDR_ENV=1` + `HERDR_PANE_ID`）和 tmux（`TMUX`）。当前环境换成了 herdr-core（`hc`），它只导出 `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`，所以 `detectMultiplexer` 返回 `none` —— multiplexer 整条链路静默失效：不报错、不发命令、也不改名（连 `herdr-invalid` 那条告警都不会出现）。

- 新增 `hc` / `hc-invalid` 两层检测：`HC_TERMINAL_ID` 存在即 `hc`；只有 `HC_TERMINAL_SOCKET` 而没有 id 则 `hc-invalid` 并告警一次。优先级 herdr → hc → tmux（hc 是 Herdr pane 模型的继任者，仍在 tmux 之内）。
- `createHcAdapter`：capture / readCurrent 走 `hc get <id> --json`（校验 `address`，读 `labels.where`），apply 走 `hc label <id> where=<name>`，restore 写回原 `where`；原来没有该 label 时写 `where=` 删除，herdr-core 自己回落到显示当前目录。restore 前先读回当前值，保留上游「用户后来手动改名就不覆盖」的保护。
- `where` 是 herdr-core 自己的显示标签（`项目 / 空间名`），改名会顶掉空间名，退出 / reload / 关闭同步时还原；二进制路径可用 `HC_BIN_PATH` 覆盖，默认 `hc`。
- 新增 10 项测试（检测 2 项 + 契约与生命周期 8 项）。全量 103 项通过。
- 真实环境实测（herdr-core 0.1.20）：临时终端上 `hc label t4x where=recap-probe` 后 `hc get` / `hc ls` 立即显示新值；`where=` 删除后 `ls` 输出不再带该键。

## Fork — 运行时模型备援 (2026-10-02)

- 新增 `recap.fallbackModel`（默认空）：主模型按 `RECAP_ATTEMPTS` 重试耗尽后，换该模型再试 1 次；备援轮用 `recap.fallbackExtraBody` 作为 `samplingParams`（两个模型的开关通常不同，例如给 deepseek 关思考，实测不带该参数服务器默认开思考）。
- 同模型两次尝试之间加 `RECAP_RETRY_DELAY_MS = 8s` 退避：「集群负载较高」这类瞬时过载里立即重试大概率连续撞墙。
- 失败行标注每个模型的尝试次数，例如 `Failed [minimax-m3×2 → deepseek-v4.1-flash×1]`，能一眼看出重试是否真的跑了。
- 备援模型与主模型相同时直接返回 undefined（重试同一个模型没有意义），配置了这个键但 registry 里找不到时告警一次并继续不带备援。
- 设置面板新增 Fallback model 选择项（`none` / `current` / 可用模型列表）。`tests/recap-fallback.test.ts` 覆盖以上行为。


## Fork — recap 失败自动重试一次 (2026-10-01)

上游渠道偶发返回 **HTTP 200 + 空 completion**（SSE 里 `choices: []` + usage，没有 finish_reason），pi 的 openai-completions 会把它 resolve 成 `stopReason:"error"`（不是 reject），widget 直接显示 `Failed / Recap model failed: Stream ended without finish_reason`。这一层原本没有任何兜底：pi 的 `modelRegistry.complete` 就是 `stream(...).result()`，不注入 retry（`settings.retry` 只作用于交互轮次与压缩），网关侧 `RetryTimes=0` 也不跳渠道重试；而“200 + 无错误”在网关看来是成功，永远不触发渠道自动禁用。

- `runRecap` 的 completion 调用改为最多 `RECAP_ATTEMPTS = 2` 次：任一次拿到可用 recap 即停；两次都不行才报错，且只报一次（错误取最后一次的真实原因）。
- **不重试**的情况：`stopReason === "aborted"`、run 被更新的一次取代、signal 已 abort —— 一律立刻退出，不再多发一个请求，也不报错。
- throw 出来的错误（网络层等）同样重试一次，并且**保留原始 message**：没有 response 时不再拿空输出走一遍 `resolveRecapOutput`，否则 “socket hang up” 会被改写成 “Recap model returned empty output”。
- 重试期间进度条显示 `※ recap  Generating... retry 1/1`（`showRecapProgress` 增加可选 `attempt` 参数，默认 1 时与上游行为一致）。
- 新增 `tests/recap-retry.test.ts`（6 项）：瞬时 error 后第二次成功则存盘、两次都失败只报一次错且写 0 条目、aborted / 被取代 / 首次成功都不发第二个请求、throw 的错误文案不被改写。把 `RECAP_ATTEMPTS` 改回 1 可让其中 3 项变红（测试是承重的）。全量 87 项通过，typecheck 干净。
- 端到端复核：假上游第一次返回与故障渠道同形状的空 completion、第二次返回合法 JSON，跑真实 `runRecap` + 真实 pi `complete()` ⇒ 调用 2 次、recap 存下来、不显示 Failed；把假上游改成恒失败 ⇒ 调用 2 次、写 0 条目、Failed 只出现一次。

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
