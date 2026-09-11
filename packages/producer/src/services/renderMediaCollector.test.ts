import { describe, expect, it } from "bun:test";
import { MEDIA_RENDER_ID_ATTR } from "@hyperframes/core";
import { collectRenderMedia } from "./renderMediaCollector.js";

describe("collectRenderMedia host windows", () => {
  it("schedules nested videos at resolved host id-ref windows", () => {
    const html =
      `<div data-composition-file="hook.html" data-composition-id="hook" data-start="0" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="red" id="red" src="red.mp4" data-start="0" data-duration="2"></video>` +
      `</div>` +
      `<div data-composition-file="body.html" data-composition-id="body" data-start="hook" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="blue" id="blue" src="blue.mp4" data-start="0" data-duration="2"></video>` +
      `</div>`;

    const { videos } = collectRenderMedia(html);
    expect(videos.find((v) => v.id === "red")).toMatchObject({ start: 0, end: 2 });
    expect(videos.find((v) => v.id === "blue")).toMatchObject({ start: 2, end: 4 });
  });

  it("preserves an explicitly marked legacy-global media window", () => {
    const html =
      `<div data-composition-file="scene.html" data-composition-id="scene" data-start="2" data-duration="6">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="local" id="local" src="local.mp4" data-start="2" data-duration="2" data-has-audio="true"></video>` +
      `<video ${MEDIA_RENDER_ID_ATTR}="global" id="global" src="global.mp4" data-start="2" data-duration="2" data-hf-media-start-basis="global" data-has-audio="true"></video>` +
      `</div>`;

    const { videos, audios } = collectRenderMedia(html);
    expect(videos.find((video) => video.id === "local")).toMatchObject({ start: 4, end: 6 });
    expect(videos.find((video) => video.id === "global")).toMatchObject({ start: 2, end: 4 });
    expect(audios.find((audio) => audio.id === "local-audio")).toMatchObject({ start: 4, end: 0 });
    expect(audios.find((audio) => audio.id === "global-audio")).toMatchObject({ start: 2, end: 0 });
  });
});
