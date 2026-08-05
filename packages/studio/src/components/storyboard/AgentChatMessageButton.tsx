import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { openAgentBridge } from "../../utils/agentBridge";
import type { AgentRequestKind } from "@hyperframes/studio-server";

export const APPLY_STORYBOARD_FEEDBACK_MESSAGE =
  "Read the storyboard feedback I saved in .hyperframes/frame-comments.json and revise the frames.";

export function AgentChatMessageButton({
  message,
  label = "Copy prompt for agent",
  onCopied,
  kind = message === APPLY_STORYBOARD_FEEDBACK_MESSAGE
    ? "storyboard-feedback"
    : "storyboard-approval",
}: {
  message: string;
  label?: string;
  onCopied?: () => void;
  kind?: AgentRequestKind;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "again" | "failed">("idle");

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("again"), 3000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopyState("copied");
      onCopied?.();
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="primary"
        onClick={() => openAgentBridge({ kind, prompt: message, title: "Storyboard review" })}
      >
        Send to Agent
      </Button>
      <Button size="sm" variant="secondary" onClick={() => void copyMessage()}>
        {copyState === "copied"
          ? "Copied — paste in your agent chat"
          : copyState === "again"
            ? "Copy again"
            : copyState === "failed"
              ? "Copy failed"
              : label}
      </Button>
    </div>
  );
}
