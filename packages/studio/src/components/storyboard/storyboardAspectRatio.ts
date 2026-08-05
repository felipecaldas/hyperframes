const DEFAULT_STORYBOARD_ASPECT_RATIO = "16 / 9";

/**
 * Convert STORYBOARD.md's global canvas format into a CSS aspect-ratio value.
 * Invalid or missing formats keep the historical 16:9 board shape.
 */
export function storyboardAspectRatio(format: string | undefined): string {
  if (!format) return DEFAULT_STORYBOARD_ASPECT_RATIO;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(format);
  if (!match) return DEFAULT_STORYBOARD_ASPECT_RATIO;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_STORYBOARD_ASPECT_RATIO;
  }
  return `${width} / ${height}`;
}
