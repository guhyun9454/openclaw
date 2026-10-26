import { beforeEach, expect, it, vi } from "vitest";
import type {
  listMediaGenerationOperations,
  MediaGenerationOperation,
} from "./media-generation-activity.js";
import {
  buildMediaTaskRuntimeContext,
  buildImageGenerationTaskStatusDetails as imageDetails,
  buildImageGenerationTaskStatusText as imageText,
  findDuplicateGuardImageGenerationTaskForSession as findImage,
  IMAGE_GENERATION_TASK_KIND,
  buildVideoGenerationTaskStatusDetails as videoDetails,
  buildVideoGenerationTaskStatusText as videoText,
  findActiveVideoGenerationTaskForSession as findVideo,
  VIDEO_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

const { listOperations } = vi.hoisted(() => ({
  listOperations: vi.fn<typeof listMediaGenerationOperations>(),
}));

vi.mock("./media-generation-activity.js", () => ({
  listMediaGenerationOperations: listOperations,
}));

function makeTask(overrides: Partial<MediaGenerationOperation>): MediaGenerationOperation {
  return {
    taskId: "task-running",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourceId: "image_generate:openai",
    requesterSessionKey: "agent:main",
    task: "running task",
    status: "running",
    ...overrides,
  };
}

beforeEach(() => {
  listOperations.mockReset().mockReturnValue([]);
});

function completedImage(name: string) {
  return makeTask({
    taskId: `task-${name}`,
    requestKey: `image-request:${name}`,
    status: "succeeded",
  });
}

const findImageRequest = (requestKey: string) => findImage("agent:main", { requestKey });
const findImagePrompt = (prompt: string) => findImage("agent:main", { prompt });

it.each([
  ["image", IMAGE_GENERATION_TASK_KIND, findImage, imageText, imageDetails],
  ["video", VIDEO_GENERATION_TASK_KIND, findVideo, videoText, videoDetails],
] as const)(
  "prefers a running %s task over queued session siblings",
  async (media, taskKind, findTask, buildText, buildDetails) => {
    listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        taskKind,
        sourceId: `${media}_generate:google`,
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        taskKind,
        sourceId: `${media}_generate:openai`,
        progressSummary: `Generating ${media}`,
      }),
    ]);

    const activeTask = await findTask("agent:main");
    expect(activeTask?.taskId).toBe("task-running");
    expect(buildText(activeTask!, { duplicateGuard: true })).toContain(
      `Do not call ${media}_generate again for this request.`,
    );
    expect(buildDetails(activeTask!)).toMatchObject({
      active: true,
      existingTask: true,
      status: "running",
      taskKind,
      provider: "openai",
      progressSummary: `Generating ${media}`,
    });
  },
);

it("preserves earlier recent request keys when another image request starts", async () => {
  listOperations.mockReturnValue([completedImage("first"), completedImage("second")]);

  expect(await findImageRequest("image-request:other")).toBeUndefined();
  expect((await findImageRequest("image-request:first"))?.taskId).toBe("task-first");
  expect((await findImageRequest("image-request:second"))?.taskId).toBe("task-second");
});

it("observes a newly admitted operation on the next owner lookup", async () => {
  expect(await findImagePrompt("new image")).toBeUndefined();
  listOperations.mockReturnValue([
    makeTask({
      taskId: "task-newly-started",
      task: "new image",
    }),
  ]);
  expect(await findImagePrompt("new image")).toMatchObject({
    taskId: "task-newly-started",
    status: "running",
  });
});

it("does not reuse an older success after a newer matching request failed", async () => {
  listOperations.mockReturnValue([
    completedImage("same"),
    { ...completedImage("same"), taskId: "task-retry", status: "failed" },
  ]);
  expect(await findImageRequest("image-request:same")).toBeUndefined();
});

it("builds video prompt context for active session work", async () => {
  listOperations.mockReturnValue([
    makeTask({
      taskKind: VIDEO_GENERATION_TASK_KIND,
      sourceId: "video_generate:openai",
      requesterAgentId: "main",
      progressSummary: "Generating video",
    }),
  ]);

  const context = await buildMediaTaskRuntimeContext({
    capabilityToolNames: new Set(["video_generate"]),
    sessionKey: "agent:main",
    agentId: "main",
  });

  expect(context).toBe(
    '## Media Generation Tasks\n- tool=video_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating video"',
  );
});
