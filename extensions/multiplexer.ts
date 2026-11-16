import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MultiplexerConfig = {
	enabled: boolean;
	template: string;
	maxLength: number;
	restoreOnShutdown: boolean;
};

export type MultiplexerNameContext = {
	sessionName?: string;
	cwd: string;
	sessionId: string;
};

export type MultiplexerEnvironment = Record<string, string | undefined>;

export type CommandOutput = {
	stdout: string;
	stderr?: string;
};

export type CommandRunner = (command: string, args: string[]) => Promise<CommandOutput>;

export type MultiplexerHooks = {
	setTitle(name: string): void;
	warn(message: string): void;
};

export type MultiplexerDetection =
	| { kind: "herdr"; paneId: string }
	| { kind: "herdr-invalid" }
	| { kind: "hc"; terminalId: string }
	| { kind: "hc-invalid" }
	| { kind: "tmux" }
	| { kind: "none" };

type TmuxSnapshot = {
	windowId: string;
	originalName: string;
	originalAutomaticRename: string;
};

type HerdrSnapshot = {
	paneId: string;
	originalLabel?: string;
};

type HcSnapshot = {
	terminalId: string;
	originalWhere?: string;
};

type SnapshotByKind = {
	tmux: TmuxSnapshot;
	herdr: HerdrSnapshot;
	hc: HcSnapshot;
};

type MultiplexerKind = keyof SnapshotByKind;

type MultiplexerAdapter<K extends MultiplexerKind = MultiplexerKind> = {
	kind: K;
	capture(): Promise<SnapshotByKind[K]>;
	apply(snapshot: SnapshotByKind[K], name: string): Promise<void>;
	readCurrent(snapshot: SnapshotByKind[K]): Promise<string | undefined>;
	restore(snapshot: SnapshotByKind[K], restoreName: boolean): Promise<void>;
};

type ActiveMultiplexer<K extends MultiplexerKind = MultiplexerKind> = {
	adapter: MultiplexerAdapter<K>;
	snapshot: SnapshotByKind[K];
	lastAppliedName?: string;
};

