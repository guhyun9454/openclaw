import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { detect, readRelease, launch, success } = vi.hoisted(() => {
  const result: SpawnResult = {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
  return {
    success: result,
    detect: vi.fn<typeof import("./detect-binary.js").detectBinary>(async () => false),
    readRelease: vi.fn<() => Promise<string>>(),
    launch: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(async () => result),
  };
});

// mock-isolation: Model platform opener availability independently of installed host binaries.
vi.mock("./detect-binary.js", () => ({ detectBinary: detect }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: () => "" };
});

// mock-isolation: Observe opener commands without launching host applications.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: launch }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: { ...actual, readFile: readRelease },
    readFile: readRelease,
  };
});

let detectSupport: typeof import("./browser-open.js").detectBrowserOpenSupport;
let openUrl: typeof import("./browser-open.js").openUrl;
let openLocalFile: typeof import("./browser-open.js").openLocalFile;

const url = "https://example.com/";
const openedWith = (...argv: string[]) =>
  expect(launch).toHaveBeenCalledExactlyOnceWith(argv, { timeoutMs: 5_000 });

beforeEach(async () => {
  vi.resetModules();
  ({
    detectBrowserOpenSupport: detectSupport,
    openUrl,
    openLocalFile,
  } = await import("./browser-open.js"));
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "development");
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "WSL_INTEROP",
    "WSL_DISTRO_NAME",
    "WSLENV",
    "SSH_CLIENT",
    "SSH_CONNECTION",
    "SSH_TTY",
  ]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  detect.mockReset().mockResolvedValue(false);
  readRelease.mockReset().mockResolvedValue("6.8.0-generic");
  launch.mockReset().mockResolvedValue(success);
});

describe("openLocalFile", () => {
  it("passes only the private file:// path to the opener, never a credential URL", async () => {
    mockProcessPlatform("linux");
    vi.stubEnv("DISPLAY", ":0");
    detect.mockResolvedValue(true);

    await expect(openLocalFile("/tmp/openclaw-browser-handoff-X/handoff.html")).resolves.toBe(true);
    const argv = launch.mock.calls[0]![0];
    expect(argv).toEqual(["xdg-open", expect.stringMatching(/^file:\/\//)]);
    expect(argv[1]).not.toContain("bootstrapToken");
  });

  it("opens native Windows handoff paths instead of reading the drive letter as a URL scheme", async () => {
    mockProcessPlatform("win32");

    await expect(openLocalFile("C:\\Temp\\handoff.html")).resolves.toBe(true);
    const argv = launch.mock.calls[0]![0];
    expect(argv[0]).toMatch(/\\System32\\rundll32\.exe$/u);
    expect(argv.at(-2)).toBe("url.dll,FileProtocolHandler");
    expect(argv.at(-1)).toBe("file:///C:/Temp/handoff.html");
  });

  it("refuses http(s) URLs and non-file inputs", async () => {
    mockProcessPlatform("linux");

    await expect(openLocalFile("http://127.0.0.1:18789/#bootstrapToken=x")).resolves.toBe(false);
    await expect(openLocalFile("file:///tmp/handoff.html")).resolves.toBe(false);
    await expect(openLocalFile("relative/handoff.html")).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("browser support and launch", () => {
  it.each([
    ["linux", "", "", null],
    ["linux", "", "192.0.2.1 12345 192.0.2.2 22", null],
    ["darwin", "", "192.0.2.1 12345 192.0.2.2 22", "open"],
    ["linux", "localhost:10.0", "192.0.2.1 12345 192.0.2.2 22", "xdg-open"],
  ] as const)(
    "resolves %s opener with display=%s SSH=%s",
    async (platform, display, ssh, command) => {
      mockProcessPlatform(platform);
      vi.stubEnv("DISPLAY", display);
      vi.stubEnv("SSH_CONNECTION", ssh);
      detect.mockImplementation(async (binary) => binary === command);
      await expect(detectSupport()).resolves.toEqual({ ok: command !== null });
      await expect(openUrl(url)).resolves.toBe(command !== null);
      if (command) {
        expect(detect).toHaveBeenCalledWith(command);
        openedWith(command, url);
      } else {
        expect(launch).not.toHaveBeenCalled();
      }
    },
  );

  it("reports display-less WSL support only when wslview is installed", async () => {
    detect.mockImplementation(async (binary) => binary === "wslview");
    mockProcessPlatform("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");

    await expect(detectSupport()).resolves.toEqual({ ok: true });

    await expect(openUrl(url)).resolves.toBe(true);
    openedWith("wslview", url);

    detect.mockResolvedValue(false);
    await expect(detectSupport()).resolves.toEqual({ ok: false });
  });
});
