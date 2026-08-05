// fallow-ignore-file code-duplication
import { memo, useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useBlockCatalog } from "../../hooks/useBlockCatalog";
import {
  BLOCK_CATEGORIES,
  getCategoryColors,
  type BlockCategory,
} from "../../utils/blockCategories";
import { usePlayerStore } from "../../player";
import { buildAgentPrompt, type CompositionContext } from "./blocksAgentPrompt";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { TIMELINE_BLOCK_MIME } from "../../utils/timelineAssetDrop";
import { openAgentBridge } from "../../utils/agentBridge";
export interface BlockPreviewInfo {
  videoUrl?: string;
  posterUrl?: string;
  title: string;
}

interface BlocksTabProps {
  onAddBlock?: (blockName: string) => void;
  onPreviewBlock?: (preview: BlockPreviewInfo | null) => void;
}

// fallow-ignore-next-line complexity
export const BlocksTab = memo(function BlocksTab({ onAddBlock, onPreviewBlock }: BlocksTabProps) {
  const { loading, error, search, setSearch, category, setCategory, filteredBlocks } =
    useBlockCatalog();
  const [promptModal, setPromptModal] = useState<{
    title: string;
    prompt: string;
    registryItem: string;
  } | null>(null);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-neutral-600 text-xs">
        Loading blocks…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-red-400 text-xs px-4 text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search */}
      <div className="px-3 pt-2 pb-1 flex-shrink-0">
        <div className="relative">
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, category, or tag…"
            className="w-full bg-neutral-900 border border-neutral-800 rounded-md pl-7 pr-2 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-700 transition-colors"
          />
        </div>
      </div>

      {/* Category pills */}
      <div className="px-3 pt-1 pb-2 flex-shrink-0 overflow-x-auto">
        <div className="flex gap-1">
          <CategoryPill label="All" active={category === null} onClick={() => setCategory(null)} />
          {BLOCK_CATEGORIES.map((cat) => (
            <CategoryPill
              key={cat.id}
              label={cat.label}
              category={cat.id}
              active={category === cat.id}
              onClick={() => setCategory(category === cat.id ? null : cat.id)}
            />
          ))}
        </div>
      </div>

      {/* Block grid */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
        {category === "vfx" && (
          <div className="mb-2 px-2 py-1.5 rounded-md bg-purple-500/10 border border-purple-500/20 text-[9px] text-purple-300 leading-relaxed">
            VFX blocks use WebGL via HTML-in-Canvas. Enable{" "}
            <span className="font-mono text-purple-200">chrome://flags/#html-in-canvas</span> for
            preview.
          </div>
        )}
        {filteredBlocks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-neutral-600 text-xs">
            No blocks match your search
          </div>
        ) : (
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}
          >
            {filteredBlocks.map((block) => {
              const dur = "duration" in block ? (block.duration as number) : undefined;
              return (
                <BlockCard
                  key={block.name}
                  name={block.name}
                  title={block.title}
                  description={block.description}
                  blockType={block.type}
                  duration={dur}
                  category={block.category}
                  tags={block.tags}
                  posterUrl={block.preview?.poster}
                  videoUrl={block.preview?.video}
                  onPreview={onPreviewBlock}
                  onShowPrompt={setPromptModal}
                  onAdd={
                    block.category === "vfx" ||
                    block.category === "social" ||
                    block.category === "scenes"
                      ? () => onAddBlock?.(block.name)
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
      {promptModal &&
        createPortal(
          <PromptPreviewModal
            title={promptModal.title}
            prompt={promptModal.prompt}
            registryItem={promptModal.registryItem}
            onClose={() => setPromptModal(null)}
          />,
          document.body,
        )}
    </div>
  );
});

function CategoryPill({
  label,
  category,
  active,
  onClick,
}: {
  label: string;
  category?: BlockCategory;
  active: boolean;
  onClick: () => void;
}) {
  const colors = category ? getCategoryColors(category) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-shrink-0 px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
        active
          ? colors
            ? `${colors.bg} ${colors.text}`
            : "bg-neutral-700 text-neutral-200"
          : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}

function BlockCard({
  name,
  title,
  description,
  blockType,
  duration,
  category,
  tags,
  posterUrl,
  videoUrl,
  onAdd,
  onShowPrompt,
  onPreview,
}: {
  name: string;
  title: string;
  description: string;
  blockType: string;
  duration?: number;
  category: BlockCategory;
  tags?: string[];
  posterUrl?: string;
  videoUrl?: string;
  onAdd?: () => void;
  onShowPrompt?: (info: { title: string; prompt: string; registryItem: string }) => void;
  onPreview?: (preview: BlockPreviewInfo | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [adding, setAdding] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colors = getCategoryColors(category);
  const needsWebGL = tags?.includes("html-in-canvas") || tags?.includes("webgl");

  const handleEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      setHovered(true);
      onPreview?.({ videoUrl, posterUrl, title });
    }, 300);
  }, [onPreview, videoUrl, posterUrl, title]);

  const handleLeave = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHovered(false);
    onPreview?.(null);
  }, [onPreview]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (adding || !onAdd) return;
      setAdding(true);
      onAdd();
      setTimeout(() => setAdding(false), 1000);
    },
    [onAdd, adding],
  );

  const { activeCompPath, compositionDimensions } = useStudioShellContext();

  const handleShowPrompt = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const state = usePlayerStore.getState();
      const context: CompositionContext = {
        currentTime: state.currentTime,
        activeCompPath,
        elements: state.elements.map((el) => ({
          id: el.id,
          start: el.start,
          duration: el.duration,
          track: el.track,
          label: el.label,
          compositionSrc: el.compositionSrc,
        })),
        compositionDimensions: compositionDimensions ?? undefined,
      };
      const prompt = buildAgentPrompt(title, name, description, category, blockType, context);
      onShowPrompt?.({ title, prompt, registryItem: name });
    },
    [
      title,
      name,
      description,
      category,
      blockType,
      activeCompPath,
      compositionDimensions,
      onShowPrompt,
    ],
  );

  return (
    <div
      className="group/card rounded-md overflow-hidden cursor-pointer transition-colors bg-neutral-900 hover:bg-neutral-800"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(TIMELINE_BLOCK_MIME, JSON.stringify({ name }));
        e.dataTransfer.setData("text/plain", name);
        handleLeave(); // cancel the hover-preview timer so it doesn't fire mid-drag
      }}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
    >
      <div className="aspect-video w-full overflow-hidden relative">
        {hovered && videoUrl ? (
          <video
            src={videoUrl}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover"
          />
        ) : posterUrl ? (
          <img src={posterUrl} alt={title} loading="lazy" className="w-full h-full object-cover" />
        ) : videoUrl ? (
          <video
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center ${colors.bg}`}>
            <span className={`text-[9px] font-medium ${colors.text}`}>
              {category.toUpperCase()}
            </span>
          </div>
        )}

        {/* Action overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 opacity-0 group-hover/card:opacity-100 transition-opacity">
          {onAdd && (
            <button
              type="button"
              onClick={handleAdd}
              title="Add to composition at current time"
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-white text-black text-[10px] font-semibold hover:bg-neutral-200 transition-colors"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {adding ? "Added!" : "Add"}
            </button>
          )}
          <button
            type="button"
            onClick={handleShowPrompt}
            title="Generate a prompt to paste into your AI agent"
            className={`flex items-center gap-1.5 px-3 ${onAdd ? "py-1" : "py-1.5"} rounded-md transition-colors ${
              onAdd
                ? "bg-white/15 text-white/90 hover:bg-white/25 text-[9px]"
                : "bg-white text-black hover:bg-neutral-200 text-[10px] font-semibold"
            }`}
          >
            <svg
              width={onAdd ? 9 : 11}
              height={onAdd ? 9 : 11}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Ask agent
          </button>
        </div>

        {/* Badges */}
        <div className="absolute top-1 right-1 flex items-center gap-0.5 pointer-events-none">
          {needsWebGL && (
            <span className="px-1 py-px rounded text-[7px] font-semibold text-purple-300 bg-purple-900/70">
              WebGL
            </span>
          )}
          {duration != null && (
            <span className="px-1 py-px rounded text-[8px] font-medium text-white/80 bg-black/50">
              {duration}s
            </span>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="px-1.5 py-1.5">
        <div className="text-[10px] font-medium text-neutral-200 truncate leading-tight">
          {title}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors.dot}`} />
          <span className={`text-[8px] ${colors.text}`}>
            {BLOCK_CATEGORIES.find((c) => c.id === category)?.label}
          </span>
        </div>
      </div>
    </div>
  );
}

