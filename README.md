# pi-recap

[中文文档](./README.zh-CN.md)

**Repo:** https://github.com/cokekitten/pi-recap

> **About this repo** — standalone fork of [`@zhcsyncer/pi-recap`](https://github.com/zhcsyncer/pi-extensions/tree/main/packages/pi-recap) (the `pi-recap` package in the `zhcsyncer/pi-extensions` monorepo), kept in sync with upstream **0.4.3**. Changes are the recap display layer plus one config escape hatch (`recap.extraBody`); everything else — behavior, config shape, and model calls — stays upstream's:
>
> - **Single-line recap widget**: success rendering is one compact line — `※ recap  {time} {recap}` — instead of the multi-line block (title + body + `Generated {time}`).
> - **Prefix restyle**: `RECAP  ` → `※ recap  ` (with the ※ marker) across the generating / failed / success states; the fallback-title warning renders as `⚠ {warning}` instead of `WARNING  {warning}`.
> - **Title dropped from the widget**: the `data.title ?? "Recent activity"` heading is not rendered. The title is still generated and still drives session-name and multiplexer sync.
> - **RPC modes show recap too**: in non-TUI modes (`pi-web` and other RPC clients) a factory-shaped widget is invisible, so progress, results, and errors are delivered as plain string lines instead of being skipped.
> - **`recap.extraBody` request passthrough** (fork-only config key): raw JSON fields forwarded to the recap completion as pi's `StreamOptions.samplingParams`, which pi merges into the request body after its own named fields. Used to switch off provider-side thinking that pi does not model, so it cannot eat the recap output budget (see "Turn off provider thinking").
>
> The first four behaviors are pinned by `tests/fork-display.test.ts`, the fifth by `tests/recap-extra-body.test.ts`; after rebasing onto a newer upstream, run those two files first. Upstream updates therefore drop in as: copy `extensions/` + `tests/` + `examples/` + `README*` + `CHANGELOG.md`, re-apply these patches, then `npm test`.

`pi-recap` is a Pi extension that generates a **recent activity recap**. It is not compaction and does not replace or shrink the LLM context.

Features:

- Generate a recent activity recap with `/recap`.
- Automatically recap after the agent has been idle for a while.
- Cancel an unfinished automatic recap when a new message arrives, preventing stale results from being stored or displayed.
- Display automatic recap progress plus recap results and errors in an editor widget, without duplicating successful results in chat notifications. Generated time uses a 24-hour local clock.
- Generate a short title as a recap side effect, with a deterministic recap-derived fallback and visible warning when the model omits a usable title.
- Reject empty, truncated, failed, malformed JSON-like, or overly long unstructured model output without saving partial recap state.
- Optionally apply the title to the Pi session name with `title.applyPolicy`: `off`, `if-empty`, `if-empty-or-auto`, or `always`. `off` leaves the name alone.
- Optionally sync Pi session name changes to the nearest terminal multiplexer: a Herdr pane label or tmux window name.
- `/recap` is always available. `/recap-config` only keeps auto recap, idle wait, model, language, session-name policy, plus multiplexer enablement and template.
- `/recap-config json` remains available as an escape hatch, but is not required for normal use.

### Installation

From this fork on GitHub:

```bash
pi install git:github.com/cokekitten/pi-recap
```

Or try it for one run without installing:

```bash
pi -e git:github.com/cokekitten/pi-recap
```

From a local checkout (e.g. in `~/.pi/agent/settings.json` → `packages`):

```bash
#   "../../dev/pi-expansion/pi-recap"
pi install /path/to/pi-recap
# or
pi -e /path/to/pi-recap
```

After installing, restart pi or run `/reload`.

Upstream alternatives (`@zhcsyncer/pi-recap`, whole-bundle install) still work; they just do not include this fork's display layer.

### Commands

```text
/recap
```

Generate a recent activity recap. It will:

1. collect recent activity since the previous recap;
2. call a model to generate a one-line recap;
3. generate a short title;
4. persist state with `pi.appendEntry("recap", ...)`;
5. display the recap in an editor widget;
6. optionally apply the title to the Pi session name;
7. optionally sync the session name to the nearest Herdr pane or tmux window.

```text
/recap-config
```

Open the TUI config screen. `/recap` is always available; auto recap is the background switch. It saves to:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json
```

The model list starts with `current` (the session model), then currently enabled models. A configured model that is not in that list still shows, and opening the picker does not change it. While the model is `current`, fallback is hidden and left unchanged. If you pick a specific model that later cannot be resolved and fallback is on, recap warns once and uses the session model. A cheaper dedicated recap model is recommended.

```text
/recap-config json
```

Edit the JSON config. This is optional; the TUI covers the remaining settings, including a custom idle wait and language.

### TUI only

recap only runs in Pi TUI mode. Headless modes such as `print`, `json`, and `rpc` are skipped to avoid extra model calls, session writes, or naming side effects in scripts and multi-instance environments.

### Config files

The extension reads:

```text
$PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json
.pi/extension-data/pi-recap/config.json
```

Project-local `.pi/extension-data/pi-recap/config.json` is read only when the project is trusted, and it overrides global config. On first load, the previous global and trusted-project paths are automatically migrated and upgraded; unmappable fields are dropped with a warning, and malformed files are preserved.

See example config:

```text
examples/recap.json
```

Default config:

```json
{
  "recap": {
    "auto": true,
    "idleAfterTurnMs": 180000,
    "model": "current",
    "fallbackToCurrentModel": true,
    "language": "auto"
  },
  "title": {
    "applyPolicy": "off"
  },
  "multiplexer": {
    "enabled": true,
    "template": "π {session} · {project}"
  }
}
```

### Common config

Apply generated titles to Pi session names:

```json
{
  "title": {
    "applyPolicy": "if-empty-or-auto"
  }
}
```

Titles are always generated. If the model omits a usable title, recap deterministically uses the cleaned one-line recap as the title. `off` does not change the Pi session name. `if-empty` fills a blank name only. `if-empty-or-auto` also updates a name recap last wrote, without overwriting a later manual name. `always` overwrites. The persisted recap records that the title came from the fallback, so the editor widget shows the warning after generation and after a session reload.

Short plain-text and ordinary bullet recap responses remain valid. Empty recaps, malformed or truncated JSON-like responses, overly long unstructured dumps, and completions stopped with `length` or `error` are treated as failed recaps: the widget shows the failure, no recap entry is appended, the session is not renamed, and the previous recap source position is preserved.

Disable automatic recap and keep manual `/recap` only:

```json
{
  "recap": {
    "auto": false
  }
}
```

Use a specific recap model in `/recap-config`, or in JSON:

```json
{
  "recap": {
    "model": "google/gemini-2.5-flash",
    "fallbackToCurrentModel": true
  }
}
```

Recap display always uses an editor widget above the editor. Automatic recap progress is replaced by the result in that widget. Manual `/recap` uses a cancellable loader while generating, then shows the result in the widget. The widget is cleared when the next message starts. If an automatic recap is still running, it is cancelled and cannot later store or redisplay a stale result.

#### Turn off provider thinking that Pi does not model

Some models think by default on the server side even when the request carries no reasoning instruction — recap never sends one, so `/think` does not affect it. Reasoning tokens are billed against the recap output budget (`maxTokens`), so a thinking model can spend the whole budget on reasoning, truncate the JSON, and make every other recap fail with `Recap model output was truncated by the token limit`.

`recap.extraBody` merges raw fields into the recap request body (forwarded as pi's `StreamOptions.samplingParams`, applied after pi's own fields, so these keys win). Providers that do not understand the fields ignore them:

```json
{
  "recap": {
    "model": "your-provider/minimax-m3",
    "extraBody": { "thinking": { "type": "disabled" } }
  }
}
```

Measured on MiniMax M3 behind an OpenAI-compatible gateway, recapping ~10k chars of recent activity at the 300-token recap budget: with thinking on (no `extraBody`) 2–3 of 5 recaps failed as truncated and each took ~2.5–3.5s; with `{"thinking":{"type":"disabled"}}` all 5 succeeded in ~1.0–1.5s and produced ~60 output tokens instead of ~300. Only request-level keys belong here: a model-level or provider-level override would also strip thinking from your interactive use of the same model. Models that require thinking (MiniMax rejects `thinking.type="disabled"` with "requires adaptive thinking") cannot be used this way — pick another model or raise `RECAP_MAX_TOKENS` in the source instead. `extraBody` is not in `/recap-config`; edit the JSON, or use `/recap-config json`.

When an older config is loaded, removed fields such as `enabled`, `manualCommand`, `title.generate`, `title.applyToSessionName`, and `display` are dropped and the source config file is updated. A previous `enabled: false` becomes `auto: false`. `applyToSessionName: false` or `applyPolicy: "never"` becomes `applyPolicy: "off"`; other session-name policies are kept. Legacy `tmux` settings are migrated to `multiplexer`; when both exist, explicitly configured `multiplexer` fields take precedence.

Customize the Herdr pane label or tmux window name:

```json
{
  "multiplexer": {
    "template": "π {project} · {session}"
  }
}
```

Supported variables:

```text
{session}
{project}
{cwd}
{id}
```

### Language

`recap.language` defaults to:

```json
{
  "recap": {
    "language": "auto"
  }
}
```

`auto` asks the model to use the same primary language as the recent activity. You can also force a language:

```json
{
  "recap": {
    "language": "zh-CN"
  }
}
```

or:

```json
{
  "recap": {
    "language": "en"
  }
}
```

Note: Pi currently does not expose a user language or locale field to extensions. This is an extension-level setting.

### Terminal multiplexer behavior

When `multiplexer.enabled` is true, recap automatically selects the directly hosting layer:

1. `HERDR_ENV=1` with a non-empty `HERDR_PANE_ID` selects the current Herdr pane label. The `herdr` CLI must be available; Herdr may provide its absolute path through `HERDR_BIN_PATH`.
2. If Herdr is not detected and `TMUX` exists, recap selects the current tmux window name.
3. Otherwise, naming is a no-op.

In nested Herdr-inside-tmux sessions, recap only updates the Herdr pane. If Herdr is detected but its pane identity is incomplete or its CLI is unavailable, recap warns once and does not fall back to the inherited tmux layer.

For tmux, recap keeps the original behavior of disabling `automatic-rename` while it owns the window name. The original pane/window name is restored only if the current name still equals recap's last successful write, so a later manual rename is preserved. Disabling sync or reloading the extension releases ownership immediately; reload always restores before the new extension instance reapplies the name. Ordinary Pi exit also restores the previous name. tmux's captured `automatic-rename` setting is restored whenever owned sync is restored or disabled.

All of these trigger multiplexer sync:

```bash
pi --name "auth refresh"
```

```text
/name auth refresh
```

and recap calling `pi.setSessionName(title)` when enabled by config. Recap does not modify Herdr's Pi agent-state integration.

### Privacy and cost

- Recap makes an extra model call.
- By default it uses the current Pi model: `recap.model = "current"`.
- A cheaper dedicated recap model is recommended if you do not want to spend the session model on this side call.
- Recent activity is sent to the current or configured provider.
- Disable automatic recap if you do not want extra background model calls:

```json
{
  "recap": {
    "auto": false
  }
}
```

### Not compaction

`pi-recap` does not:

- call Pi compact;
- replace LLM history;
- inject recap into future LLM context;
- delete or compress session messages.

Recap history is persisted as extension state with `pi.appendEntry("recap", ...)` and does not participate in LLM context.

### Discoverability in the Pi package gallery

Pi docs state that the package gallery displays packages tagged with the `pi-package` keyword. For public discovery, publish a public npm package and include:

```json
{
  "keywords": ["pi-package"]
}
```

Also include a `pi` manifest:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"]
  }
}
```

Optional gallery preview image:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "image": "https://example.com/screenshot.png"
  }
}
```

or MP4 video:

```json
{
  "pi": {
    "extensions": ["./extensions/recap.ts"],
    "video": "https://example.com/demo.mp4"
  }
}
```
