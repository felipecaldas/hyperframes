import { useState } from "react";
import type { DomEditSelection } from "./domEditing";
import { resolveDomEditSelection } from "./domEditingLayers";
import { ColorField } from "./propertyPanelColor";
import { FlatRow } from "./propertyPanelFlatPrimitives";
import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";

/**
 * The karaoke highlight controls for a compiler-emitted caption.
 *
 * A caption container carries its highlight parameters as data attributes
 * (`data-active-color`, `data-rest-color`, `data-active-scale`) that the
 * composition's one shared highlight loop reads at load. So restyling a
 * caption is a plain attribute commit — the same op the timing panel uses —
 * and the preview reload that follows the file write is what re-runs the loop
 * with the new values.
 *
 * Deliberately NOT built on the upstream Caption Designer: that surface keys
 * on `.caption-group` markup and persists to a parallel overrides file, and a
 * compiler-owned caption must keep its style in the compiler's attributes so
 * a regeneration can replay it.
 */

/** The data attributes (without the `data-` prefix) the inspector owns. */
const CAPTION_STYLE_ATTRS = ["active-color", "rest-color", "active-scale"] as const;

export function isCaptionSelection(selection: DomEditSelection): boolean {
  return (
    selection.element.hasAttribute("data-hf-atomic") &&
    selection.element.classList.contains("hf-captions")
  );
}

/** The selected caption's style attributes, for committing onto another one. */
export function collectCaptionStyleAttrs(el: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of CAPTION_STYLE_ATTRS) {
    const value = el.getAttribute(`data-${attr}`);
    if (value) attrs[attr] = value;
  }
  return attrs;
}

export function captionStyleSummary(selection: DomEditSelection): string {
  const el = selection.element;
  const color = el.getAttribute("data-active-color") ?? "default";
  const scale = el.getAttribute("data-active-scale");
  return scale ? `${color} · ×${scale}` : color;
}

/**
 * Commit the source caption's style attributes onto every other caption in the
 * document. One commit per caption, sequential on purpose: each commit is an
 * optimistic preview write plus a file persist, and racing them would
 * interleave their save queue. Returns how many captions now carry the style,
 * the source included.
 */
export async function applyCaptionStyleToAll({
  doc,
  sourceEl,
  activeCompositionPath,
  onSetAttributes,
}: {
  doc: Document;
  sourceEl: HTMLElement;
  activeCompositionPath: string | null;
  onSetAttributes: (selection: DomEditSelection, attrs: Record<string, string>) => Promise<void>;
}): Promise<number> {
  const attrs = collectCaptionStyleAttrs(sourceEl);
  if (Object.keys(attrs).length === 0) return 0;
  const isMasterView = !activeCompositionPath || activeCompositionPath === "index.html";
  const others = Array.from(
    doc.querySelectorAll<HTMLElement>("[data-hf-atomic].hf-captions"),
  ).filter((candidate) => candidate !== sourceEl);
  let applied = 1;
  for (const caption of others) {
    const selection = await resolveDomEditSelection(caption, {
      activeCompositionPath,
      isMasterView,
      skipSourceProbe: true,
    });
    if (!selection) continue;
    await onSetAttributes(selection, attrs);
    applied += 1;
  }
  return applied;
}

export function FlatCaptionSection({
  element,
  onSetAttribute,
  onSetAttributes,
}: {
  element: DomEditSelection;
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  onSetAttributes?: (selection: DomEditSelection, attrs: Record<string, string>) => Promise<void>;
}) {
  const track = useTrackDesignInput();
  const shell = useStudioShellContextOptional();
  const [applying, setApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const el = element.element;
  const activeColor = el.getAttribute("data-active-color") ?? "#ffffff";
  const restColor = el.getAttribute("data-rest-color") ?? "#ffffff";
  const activeScale = el.getAttribute("data-active-scale") ?? "1";

  const applyToAll = async () => {
    const doc = shell?.previewIframeRef.current?.contentDocument;
    if (!doc || !onSetAttributes) return;
    setApplying(true);
    try {
      const applied = await applyCaptionStyleToAll({
        doc,
        sourceEl: el,
        activeCompositionPath: shell.activeCompPath,
        onSetAttributes,
      });
      if (applied > 0) setAppliedCount(applied);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div data-flat-caption="true" className="flex flex-col gap-1">
      <ColorField
        flat
        label="Active color"
        value={activeColor}
        onCommit={(next) => void onSetAttribute("active-color", next)}
      />
      <ColorField
        flat
        label="Rest color"
        value={restColor}
        onCommit={(next) => void onSetAttribute("rest-color", next)}
      />
      <FlatRow
        label="Pop scale"
        value={activeScale}
        tier={el.hasAttribute("data-active-scale") ? "explicitCustom" : "default"}
        onCommit={(next) => {
          const parsed = Number.parseFloat(next);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          void onSetAttribute("active-scale", String(parsed));
        }}
      />
      {onSetAttributes && shell && (
        <button
          type="button"
          data-flat-caption-apply-all="true"
          disabled={applying}
          onClick={() => {
            track("button", "Apply to all captions");
            void applyToAll();
          }}
          className="mt-1 border border-panel-hairline bg-panel-bg-soft px-2 py-1.5 text-[11px] text-panel-text-2 transition-colors hover:border-panel-border-input hover:bg-panel-bg disabled:cursor-wait disabled:opacity-50"
        >
          {applying ? "Applying…" : "Apply to all captions"}
        </button>
      )}
      {appliedCount !== null && !applying && (
        <div className="text-[10px] text-panel-text-4">
          Applied to {appliedCount} caption{appliedCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
