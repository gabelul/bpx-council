import { getSdkProviderService } from "./sdk-provider-service.js";

/** Run inference under one SIGINT gate, draining owned work and output before removing handler.
 * @param run Work awaiting every started transport. @param settle SDK storage/refresh barrier, injectable for offline tests.
 * @param publish Optional result publisher; awaited with SIGINT gate still active.
 * @returns Completed work and interruption status. Throws only after storage drain.
 */
export async function runInvocation<T>(run: (signal: AbortSignal) => Promise<T>, settle: () => Promise<void> = () => getSdkProviderService().settle(), publish?: (value: T, cancelled: boolean) => Promise<void>): Promise<{ value: T; cancelled: boolean }> {
	const abort = new AbortController();
	/** Cancel once; repeated interrupts cannot skip storage or output drain. */
	const interrupt = (): void => { abort.abort(); };
	process.on("SIGINT", interrupt);
	try {
		let value: T;
		try { value = await run(abort.signal); }
		finally {
			try { await settle(); }
			catch { throw new Error("SDK shutdown could not be confirmed"); }
		}
		await publish?.(value, abort.signal.aborted);
		return { value, cancelled: abort.signal.aborted };
	} finally {
		if (abort.signal.aborted) process.exitCode = 130;
		process.removeListener("SIGINT", interrupt);
	}
}

/** Flush stdout/stderr under invocation gate so slow pipes retain complete receipts.
 * @returns Completion after all queued stream writes finish. Rejects on closed pipes.
 */
export async function flushInvocationOutput(): Promise<void> {
	await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>((resolve, reject) => {
		stream.write("", error => error ? reject(error) : resolve());
	})));
}
