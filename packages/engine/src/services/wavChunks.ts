/**
 * The RIFF chunk walk, which two WAV readers in this directory each had a copy
 * of: `audioFxRender`'s `readWavChunks` and `audioVolumeEnvelope`'s
 * `parseWavLayout`.
 *
 * The walk and format-tag resolution are shared. Payload handling differs:
 * one wants a slice of the payload and lets the decoder judge the
 * format, the other wants offsets to edit in place and refuses anything that is
 * not 16-bit PCM or 32-bit float. Folding those together would mean picking one behaviour
 * for each difference, in the parser every render's audio passes through. So
 * payload handling stays in each reader.
 */

export interface RiffChunk {
  /** Four ASCII characters: `fmt `, `data`, `LIST`, `fact`, … */
  id: string;
  /** Byte offset of the chunk's body, past the 8-byte header. */
  body: number;
  /** The size the chunk declares. May run past the end of a truncated file. */
  size: number;
}

/** Resolve WAVE_FORMAT_EXTENSIBLE's complete subtype GUID, never just its low
 * word. Respect the declared fmt boundary so truncated extensions cannot borrow
 * bytes from a following chunk. Unsupported precision is left to the fallback.
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ksmedia/ns-ksmedia-waveformatextensible
 */
export function wavFormatTag(buffer: Buffer, body: number, size: number): number | null {
  if (size < 16 || body + size > buffer.length) return null;
  const format = buffer.readUInt16LE(body);
  if (format !== 0xfffe) return format;
  if (size < 40) return null;
  const extensionSize = buffer.readUInt16LE(body + 16);
  if (extensionSize < 22 || 18 + extensionSize > size) return null;
  if (buffer.readUInt16LE(body + 18) !== buffer.readUInt16LE(body + 14)) return null;
  if (buffer.subarray(body + 28, body + 40).toString("hex") !== "00001000800000aa00389b71")
    return null;
  return buffer.readUInt32LE(body + 24);
}

/**
 * Every chunk after the 12-byte RIFF header, in the order they sit.
 *
 * Advances by each chunk's declared size, so ordering is not assumed — `data`
 * may precede `fmt `, and trailing LIST/fact chunks are walked past rather than
 * tripped over. Chunks are word-aligned, so an odd size carries a pad byte.
 */
export function* riffChunks(buffer: Buffer): Generator<RiffChunk> {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    yield { id, body: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
}
