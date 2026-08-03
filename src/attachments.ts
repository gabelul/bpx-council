/**
 * attachments — files and images handed to the advisor alongside the question.
 *
 * Two very different jobs behind one idea. A text file is universal: we read it
 * and fold it into the prompt, so every backend supports it without knowing.
 * An image can't be folded into text — it needs the backend to actually accept
 * one, which only some do, so those go through the registry instead.
 *
 * Everything here validates loudly. A file that silently doesn't reach the model
 * is the worst outcome: you get a confident answer about something the model
 * never saw.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/** Per-file ceiling. Past this a single file would crowd out the question itself. */
export const MAX_FILE_BYTES = 256 * 1024;
/** Ceiling across all files, so `--file` ten times doesn't blow the context. */
export const MAX_TOTAL_BYTES = 512 * 1024;

export interface AttachedFile {
	path: string;
	name: string;
	text: string;
	truncated: boolean;
}

/** Extensions we'll treat as images, mapped to the mime type HTTP backends need. */
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Is this path an image, by extension? */
export function isImagePath(path: string): boolean {
	return extname(path).toLowerCase() in IMAGE_MIME;
}

/** The mime type for an image path, or undefined when it isn't a known image. */
export function imageMime(path: string): string | undefined {
	return IMAGE_MIME[extname(path).toLowerCase()];
}

/**
 * Read one text file for inclusion in the prompt.
 *
 * Throws with a plain-language reason rather than returning something empty —
 * a missing or unreadable file should stop the run, not quietly shrink it.
 */
export function readTextAttachment(path: string, budget = MAX_FILE_BYTES): AttachedFile {
	if (!existsSync(path)) throw new Error(`file not found: ${path}`);
	const stat = statSync(path);
	if (stat.isDirectory()) throw new Error(`${path} is a directory, not a file`);

	const buf = readFileSync(path);
	// A NUL byte means this isn't text. Images get their own flag, and anything
	// else would arrive as mojibake the model would try to interpret anyway.
	if (buf.includes(0)) {
		const hint = isImagePath(path) ? " — use --image for images" : "";
		throw new Error(`${path} looks binary, not text${hint}`);
	}

	const truncated = buf.length > budget;
	const text = (truncated ? buf.subarray(0, budget) : buf).toString("utf-8");
	return { path, name: basename(path), text, truncated };
}

/**
 * Read every `--file`, enforcing the shared budget.
 *
 * The budget shrinks as files are read so the total stays bounded no matter how
 * many are passed; each file reports its own truncation so the prompt can say so.
 */
export function readTextAttachments(paths: string[]): AttachedFile[] {
	let remaining = MAX_TOTAL_BYTES;
	return paths.map((p) => {
		const file = readTextAttachment(p, Math.max(1, Math.min(MAX_FILE_BYTES, remaining)));
		remaining -= Buffer.byteLength(file.text);
		return file;
	});
}

/**
 * Render attached files as a context block.
 *
 * Fenced and labelled by name so the model can tell where one file ends and the
 * next begins, and told plainly when one was cut short — otherwise it may reason
 * about a function whose ending it never saw. The fence widens if the file itself
 * contains a triple backtick, so markdown attachments don't break out.
 *
 * Returns "" for no files, so callers can join it with piped stdin unconditionally.
 */
export function buildFileContext(files: AttachedFile[]): string {
	if (files.length === 0) return "";
	return files
		.map((f) => {
			const note = f.truncated ? ` (truncated — first ${MAX_FILE_BYTES / 1024}KB only)` : "";
			const fence = f.text.includes("```") ? "````" : "```";
			return `=== ${f.name}${note} ===\n${fence}\n${f.text}\n${fence}`;
		})
		.join("\n\n");
}

/** Validate image paths up front, so a bad one fails before we spend a model call. */
export function validateImages(paths: string[]): void {
	for (const p of paths) {
		if (!existsSync(p)) throw new Error(`image not found: ${p}`);
		if (statSync(p).isDirectory()) throw new Error(`${p} is a directory, not an image`);
		if (!imageMime(p)) {
			throw new Error(`${p} isn't a supported image (png, jpg, gif, webp)`);
		}
	}
}

/** Read an image as a base64 data payload, for HTTP backends that take one. */
export function readImageBase64(path: string): { mime: string; data: string } {
	const mime = imageMime(path);
	if (!mime) throw new Error(`${path} isn't a supported image (png, jpg, gif, webp)`);
	return { mime, data: readFileSync(path).toString("base64") };
}
