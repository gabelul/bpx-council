import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { configPath } from "./config.js";

/**
 * Compare config parent directories, including home aliases.
 * @param path Directory path to identify.
 * @returns Canonical path, or absolute lexical path when inaccessible.
 */
function directoryIdentity(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Detect a project destination that would replace the global settings file.
 * File symlinks are not followed: the atomic writer replaces those entries.
 * @param path Proposed inferred project config destination.
 * @returns True when destination is the global config, including home aliases.
 */
export function projectTargetIsGlobal(path: string): boolean {
	const target = resolve(path);
	const global = resolve(configPath());
	return basename(target) === basename(global)
		&& directoryIdentity(dirname(target)) === directoryIdentity(dirname(global));
}
