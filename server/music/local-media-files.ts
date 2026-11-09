import { constants, type Stats } from "node:fs";
import { Readable } from "node:stream";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffprobe from "@ffprobe-installer/ffprobe";
import { OttException } from "ott-common/exceptions.js";

export class LocalMediaException extends OttException {
	name = "LocalMediaException";
	constructor(public status = 404) {
		super("Local media is not available.");
	}
}
export const AUDIO_MIMES: Readonly<Record<string, string>> = {
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
};
const UNSAFE_PATH = /[\0%:]/;
const PATH_SEPARATORS = /[\\/]/;
const WINDOWS_ALIAS = /[. ]$/;
const UNSAFE_TAG = /[\p{Cc}\p{Cf}\\/]/u;
export function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative !== "" &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}
export function safeRelative(value: string): boolean {
	// Percent names are deliberately excluded: no encoded traversal aliases or double decoding.
	return (
		!!value &&
		value.length <= 2048 &&
		!UNSAFE_PATH.test(value) &&
		!path.isAbsolute(value) &&
		!value
			.split(PATH_SEPARATORS)
			.some(part => !part || part === "." || part === ".." || WINDOWS_ALIAS.test(part))
	);
}
async function checkedPath(root: string, relative: string): Promise<string> {
	if (!safeRelative(relative)) {
		throw new LocalMediaException();
	}
	const canonicalRoot = await realpath(root);
	// Root itself must not be a symlink/junction, nor may any child component be one.
	if ((await lstat(root)).isSymbolicLink() || path.resolve(root) !== canonicalRoot) {
		throw new LocalMediaException();
	}
	let target = canonicalRoot;
	for (const part of relative.split(path.sep)) {
		target = path.join(target, part);
		if ((await lstat(target)).isSymbolicLink()) {
			throw new LocalMediaException();
		}
	}
	const canonical = await realpath(target);
	if (!contained(canonicalRoot, canonical) || canonical !== target) {
		throw new LocalMediaException();
	}
	return canonical;
}
export function sameFile(
	a: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">,
	b: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">,
): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
/** Serve/probe only the opened descriptor, never reopen the pathname for streaming.
 * fstat must match the validated path on both sides of open and the persisted identity.
 * Node has no portable openat2; operator roots must not have hostile concurrent writers. */
export async function openLocalFile(
	root: string,
	relative: string,
): Promise<{ handle: FileHandle; info: Stats }> {
	let handle: FileHandle | undefined;
	try {
		const target = await checkedPath(root, relative);
		const before = await stat(target);
		if (
			!before.isFile() ||
			!before.ino ||
			before.nlink !== 1 ||
			!Number.isSafeInteger(before.size)
		) {
			throw new LocalMediaException();
		}
		handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const info = await handle.stat();
		const after = await stat(await checkedPath(root, relative));
		if (!info.isFile() || !sameFile(info, before) || !sameFile(info, after)) {
			throw new LocalMediaException();
		}
		return { handle, info };
	} catch {
		await handle?.close();
		throw new LocalMediaException();
	}
}

export interface LocalAudioMetadata {
	title: string;
	artists: string[];
	duration: number | null;
}
export const unknownMetadata = (): LocalAudioMetadata => ({
	title: "Untitled track",
	artists: [],
	duration: null,
});
const safeTag = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 512 &&
	!UNSAFE_TAG.test(value) &&
	!value.includes(":")
		? value.trim() || undefined
		: undefined;
/** File bytes only on stdin; ffprobe cannot open network/file references embedded in a container.
 * Work/output/time are bounded; malformed/unknown metadata never leaks a filename. */
export async function probeLocalAudio(handle: FileHandle): Promise<LocalAudioMetadata> {
	return new Promise(resolve => {
		const child = spawn(
			ffprobe.path,
			[
				"-v",
				"quiet",
				"-protocol_whitelist",
				"pipe",
				"-i",
				"pipe:0",
				"-show_entries",
				"format=duration:format_tags=title,artist",
				"-of",
				"json",
			],
			{ windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] },
		);
		// The probe does not own the descriptor. Destroying this stream cannot close/reuse it.
		const stream = Readable.from(
			(async function* () {
				for (let position = 0; position < 8 * 1024 * 1024; ) {
					const buffer = Buffer.alloc(65536);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
					if (!bytesRead) {
						break;
					}
					position += bytesRead;
					yield buffer.subarray(0, bytesRead);
				}
			})(),
		);
		let output = "",
			outputBytes = 0,
			settled = false;
		const finish = (metadata = unknownMetadata()) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			stream.destroy();
			child.stdin.destroy();
			child.kill("SIGKILL");
			resolve(metadata);
		};
		const timer = setTimeout(() => finish(), 2000);
		child.on("error", () => finish());
		stream.on("error", () => finish());
		child.stdin.on("error", () => finish());
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (settled) {
				return;
			}
			outputBytes += Buffer.byteLength(chunk);
			if (outputBytes > 65536) {
				finish();
				return;
			}
			output += chunk;
		});
		child.on("close", code => {
			try {
				if (code !== 0) {
					finish();
					return;
				}
				const format = JSON.parse(output).format;
				const duration = Number(format?.duration);
				finish({
					title: safeTag(format?.tags?.title) ?? "Untitled track",
					artists: safeTag(format?.tags?.artist) ? [safeTag(format.tags.artist)!] : [],
					duration:
						Number.isFinite(duration) && duration > 0 && duration < 86400
							? duration
							: null,
				});
			} catch {
				finish();
			}
		});
		stream.pipe(child.stdin);
	});
}
