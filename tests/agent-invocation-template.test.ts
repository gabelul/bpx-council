import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Read the shipped host instructions, not an independently invented command.
 * @param path Template relative to the templates directory. @returns Exact template prose.
 */
function template(path: string): string {
	return readFileSync(new URL(`../templates/${path}`, import.meta.url), "utf8");
}

const paths = ["skills/bpx-council/SKILL.md", "claude-code/commands/council.md"];

describe("host advisory invocation instructions", () => {
	it.each(paths)("%s explicitly selects solo, JSON and no inherited stdin", path => {
		expect(template(path)).toContain("bpx-council --mode solo --format json --no-stdin --question");
	});
	it.each(paths)("%s treats questions as data, never an interpolated shell command", path => {
		const text = template(path);
		expect(text).not.toMatch(/bpx-council[^\n]*\$ARGUMENTS/);
		expect(text).toMatch(/argv array|safe argv/);
	});
	it.each(paths)("%s waits for background output and preserves failed/partial outcomes", path => {
		const text = template(path);
		expect(text).toContain("background task ID");
		expect(text).toContain("partial");
		expect(text).toContain("failed");
		expect(text).toMatch(/duplicate (paid )?call/);
	});
});
