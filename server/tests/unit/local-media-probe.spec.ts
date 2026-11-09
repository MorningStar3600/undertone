import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLocalAudio } from "../../music/local-media-files.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const setup = () => {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		kill: vi.fn(),
	});
	vi.mocked(spawn).mockReturnValue(child as never);
	const handle = { read: async () => ({ bytesRead: 0 }) } as unknown as FileHandle;
	return { child, work: probeLocalAudio(handle) };
};
describe("bounded private audio metadata probing", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});
	it("kills a stalled probe at its deadline and returns safe unknown metadata", async () => {
		vi.useFakeTimers();
		const { child, work } = setup();
		await vi.advanceTimersByTimeAsync(2001);
		expect(await work).toEqual({ title: "Untitled track", artists: [], duration: null });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(child.stdin.destroyed).toBe(true);
	});
	it("caps probe output and strips filesystem-looking metadata", async () => {
		const first = setup();
		first.child.stdout.write(Buffer.alloc(65537, 65));
		expect(await first.work).toEqual({ title: "Untitled track", artists: [], duration: null });
		const second = setup();
		second.child.stdout.write(
			JSON.stringify({
				format: {
					duration: "180.5",
					tags: { title: "C:\\private\\song.mp3", artist: "/private/artist" },
				},
			}),
		);
		second.child.emit("close", 0);
		expect(await second.work).toEqual({
			title: "Untitled track",
			artists: [],
			duration: 180.5,
		});
	});
	it("keeps bounded ordinary metadata without inventing a title from the file name", async () => {
		const { child, work } = setup();
		child.stdout.write(
			JSON.stringify({
				format: { duration: "120", tags: { title: "A recording", artist: "An artist" } },
			}),
		);
		child.emit("close", 0);
		expect(await work).toEqual({ title: "A recording", artists: ["An artist"], duration: 120 });
	});
});
