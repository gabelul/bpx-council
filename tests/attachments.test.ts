/**
 * attachment tests.
 *
 * The failure that matters here is silent: a file that doesn't reach the model
 * still gets a confident answer. So these pin the refusals (missing, directory,
 * binary, unsupported image type) as hard as they pin the happy path, plus the
 * fencing rules that keep a markdown file from breaking out of its own block.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildFileContext,
	imageMime,
	isImagePath,
	MAX_FILE_BYTES,
	readImageBase64,
	readTextAttachment,
	readTextAttachments,
	validateImages,
} from "../src/attachments.js";

const dir = mkdtempSync(join(tmpdir(), "bpx-attach-"));
const write = (name: string, body: string | Buffer) => {
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
};

describe("readTextAttachment", () => {
	it("reads a text file and keeps its basename", () => {
		const f = readTextAttachment(write("hello.ts", "export const x = 1;\n"));
		expect(f.name).toBe("hello.ts");
		expect(f.text).toContain("export const x = 1;");
		expect(f.truncated).toBe(false);
	});

	it("refuses a missing file", () => {
		expect(() => readTextAttachment(join(dir, "nope.ts"))).toThrow(/not found/);
	});

	it("refuses a directory", () => {
		const sub = join(dir, "subdir");
		mkdirSync(sub, { recursive: true });
		expect(() => readTextAttachment(sub)).toThrow(/directory/);
	});

	it("refuses binary content, pointing at --image when it looks like one", () => {
		const png = write("shot.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
		expect(() => readTextAttachment(png)).toThrow(/--image/);
		const bin = write("blob.dat", Buffer.from([0x41, 0x00, 0x42]));
		expect(() => readTextAttachment(bin)).toThrow(/binary/);
	});

	it("truncates past the budget and says so", () => {
		const f = readTextAttachment(write("big.txt", "x".repeat(100)), 10);
		expect(f.text).toHaveLength(10);
		expect(f.truncated).toBe(true);
	});
});

describe("readTextAttachments", () => {
	it("reads several files in order", () => {
		const files = readTextAttachments([write("one.ts", "1"), write("two.ts", "2")]);
		expect(files.map((f) => f.name)).toEqual(["one.ts", "two.ts"]);
	});
});

describe("buildFileContext", () => {
	it("returns nothing for no files, so it can be joined unconditionally", () => {
		expect(buildFileContext([])).toBe("");
	});

	it("labels each file and fences its contents", () => {
		const out = buildFileContext(readTextAttachments([write("auth.ts", "const a = 1;")]));
		expect(out).toContain("=== auth.ts ===");
		expect(out).toContain("```");
		expect(out).toContain("const a = 1;");
	});

	it("widens the fence when the file itself contains a triple backtick", () => {
		const out = buildFileContext(readTextAttachments([write("doc.md", "```js\ncode\n```")]));
		// A 3-backtick fence would let the file break out of its own block.
		expect(out).toContain("````");
	});

	it("marks a truncated file in the block header", () => {
		const out = buildFileContext([{ path: "p", name: "big.txt", text: "x", truncated: true }]);
		expect(out).toContain("truncated");
		expect(out).toContain(`${MAX_FILE_BYTES / 1024}KB`);
	});
});

describe("images", () => {
	it("recognises supported image extensions, case-insensitively", () => {
		expect(isImagePath("a.PNG")).toBe(true);
		expect(imageMime("a.jpg")).toBe("image/jpeg");
		expect(imageMime("a.txt")).toBeUndefined();
	});

	it("refuses a missing image and a non-image extension", () => {
		expect(() => validateImages([join(dir, "gone.png")])).toThrow(/not found/);
		expect(() => validateImages([write("notes.txt", "hi")])).toThrow(/supported image/);
	});

	it("reads an image as base64 with its mime type", () => {
		const p = write("dot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const { mime, data } = readImageBase64(p);
		expect(mime).toBe("image/png");
		expect(Buffer.from(data, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});
});