export type ConfigMigration = {
	value: unknown;
	changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateMultiplexerConfig(value: unknown): ConfigMigration {
	if (!isRecord(value) || !("tmux" in value)) return { value, changed: false };

	const next = { ...value };
	const legacyTmux = isRecord(value.tmux) ? value.tmux : undefined;
	const currentMultiplexer = isRecord(value.multiplexer) ? value.multiplexer : undefined;

	if (legacyTmux) {
		next.multiplexer = {
			...legacyTmux,
			...currentMultiplexer,
		};
	}
	delete next.tmux;

	return { value: next, changed: true };
}

export function detectMultiplexer(environment: MultiplexerEnvironment): MultiplexerDetection {
	if (environment.HERDR_ENV === "1") {
		const paneId = environment.HERDR_PANE_ID?.trim();
		return paneId ? { kind: "herdr", paneId } : { kind: "herdr-invalid" };
	}
	// herdr-core ("hc") exports HC_TERMINAL_ID into the programs it runs; it is the
	// successor of Herdr's pane model, so it sits between Herdr and tmux.
	const hcTerminalId = environment.HC_TERMINAL_ID?.trim();
	if (hcTerminalId) return { kind: "hc", terminalId: hcTerminalId };
	if (environment.HC_TERMINAL_SOCKET?.trim()) return { kind: "hc-invalid" };
	if (environment.TMUX) return { kind: "tmux" };
	return { kind: "none" };
}

export function cleanMultiplexerName(name: string, maxLength: number): string {
	const cleaned = name
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function buildMultiplexerName(config: MultiplexerConfig, context: MultiplexerNameContext): string {
	const project = path.basename(context.cwd) || "project";
	const session = (context.sessionName ?? context.sessionId.slice(0, 8)) || "session";
	const raw = config.template
		.replaceAll("{session}", session)
		.replaceAll("{project}", project)
		.replaceAll("{cwd}", context.cwd)
		.replaceAll("{id}", context.sessionId);
	return cleanMultiplexerName(raw, config.maxLength);
}

export const defaultCommandRunner: CommandRunner = async (command, args) => {
	const { stdout, stderr } = await execFileAsync(command, args, {
		encoding: "utf8",
		timeout: 1_000,
	});
	return { stdout: String(stdout), stderr: String(stderr) };
};

function requireOutput(output: CommandOutput, description: string): string {
	const value = output.stdout.trim();
	if (!value) throw new Error(`${description} returned empty output`);
	return value;
}

function commandError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseHerdrPane(output: CommandOutput, expectedPaneId: string): { paneId: string; label?: string } {
	let response: unknown;
	try {
		response = JSON.parse(output.stdout);
	} catch {
		throw new Error("Herdr pane get returned invalid JSON");
	}

	if (!isRecord(response) || !isRecord(response.result) || !isRecord(response.result.pane)) {
		throw new Error("Herdr pane get returned an unexpected response");
	}
	const pane = response.result.pane;
	if (pane.pane_id !== expectedPaneId) {
		throw new Error(`Herdr pane get returned ${String(pane.pane_id)} instead of ${expectedPaneId}`);
	}
	if (pane.label !== undefined && pane.label !== null && typeof pane.label !== "string") {
		throw new Error("Herdr pane get returned an invalid label");
	}
	return {
		paneId: expectedPaneId,
		label: typeof pane.label === "string" ? pane.label : undefined,
	};
}

function createHerdrAdapter(runner: CommandRunner, paneId: string, command: string): MultiplexerAdapter<"herdr"> {
	async function getPane() {
		return parseHerdrPane(await runner(command, ["pane", "get", paneId]), paneId);
	}

	return {
		kind: "herdr",
		async capture() {
			const pane = await getPane();
			return { paneId: pane.paneId, originalLabel: pane.label };
		},
		async apply(snapshot, name) {
			await runner(command, ["pane", "rename", snapshot.paneId, name]);
		},
		async readCurrent(snapshot) {
			return (await getPane()).label;
		},
		async restore(snapshot, restoreName) {
			if (!restoreName) return;
			await runner(
				command,
				snapshot.originalLabel === undefined
					? ["pane", "rename", snapshot.paneId, "--clear"]
					: ["pane", "rename", snapshot.paneId, snapshot.originalLabel],
			);
		},
	};
}

function parseHcTerminal(
	output: CommandOutput,
	expectedTerminalId: string,
): { terminalId: string; where?: string } {
	let response: unknown;
	try {
		response = JSON.parse(output.stdout);
	} catch {
		throw new Error("hc get returned invalid JSON");
	}

	if (!isRecord(response)) throw new Error("hc get returned an unexpected response");
	if (response.address !== expectedTerminalId) {
		throw new Error(`hc get returned ${String(response.address)} instead of ${expectedTerminalId}`);
	}
	const labels = response.labels;
	if (labels !== undefined && labels !== null && !isRecord(labels)) {
		throw new Error("hc get returned invalid labels");
	}
	const where = isRecord(labels) ? labels.where : undefined;
	if (where !== undefined && where !== null && typeof where !== "string") {
		throw new Error("hc get returned an invalid where label");
	}
	return {
		terminalId: expectedTerminalId,
		where: typeof where === "string" ? where : undefined,
	};
}

/**
 * herdr-core names are the free-form "where" label: `hc ls` prints it as the
 * terminal's place. There is no dedicated rename verb, so apply and restore
 * write that one label and leave the herdr.* labels alone.
 */
function createHcAdapter(
	runner: CommandRunner,
	terminalId: string,
	command: string,
): MultiplexerAdapter<"hc"> {
	async function getTerminal() {
		return parseHcTerminal(await runner(command, ["get", terminalId, "--json"]), terminalId);
	}

	return {
		kind: "hc",
		async capture() {
			const terminal = await getTerminal();
			return { terminalId: terminal.terminalId, originalWhere: terminal.where };
		},
		async apply(snapshot, name) {
			await runner(command, ["label", snapshot.terminalId, `where=${name}`]);
		},
		async readCurrent() {
			return (await getTerminal()).where;
		},
		async restore(snapshot, restoreName) {
			if (!restoreName) return;
			await runner(command, [
				"label",
				snapshot.terminalId,
				snapshot.originalWhere === undefined ? "where=" : `where=${snapshot.originalWhere}`,
			]);
		},
	};
}

function createTmuxAdapter(runner: CommandRunner): MultiplexerAdapter<"tmux"> {
	return {
		kind: "tmux",
		async capture() {
			const windowId = requireOutput(
				await runner("tmux", ["display-message", "-p", "#{window_id}"]),
				"tmux window id query",
			);
			const originalName = requireOutput(
				await runner("tmux", ["display-message", "-p", "-t", windowId, "#{window_name}"]),
				"tmux window name query",
			);
			const originalAutomaticRename = (
				await runner("tmux", ["show-window-options", "-v", "-t", windowId, "automatic-rename"])
			).stdout.trim();
			await runner("tmux", ["set-window-option", "-q", "-t", windowId, "automatic-rename", "off"]);
			return { windowId, originalName, originalAutomaticRename };
		},
		async apply(snapshot, name) {
			await runner("tmux", ["rename-window", "-t", snapshot.windowId, name]);
		},
		async readCurrent(snapshot) {
			return requireOutput(
				await runner("tmux", ["display-message", "-p", "-t", snapshot.windowId, "#{window_name}"]),
				"tmux window name query",
			);
		},
		async restore(snapshot, restoreName) {
			let firstError: unknown;
			if (restoreName) {
				try {
					await runner("tmux", ["rename-window", "-t", snapshot.windowId, snapshot.originalName]);
				} catch (error) {
					firstError = error;
				}
			}
			try {
				await runner(
					"tmux",
					snapshot.originalAutomaticRename
						? ["set-window-option", "-q", "-t", snapshot.windowId, "automatic-rename", snapshot.originalAutomaticRename]
						: ["set-window-option", "-q", "-u", "-t", snapshot.windowId, "automatic-rename"],
				);
			} catch (error) {
				firstError ??= error;
			}
			if (firstError) throw firstError;
		},
	};
}

export type MultiplexerManagerOptions = {
	environment?: MultiplexerEnvironment;
	runner?: CommandRunner;
};

export class MultiplexerManager {
	private readonly environment: MultiplexerEnvironment;
	private readonly runner: CommandRunner;
	private active?: ActiveMultiplexer;
	private operation: Promise<void> = Promise.resolve();
	private readonly warned = new Set<string>();

	constructor(options: MultiplexerManagerOptions = {}) {
		this.environment = options.environment ?? process.env;
		this.runner = options.runner ?? defaultCommandRunner;
	}

	sync(config: MultiplexerConfig, context: MultiplexerNameContext, hooks: MultiplexerHooks): Promise<void> {
		return this.enqueue(() => this.syncNow(config, context, hooks));
	}

	shutdown(config: MultiplexerConfig, reason: string, hooks: MultiplexerHooks): Promise<void> {
		return this.enqueue(async () => {
			if (reason === "reload" || config.restoreOnShutdown) {
				await this.release(true, hooks);
			} else {
				this.active = undefined;
			}
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.operation.then(operation, operation);
		this.operation = next.catch(() => undefined);
		return next;
	}

	private async syncNow(config: MultiplexerConfig, context: MultiplexerNameContext, hooks: MultiplexerHooks): Promise<void> {
		if (!config.enabled) {
			await this.release(true, hooks);
			return;
		}

		const detection = detectMultiplexer(this.environment);
		if (detection.kind === "herdr-invalid") {
			await this.release(true, hooks);
			this.warnOnce(
				"herdr-invalid",
				"Recap detected Herdr, but HERDR_PANE_ID is missing; outer multiplexers will not be modified.",
				hooks,
			);
			return;
		}
		if (detection.kind === "hc-invalid") {
			await this.release(true, hooks);
			this.warnOnce(
				"hc-invalid",
				"Recap detected herdr-core, but HC_TERMINAL_ID is missing; outer multiplexers will not be modified.",
				hooks,
			);
			return;
		}
		if (detection.kind === "none") {
			await this.release(true, hooks);
			return;
		}

		if (this.active && this.active.adapter.kind !== detection.kind) {
			await this.release(true, hooks);
		}

		if (!this.active) {
			const adapter = detection.kind === "herdr"
				? createHerdrAdapter(
					this.runner,
					detection.paneId,
					this.environment.HERDR_BIN_PATH?.trim() || "herdr",
				)
				: detection.kind === "hc"
					? createHcAdapter(
						this.runner,
						detection.terminalId,
						this.environment.HC_BIN_PATH?.trim() || "hc",
					)
					: createTmuxAdapter(this.runner);
			try {
				const snapshot = await adapter.capture();
				this.active = { adapter, snapshot } as ActiveMultiplexer;
			} catch (error) {
				this.warnOnce(
					`${detection.kind}:capture`,
					`Recap could not initialize ${detection.kind} name sync: ${commandError(error)}`,
					hooks,
				);
				return;
			}
		}

		const name = buildMultiplexerName(config, context);
		if (this.active.lastAppliedName === name) return;

		try {
			await this.applyActive(name);
			this.active.lastAppliedName = name;
			hooks.setTitle(name);
		} catch (error) {
			this.warnOnce(
				`${this.active.adapter.kind}:apply`,
				`Recap could not update ${this.active.adapter.kind} name: ${commandError(error)}`,
				hooks,
			);
		}
	}

	private async applyActive(name: string): Promise<void> {
		const active = this.active;
		if (!active) return;
		if (active.adapter.kind === "herdr") {
			await active.adapter.apply(active.snapshot as HerdrSnapshot, name);
			return;
		}
		if (active.adapter.kind === "hc") {
			await active.adapter.apply(active.snapshot as HcSnapshot, name);
			return;
		}
		await active.adapter.apply(active.snapshot as TmuxSnapshot, name);
	}

	private async release(restoreOwnedName: boolean, hooks: MultiplexerHooks): Promise<void> {
		const active = this.active;
		if (!active) return;
		this.active = undefined;

		let restoreName = false;
		if (restoreOwnedName && active.lastAppliedName !== undefined) {
			try {
				const current = active.adapter.kind === "herdr"
					? await active.adapter.readCurrent(active.snapshot as HerdrSnapshot)
					: active.adapter.kind === "hc"
						? await active.adapter.readCurrent(active.snapshot as HcSnapshot)
						: await active.adapter.readCurrent(active.snapshot as TmuxSnapshot);
				restoreName = current === active.lastAppliedName;
			} catch (error) {
				this.warnOnce(
					`${active.adapter.kind}:read-current`,
					`Recap could not verify the current ${active.adapter.kind} name before restore: ${commandError(error)}`,
					hooks,
				);
			}
		}

		try {
			if (active.adapter.kind === "herdr") {
				await active.adapter.restore(active.snapshot as HerdrSnapshot, restoreName);
			} else if (active.adapter.kind === "hc") {
				await active.adapter.restore(active.snapshot as HcSnapshot, restoreName);
			} else {
				await active.adapter.restore(active.snapshot as TmuxSnapshot, restoreName);
			}
		} catch (error) {
			this.warnOnce(
				`${active.adapter.kind}:restore`,
				`Recap could not restore ${active.adapter.kind} state: ${commandError(error)}`,
				hooks,
			);
		}
	}

	private warnOnce(key: string, message: string, hooks: MultiplexerHooks) {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		hooks.warn(message);
	}
}
