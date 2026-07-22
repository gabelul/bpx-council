/**
 * update-check tests.
 *
 * The network/cache/notify plumbing is best-effort and swallows everything, so
 * the thing actually worth pinning down is the version comparison — get that
 * wrong and you either nag people who are current or stay silent when they're
 * behind. readPackageMeta is tested against the real package.json so a rename
 * of the field can't silently break --version.
 */

import { describe, expect, it } from "vitest";
import { isNewer, readPackageMeta } from "../src/update-check.js";

describe("isNewer", () => {
	it("detects a higher patch, minor, or major", () => {
		expect(isNewer("1.2.1", "1.2.0")).toBe(true);
		expect(isNewer("1.3.0", "1.2.9")).toBe(true);
		expect(isNewer("2.0.0", "1.9.9")).toBe(true);
	});

	it("is false for equal or older", () => {
		expect(isNewer("1.2.0", "1.2.0")).toBe(false);
		expect(isNewer("1.1.9", "1.2.0")).toBe(false);
		expect(isNewer("0.9.0", "1.0.0")).toBe(false);
	});

	it("ignores pre-release/build suffixes rather than tripping on them", () => {
		// A notice doesn't need exact semver — just don't crash or misfire on 1.2.0-rc.1.
		expect(isNewer("1.3.0-rc.1", "1.2.0")).toBe(true);
		expect(isNewer("1.2.0-rc.1", "1.2.0")).toBe(false);
	});

	it("treats missing or junk segments as zero, never NaN", () => {
		expect(isNewer("2", "1.9.9")).toBe(true);
		expect(isNewer("1.2", "1.2.0")).toBe(false);
		expect(isNewer("", "1.0.0")).toBe(false);
	});
});

describe("readPackageMeta", () => {
	it("reads name and version from the real package.json", () => {
		const meta = readPackageMeta();
		expect(meta.name).toBe("@booplex/bpx-council");
		expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
	});
});
