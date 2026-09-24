// Attachments are captured before any model call. HTTP image bytes must not change
// between validation and dispatch; CLI image paths remain weaker (see README).
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, extname } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
export const MAX_FILE_COUNT = 16;
export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface AttachedFile {
	path: string;
	name: string;
	text: string;
	truncated: boolean;
}

export interface PreparedImage {
	path: string;
	mime: string;
	data: string;
}

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp",
};

/** Check image extension; actual bytes are checked on read. */
export function isImagePath(path: string): boolean {
	return extname(path).toLowerCase() in IMAGE_MIME;
}

/** Get MIME type from extension, subject to subsequent magic-byte validation. */
export function imageMime(path: string): string | undefined {
	return IMAGE_MIME[extname(path).toLowerCase()];
}

/** Open a regular file without following a symlink or blocking on a FIFO. */
function openRegular(path: string, kind: string): number {
	if (!existsSync(path)) throw new Error(`${kind} not found: ${path}`);
	if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink, not a regular ${kind}`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(stat.isDirectory() ? `${path} is a directory, not a file` : `${path} is not a regular ${kind}`);
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}

/** Read at most `limit` bytes from already-checked descriptor. */
function readBounded(fd: number, limit: number): Buffer {
	const buf = Buffer.alloc(limit);
	let used = 0;
	while (used < limit) {
		const count = readSync(fd, buf, used, limit - used, used);
		if (!count) break;
		used += count;
	}
	return buf.subarray(0, used);
}

/** Capture UTF-8 text within one file's byte budget. */
export function readTextAttachment(path: string, budget = MAX_FILE_BYTES): AttachedFile {
	if (!Number.isSafeInteger(budget) || budget < 0) throw new Error(`invalid file budget: ${budget}`);
	const fd = openRegular(path, "file");
	let buf: Buffer;
	let truncated: boolean;
	try {
		const stat = fstatSync(fd);
		buf = readBounded(fd, Math.min(stat.size, budget + 1));
		truncated = stat.size > budget || buf.length > budget;
	} finally { closeSync(fd); }
	if (buf.subarray(0, budget).includes(0)) {
		const hint = isImagePath(path) ? " — use --image for images" : "";
		throw new Error(`${path} looks binary, not text${hint}`);
	}
	let text: string;
	try {
		// Streaming decode withholds an incomplete final code point at truncation.
		text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, budget), { stream: truncated });
	} catch { throw new Error(`${path} isn't valid UTF-8 text`); }
	return { path, name: basename(path), text, truncated };
}

/** Capture files with count, per-file and aggregate byte limits. */
export function readTextAttachments(paths: string[]): AttachedFile[] {
	if (paths.length > MAX_FILE_COUNT) throw new Error(`--file accepts at most ${MAX_FILE_COUNT} files`);
	let remaining = MAX_TOTAL_BYTES;
	return paths.map((path) => {
		const file = readTextAttachment(path, Math.min(MAX_FILE_BYTES, remaining));
		remaining -= Buffer.byteLength(file.text);
		return file;
	});
}

/** Label each file while bounding header size and preventing newline spoofing. */
export function buildFileContext(files: AttachedFile[]): string {
	if (files.length > MAX_FILE_COUNT) throw new Error(`--file accepts at most ${MAX_FILE_COUNT} files`);
	return files.map((file) => {
		const label = file.name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100);
		const note = file.truncated ? ` (truncated — first ${MAX_FILE_BYTES / 1024}KB at most)` : "";
		const ticks = Math.max(0, ...(file.text.match(/`+/g) ?? []).map((run) => run.length));
		const tildes = Math.max(0, ...(file.text.match(/~+/g) ?? []).map((run) => run.length));
		const marker = ticks <= tildes ? "`" : "~";
		const fence = marker.repeat(Math.min(64, Math.max(3, Math.min(ticks, tildes) + 1)));
		return `=== ${label}${note} ===\n${fence}\n${file.text}\n${fence}`;
	}).join("\n\n");
}

/** Validate image bytes against extension before any call; freeze base64 for HTTP. */
export function validateImages(paths: string[]): PreparedImage[] {
	if (paths.length > MAX_IMAGE_COUNT) throw new Error(`--image accepts at most ${MAX_IMAGE_COUNT} images`);
	let total = 0;
	return paths.map((path) => {
		const mime = imageMime(path);
		if (!mime) throw new Error(`${path} isn't a supported image (png, jpg, gif, webp)`);
		const fd = openRegular(path, "image file");
		let buf: Buffer;
		try {
			const size = fstatSync(fd).size;
			if (size > MAX_IMAGE_BYTES) throw new Error(`${path} exceeds ${MAX_IMAGE_BYTES} image bytes`);
			total += size;
			if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error(`images exceed ${MAX_TOTAL_IMAGE_BYTES} bytes combined`);
			buf = readBounded(fd, size);
			if (buf.length !== size) throw new Error(`${path} changed while reading`);
		} finally { closeSync(fd); }
		if (!hasImageSignature(buf, mime)) {
			throw new Error(`${path} has invalid ${mime} signature`);
		}
		return Object.freeze({ path, mime, data: buf.toString("base64") });
	});
}

/** Capture one image; caller gets exact validated bytes, never a later reread. */
export function readImageBase64(path: string): PreparedImage {
	return validateImages([path])[0];
}

/** Check decoded bytes, without rereading paths that may have changed since capture. */
function hasImageSignature(buf: Buffer, mime: string): boolean {
	if (mime === "image/png") return buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mime === "image/jpeg") return buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
	if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"));
	if (mime === "image/webp") return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
	return false;
}

/** Check ordered payload shape and bytes; callers remain responsible for file provenance. */
export function preparedImagesError(paths?: string[], prepared?: PreparedImage[]): string | undefined {
	const error = "Images must be validated and frozen before an HTTP call";
	if (!paths?.length && !prepared?.length) return undefined;
	if (!paths?.length || !prepared || paths.length !== prepared.length || paths.length > MAX_IMAGE_COUNT) return error;
	let total = 0;
	for (let i = 0; i < paths.length; i++) {
		const image = prepared[i];
		if (!image || image.path !== paths[i] || image.mime !== imageMime(paths[i]) ||
			typeof image.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) return error;
		const bytes = Buffer.from(image.data, "base64");
		total += bytes.length;
		if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES || !hasImageSignature(bytes, image.mime)) return error;
	}
	return undefined;
}
