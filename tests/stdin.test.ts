import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_STDIN_BYTES, readStdin } from "../src/stdin.js";

describe("piped stdin", () => {
	it("waits for EOF after slow chunks instead of resolving at 200ms", async () => {
		const input = new PassThrough();
		const result = readStdin(input, 1000);
		input.write("first ");
		setTimeout(() => input.end("second"), 300);
		expect(await result).toBe("first second");
	});

	it("rejects oversized context before sending it", async () => {
		const input = new PassThrough();
		const result = readStdin(input, 1000);
		input.end("x".repeat(MAX_STDIN_BYTES + 1));
		await expect(result).rejects.toThrow(/stdin exceeds/);
	});

	it("refuses partial context from a pipe that never ends", async () => {
		const input = new PassThrough();
		const result = readStdin(input, 50);
		input.write("partial");
		await expect(result).rejects.toThrow(/refusing incomplete context/);
		input.destroy();
	});

	it("rejects an open pipe with no data instead of silently omitting context", async () => {
		const input = new PassThrough();
		await expect(readStdin(input, 50)).rejects.toThrow(/--no-stdin/);
		input.destroy();
	});

	it("preserves multibyte characters across chunks", async () => {
		const input = new PassThrough();
		const result = readStdin(input, 1000);
		const utf8 = Buffer.from("€");
		input.write(utf8.subarray(0, 1));
		input.end(utf8.subarray(1));
		expect(await result).toBe("€");
	});
});
