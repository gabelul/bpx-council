import type { Readable } from "node:stream";

export const MAX_STDIN_BYTES = 1024 * 1024;
export const STDIN_DEADLINE_MS = 3000;

/** Collect complete piped context, or fail instead of sending a partial prompt. */
export function readStdin(stream: Readable = process.stdin, deadlineMs = STDIN_DEADLINE_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let bytes = 0;
		let done = false;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("error", onError);
			if (error) reject(error);
			else resolve(data.trim());
		};
		const onData = (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_STDIN_BYTES) return finish(new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`));
			data += chunk;
		};
		const onEnd = () => finish();
		const onError = (e: Error) => finish(e);
		const timer = setTimeout(() => finish(new Error(`stdin did not end within ${deadlineMs}ms; refusing incomplete context (use --no-stdin if the pipe stays open)`)), deadlineMs);
		stream.setEncoding("utf-8");
		stream.on("data", onData);
		stream.once("end", onEnd);
		stream.once("error", onError);
		if (stream.readableEnded) finish();
	});
}
