import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKeyLoop } from "../src/interactive.js";
import { runFilterSelect, runInput, runSelect } from "../src/select.js";

let originalRaw: PropertyDescriptor | undefined;
let originalIsRaw: PropertyDescriptor | undefined;
let raw: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	originalRaw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	raw = vi.fn();
	Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: raw });
	Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: false });
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalRaw) Object.defineProperty(process.stdin, "setRawMode", originalRaw);
	else delete (process.stdin as unknown as Record<string, unknown>).setRawMode;
	if (originalIsRaw) Object.defineProperty(process.stdin, "isRaw", originalIsRaw);
	else delete (process.stdin as unknown as Record<string, unknown>).isRaw;
});

/** Feed one named raw key to current picker. @param name Key name. @param text Optional typed character. */
function key(name: string, text?: string) { process.stdin.emit("keypress", text, { name }); }

/** Assert driver restored raw state and cursor. @returns Nothing. */
function restored() {
	expect(raw.mock.calls.at(-1)).toEqual([false]);
	expect(write.mock.calls.flat().join("")).toContain("\x1b[?25h");
}

describe("raw settings primitives", () => {
	it("nullable input Esc cancels; legacy Esc keeps default", async () => {
		const editor = runInput("Model", "stored", { cancel: true, rail: true });
		key("escape");
		expect(await editor).toBeNull();
		restored();
		const legacy = runInput("Model", "stored");
		key("escape");
		expect(await legacy).toBe("stored");
		restored();
	});

	it("nullable input empty Enter keeps current value; typed text is accepted", async () => {
		const kept = runInput("Model", "stored", { cancel: true });
		key("return");
		expect(await kept).toBe("stored");
		const edited = runInput("Model", "stored", { cancel: true });
		key("n", "n"); key("e", "e"); key("w", "w"); key("return");
		expect(await edited).toBe("new");
		restored();
	});

	it("filter preselects current choice and Escape returns null", async () => {
		const selected = runFilterSelect("Models", ["first", "stored", "last"], { initial: 1, cancelLabel: "cancel" });
		key("return");
		expect(await selected).toBe("stored");
		const cancelled = runFilterSelect("Models", ["first", "stored"], { initial: 1 });
		key("escape");
		expect(await cancelled).toBeNull();
		restored();
	});

	it("select Escape removes listener and restores terminal", async () => {
		const listeners = process.stdin.listenerCount("keypress");
		const picked = runSelect("Choose", [{ label: "Current", value: "current" }]);
		key("escape");
		expect(await picked).toBeNull();
		expect(process.stdin.listenerCount("keypress")).toBe(listeners);
		restored();
	});

	it("render failure restores terminal and rejects", async () => {
		const listeners = process.stdin.listenerCount("keypress");
		await expect(runKeyLoop(() => { throw new Error("render failed"); }, () => {})).rejects.toThrow("render failed");
		expect(process.stdin.listenerCount("keypress")).toBe(listeners);
		restored();
	});

	it("handler failure restores terminal and rejects", async () => {
		const picked = runKeyLoop(() => "Picker\n", () => { throw new Error("handler failed"); });
		key("return");
		await expect(picked).rejects.toThrow("handler failed");
		restored();
	});

	it("restores existing raw mode, not always cooked mode", async () => {
		Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
		const picked = runSelect("Choose", [{ label: "Current", value: "current" }]);
		key("escape");
		await picked;
		expect(raw.mock.calls).toEqual([[true], [true]]);
	});

	it("Ctrl-C restores terminal before exit 130", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
		runSelect("Choose", [{ label: "Current", value: "current" }]);
		expect(() => process.stdin.emit("keypress", "\x03", { name: "c", ctrl: true })).toThrow("exit");
		expect(exit).toHaveBeenCalledWith(130);
		restored();
	});
});
