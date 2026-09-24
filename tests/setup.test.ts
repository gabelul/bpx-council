import { afterEach, describe, expect, it, vi } from "vitest";

const { config, install } = vi.hoisted(() => ({ config: vi.fn(async () => 0), install: vi.fn(async () => 0) }));
vi.mock("../src/config-wizard.js", () => ({ runConfig: config }));
vi.mock("../src/install.js", () => ({ runInstall: install }));
import { runSetup } from "../src/setup.js";

const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
	config.mockClear();
	install.mockClear();
	if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
	else Reflect.deleteProperty(process.stdin, "isTTY");
});

describe("setup dry run", () => {
	it("never offers installer when stdin is interactive", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		expect(await runSetup({ dryRun: true })).toBe(0);
		expect(config).toHaveBeenCalledWith({ dryRun: true });
		expect(install).not.toHaveBeenCalled();
	});
});
