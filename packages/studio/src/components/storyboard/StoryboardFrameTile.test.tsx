// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { StoryboardFrameTile } from "./StoryboardFrameTile";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./FramePoster", () => ({
  FramePoster: () => <div>poster</div>,
  posterTime: () => 0,
}));

describe("StoryboardFrameTile", () => {
  it("uses the storyboard canvas aspect ratio instead of forcing 16:9", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() =>
      root.render(
        <StoryboardFrameTile
          projectId="demo"
          frame={{
            index: 1,
            number: 1,
            title: "Portrait",
            status: "built",
            src: "compositions/portrait.html",
            srcExists: true,
            narrative: "",
            extra: {},
          }}
          aspectRatio="1080 / 1920"
          onOpen={vi.fn()}
          commentDraft=""
          onCommentDraftChange={vi.fn()}
          pendingComment={null}
        />,
      ),
    );

    const button = host.querySelector("button");
    expect(button?.style.aspectRatio).toBe("1080 / 1920");
    expect(button?.className).not.toContain("aspect-video");

    act(() => root.unmount());
    host.remove();
  });
});
