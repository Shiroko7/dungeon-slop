/**
 * Constants shared by the browser and the server.
 *
 * This file must stay free of runtime imports. Anything the client pulls in
 * drags its whole import graph into the bundle, and the server-side notes
 * modules reach `bun:sqlite` and `process.env` within two hops — which Vite
 * stubs out, so the failure is a module-evaluation throw and a blank page
 * rather than a build error.
 */

export const SUPPORTED_EXTENSIONS = [".md", ".txt", ".markdown", ".text"] as const;
export const MAX_NOTE_FILES = 20;
export const MAX_NOTE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_NOTE_BATCH_BYTES = 20 * 1024 * 1024;
export const CHUNKER_VERSION = "markdown-v1";

export function isSupportedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
