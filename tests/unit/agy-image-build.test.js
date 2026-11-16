import { describe, it, expect, vi } from "vitest";
import {
  buildAgyImage,
  getAgyImageStatus,
  resolveAgyBuildContext,
} from "@/lib/docker/install.js";

describe("agy gateway image build", () => {
  it("finds the repository Docker build context", () => {
    const context = resolveAgyBuildContext();
    expect(context).toBeTruthy();
    expect(context.replaceAll("\\", "/")).toMatch(/docker\/agy-gateway$/);
  });

  it("reports image status without throwing when the daemon fails", async () => {
    const status = await getAgyImageStatus({
      client: { imageExists: async () => { throw new Error("daemon down"); } },
      tag: "test",
    });
    expect(status.exists).toBe(false);
    expect(status.ref).toBe("ultrarouter/agy-gateway:test");
    expect(status.error).toContain("daemon down");
  });

  it("builds the expected image ref and skips when it already exists", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "built", stderr: "" }));
    const result = await buildAgyImage({
      tag: "test",
      run,
      client: { imageExists: async () => false },
    });
    expect(result.ok).toBe(true);
    expect(result.ref).toBe("ultrarouter/agy-gateway:test");
    expect(run).toHaveBeenCalledWith(
      "docker",
      ["build", "-t", "ultrarouter/agy-gateway:test", expect.stringMatching(/docker[\\/]agy-gateway$/)],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );

    const skipRun = vi.fn();
    const skipped = await buildAgyImage({
      tag: "test",
      run: skipRun,
      client: { imageExists: async () => true },
    });
    expect(skipped).toMatchObject({ ok: true, skipped: true });
    expect(skipRun).not.toHaveBeenCalled();
  });
});
