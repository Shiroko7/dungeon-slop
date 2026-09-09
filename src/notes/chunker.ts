import type { Chunk, ChunkOptions } from "./types.ts";

const DEFAULT_TARGET = 800;
const DEFAULT_OVERLAP = 100;
const DEFAULT_MAX = 1200;

/**
 * Cheap token estimate: ~4 characters per token. Deliberately not exact — the
 * chunker only needs this to decide where to cut, and calling out to a real
 * tokenizer per block would dominate ingest time for no gain in retrieval
 * quality. Budgets that must be exact (an API request) count tokens separately.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type BlockKind = "heading" | "prose" | "code";

interface Block {
  kind: BlockKind;
  /** Heading depth (1-6); 0 for everything else. */
  level: number;
  /** Heading title with its leading #s stripped; raw text otherwise. */
  title: string;
  start: number;
  end: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Split source into headings, fenced code blocks, and blank-line-separated
 * prose. Offsets are trimmed so `source.slice(start, end)` never has ragged
 * whitespace at either edge.
 */
function toBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split("\n");

  let offset = 0;
  let bufStart = -1;
  let bufEnd = -1;
  let inFence = false;
  let fenceStart = -1;

  const flushProse = (): void => {
    if (bufStart >= 0 && bufEnd > bufStart) {
      blocks.push({
        kind: "prose",
        level: 0,
        title: source.slice(bufStart, bufEnd),
        start: bufStart,
        end: bufEnd,
      });
    }
    bufStart = -1;
    bufEnd = -1;
  };

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;

    if (FENCE_RE.test(line)) {
      if (inFence) {
        blocks.push({ kind: "code", level: 0, title: "", start: fenceStart, end: lineEnd });
        inFence = false;
      } else {
        flushProse();
        inFence = true;
        fenceStart = lineStart;
      }
      continue;
    }

    // Inside a fence everything is opaque — never split here.
    if (inFence) continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushProse();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        title: heading[2]!.trim(),
        start: lineStart,
        end: lineEnd,
      });
      continue;
    }

    if (line.trim() === "") {
      flushProse();
      continue;
    }

    if (bufStart < 0) bufStart = lineStart;
    bufEnd = lineEnd;
  }

  // An unterminated fence still has to be emitted, or its content vanishes.
  if (inFence) {
    blocks.push({ kind: "code", level: 0, title: "", start: fenceStart, end: source.length });
  }
  flushProse();

  return blocks;
}

/** Longest prefix of `text` that fits in `budget` tokens, cut on a sentence end. */
function sentenceCut(text: string, budget: number): number {
  const limit = budget * 4;
  if (text.length <= limit) return text.length;

  const window = text.slice(0, limit);
  for (const re of [/[.!?]["')\]]?\s+(?=[^\s])/g, /\n/g, /\s+/g]) {
    let last = -1;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
    // Only accept a break that keeps at least half the budget, or we thrash.
    if (last > limit / 2) return last;
  }
  return limit;
}

/** Split one oversized block into ranges that each fit under `maxTokens`. */
function splitOversized(source: string, block: Block, maxTokens: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = block.start;

  while (cursor < block.end) {
    const remaining = source.slice(cursor, block.end);
    const take = sentenceCut(remaining, maxTokens);
    const next = Math.min(cursor + take, block.end);
    if (next <= cursor) break;
    ranges.push([cursor, next]);
    cursor = next;
  }

  return ranges;
}

function pathOf(stack: Block[]): string {
  return stack.map((h) => h.title).join(" › ");
}

/**
 * Split a document into overlapping chunks that respect its structure.
 *
 * Headings are hard boundaries — a chunk never spans two sections — because a
 * retrieval hit that straddles "Session 11" and "Session 12" is worse than
 * useless for a campaign, where the section a line sits under is most of what
 * makes it meaningful. Within a section, prose accumulates to `targetTokens`
 * with `overlapTokens` of the previous chunk repeated, so a fact that lands on
 * a chunk seam is still retrievable whole from one side of it.
 *
 * Plain .txt with no headings degrades to paragraph accumulation, which is the
 * same code path with an empty heading stack.
 */
export function chunkDocument(source: string, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET;
  const overlap = options.overlapTokens ?? DEFAULT_OVERLAP;
  const max = options.maxTokens ?? DEFAULT_MAX;

  const blocks = toBlocks(source);
  const chunks: Chunk[] = [];
  const headings: Block[] = [];

  // Ranges accumulated toward the current chunk, and the ones just emitted
  // (kept so the next chunk in this section can borrow an overlap tail).
  let pending: Array<[number, number]> = [];
  let pendingTokens = 0;
  let previous: Array<[number, number]> = [];

  const flush = (): void => {
    if (pending.length === 0) return;

    const head = pending[0]!;
    const tail = pending[pending.length - 1]!;
    const text = source.slice(head[0], tail[1]);

    chunks.push({
      ordinal: chunks.length,
      headingPath: pathOf(headings),
      text,
      tokens: estimateTokens(text),
      startOffset: head[0],
      endOffset: tail[1],
    });

    previous = pending;
    pending = [];
    pendingTokens = 0;
  };

  /**
   * Seed a new chunk with the tail of the one just emitted, capped at
   * `overlapTokens`. Whole ranges are carried while they fit; if even the last
   * range alone is bigger than the budget, a partial tail of it is carried
   * instead. Carrying whole oversized ranges would let a document with coarse
   * paragraphs nearly double in size, which is the corpus, the embedding bill,
   * and the retrieval noise floor all at once.
   */
  const seedOverlap = (): void => {
    if (overlap <= 0 || previous.length === 0) return;

    const carried: Array<[number, number]> = [];
    let carriedTokens = 0;

    for (let i = previous.length - 1; i >= 0; i--) {
      const range = previous[i]!;
      const tokens = estimateTokens(source.slice(range[0], range[1]));
      if (carriedTokens + tokens > overlap) break;
      carried.unshift(range);
      carriedTokens += tokens;
    }

    if (carried.length === 0) {
      const last = previous[previous.length - 1]!;
      const text = source.slice(last[0], last[1]);
      const keep = overlap * 4;
      if (keep >= text.length) return;

      // Snap forward to a word boundary so the tail never starts mid-token.
      const cut = text.length - keep;
      const space = text.indexOf(" ", cut);
      const from = last[0] + (space >= 0 ? space + 1 : cut);
      if (from >= last[1]) return;

      carried.push([from, last[1]]);
      carriedTokens = estimateTokens(source.slice(from, last[1]));
    }

    pending = carried;
    pendingTokens = carriedTokens;
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush();
      previous = [];
      while (headings.length > 0 && headings[headings.length - 1]!.level >= block.level) {
        headings.pop();
      }
      headings.push(block);
      continue;
    }

    const tokens = estimateTokens(source.slice(block.start, block.end));

    if (tokens > max) {
      flush();
      previous = [];
      for (const range of splitOversized(source, block, max)) {
        pending = [range];
        pendingTokens = estimateTokens(source.slice(range[0], range[1]));
        flush();
      }
      previous = [];
      continue;
    }

    if (pendingTokens + tokens > target && pending.length > 0) {
      flush();
      seedOverlap();
    }

    pending.push([block.start, block.end]);
    pendingTokens += tokens;
  }

  flush();
  return chunks;
}
