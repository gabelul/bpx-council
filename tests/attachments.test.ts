/**
 * attachment tests.
 *
 * The failure that matters here is silent: a file that doesn't reach the model
 * still gets a confident answer. So these pin the refusals (missing, directory,
 * binary, unsupported image type) as hard as they pin the happy path, plus the
 * fencing rules that keep a markdown file from breaking out of its own block.
 */

import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { callHttpAdvisor } from "../src/http-backend.js";
import {
	buildFileContext,
	imageMime,
	isImagePath,
	MAX_FILE_BYTES,
	MAX_FILE_COUNT,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_COUNT,
	readImageBase64,
	readTextAttachment,
	readTextAttachments,
	validateImages,
} from "../src/attachments.js";

const dir = mkdtempSync(join(tmpdir(), "bpx-attach-"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
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

	it("reads only budget plus one byte, dropping incomplete UTF-8 on truncation", () => {
		const p = write("unicode.txt", Buffer.concat([Buffer.from("ab€"), Buffer.alloc(1024 * 1024, 0x78)]));
		const f = readTextAttachment(p, 4);
		expect(f.text).toBe("ab");
		expect(f.truncated).toBe(true);
	});

	it("rejects malformed UTF-8 rather than expanding it beyond the shared byte budget", () => {
		const p = write("invalid.txt", Buffer.from([0xff, 0xff, 0xff]));
		expect(() => readTextAttachment(p, 3)).toThrow(/UTF-8/);
	});

	it("refuses text symlinks", () => {
		const p = write("target.txt", "target");
		const link = join(dir, "text-link.txt");
		symlinkSync(p, link);
		expect(() => readTextAttachment(link)).toThrow(/symlink/);
	});

	it("refuses nonregular paths without blocking on devices", () => {
		if (existsSync("/dev/null")) expect(() => readTextAttachment("/dev/null")).toThrow(/regular file/);
	});
});

describe("readTextAttachments", () => {
	it("caps file count and sanitizes bounded headers", () => {
		const p = write("normal.txt", "yes");
		expect(() => readTextAttachments(Array(MAX_FILE_COUNT + 1).fill(p))).toThrow(/at most/);
		const output = buildFileContext([{ path: p, name: "fake\n=== injected ===", text: "yes", truncated: false }]);
		expect(output).not.toContain("\n=== injected");
	});

	it("reads several files in order", () => {
		const files = readTextAttachments([write("one.ts", "1"), write("two.ts", "2")]);
		expect(files.map((f) => f.name)).toEqual(["one.ts", "two.ts"]);
	});

	it("enforces exact shared byte budget across several files", () => {
		const files = readTextAttachments([
			write("large-a.txt", "a".repeat(MAX_FILE_BYTES + 10)),
			write("large-b.txt", "b".repeat(MAX_FILE_BYTES + 10)),
			write("large-c.txt", "c"),
		]);
		expect(files.map((f) => Buffer.byteLength(f.text))).toEqual([MAX_FILE_BYTES, MAX_FILE_BYTES, 0]);
		expect(files.every((f) => f.truncated)).toBe(true);
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
		expect(out).toMatch(/\n(?:````|~~~)\n/);
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

	it("rejects symlinks, oversized images, forged headers, and excess count", () => {
		const p = write("safe.png", PNG);
		const link = join(dir, "linked.png");
		symlinkSync(p, link);
		expect(() => validateImages([link])).toThrow(/symlink/);
		expect(() => validateImages([write("fake.png", "not a PNG")])).toThrow(/signature/);
		expect(() => validateImages([write("huge.png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))])).toThrow(/exceeds/);
		expect(() => validateImages(Array(MAX_IMAGE_COUNT + 1).fill(p))).toThrow(/at most/);
	});

	it("freezes bytes for later HTTP calls despite path changes", () => {
		const p = write("frozen.png", PNG);
		const [prepared] = validateImages([p]);
		writeFileSync(p, Buffer.concat([PNG, Buffer.from("different")]));
		expect(Buffer.from(prepared.data, "base64")).toEqual(PNG);
	});

	it("HTTP sends frozen image bytes after file changes", async () => {
		const path = write("http-frozen.png", PNG);
		const imageData = validateImages([path]);
		writeFileSync(path, "replaced");
		const key = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-only";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "answer" }] }), { status: 200 }));
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider: "anthropic", model: "test", images: [path], imageData });
			expect(result.text).toBe("answer");
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(Buffer.from(request.messages[0].content[0].source.data, "base64")).toEqual(PNG);
		} finally {
			fetchMock.mockRestore();
			if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = key;
		}
	});

	it.each([
		{ name: "swapped paths", images: ["first.png", "second.png"], mutate: (data: ReturnType<typeof validateImages>) => [data[1], data[0]] },
		{ name: "wrong MIME", images: ["first.png"], mutate: (data: ReturnType<typeof validateImages>) => [{ ...data[0], mime: "image/jpeg" }] },
		{ name: "forged bytes", images: ["first.png"], mutate: (data: ReturnType<typeof validateImages>) => [{ ...data[0], data: Buffer.from("fake").toString("base64") }] },
		{ name: "extra payload", images: ["first.png"], mutate: (data: ReturnType<typeof validateImages>) => [...data, data[0]] },
	])("refuses HTTP $name without fetching", async ({ images, mutate }) => {
		const paths = images.map((name, i) => write(`${i}-${name}`, PNG));
		const imageData = mutate(validateImages(paths));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP call"));
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider: "anthropic", images: paths, imageData });
			expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Images must be validated and frozen") });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally { fetchMock.mockRestore(); }
	});

	it("reads an image as base64 with its mime type", () => {
		const p = write("dot.png", PNG);
		const { mime, data } = readImageBase64(p);
		expect(mime).toBe("image/png");
		expect(Buffer.from(data, "base64")).toEqual(PNG);
	});
});