function PromptPreviewModal({
  title,
  prompt,
  registryItem,
  onClose,
}: {
  title: string;
  prompt: string;
  registryItem: string;
  onClose: () => void;
}) {
  const [value, setValue] = useState(prompt);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  const handleSend = useCallback(() => {
    openAgentBridge({ kind: "catalog", prompt: value, title, registryItem });
    onClose();
  }, [onClose, registryItem, title, value]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] flex flex-col rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800/60">
          <div>
            <h3 className="text-sm font-medium text-neutral-200">Ask agent</h3>
            <p className="text-xs text-neutral-500 mt-0.5">{title}</p>
          </div>
          <button
            className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50"
            onClick={onClose}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[11px] text-neutral-500 mb-2">
            Edit the prompt below, then copy and paste into your AI agent
          </p>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCopy();
              if (e.key === "Escape") onClose();
            }}
            className="w-full min-h-[240px] text-[11px] text-neutral-200 leading-relaxed font-mono bg-neutral-900/60 rounded-lg p-3 border border-neutral-800 resize-y focus:outline-none focus:border-studio-accent/60 focus:ring-1 focus:ring-studio-accent/30"
          />
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-800/60">
          <span className="text-[11px] text-neutral-600">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to copy
          </span>
          <div className="flex gap-2">
            <button
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-studio-accent text-neutral-950"
              onClick={handleSend}
            >
              Create with Agent
            </button>
            <button
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                copied
                  ? "bg-emerald-500 text-white"
                  : "bg-studio-accent/90 text-neutral-950 hover:bg-studio-accent"
              }`}
              onClick={handleCopy}
            >
              {copied ? "Copied!" : "Copy prompt"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
