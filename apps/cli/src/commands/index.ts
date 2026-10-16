import type { Command } from "commander";
import type { Runtime } from "../runtime.ts";

/** Wraps a command body so it receives the runtime and sets the exit code. */
export type Wrap = (
	body: (runtime: Runtime, ...args: unknown[]) => Promise<number | void>,
) => (...args: unknown[]) => Promise<void>;

export type Register = (program: Command, wrap: Wrap) => void;

/** Every kumo command, in help order. */
export const commands: Register[] = [];
