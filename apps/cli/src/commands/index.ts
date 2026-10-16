import type { Command } from "commander";
import type { Runtime } from "../runtime.ts";
import { registerGet } from "./get.ts";
import { registerLink } from "./link.ts";
import { registerPut } from "./put.ts";

/** Wraps a command body so it receives the runtime and sets the exit code. */
export type Wrap = (
	body: (runtime: Runtime, ...args: unknown[]) => Promise<number | void>,
) => (...args: unknown[]) => Promise<void>;

export type Register = (program: Command, wrap: Wrap) => void;

/** Every kumo command, in help order. */
export const commands: Register[] = [registerPut, registerGet, registerLink];
