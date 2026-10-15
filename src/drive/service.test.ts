import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadConfig } from "../config.ts";
import { openAndMigrate, type Db } from "../db/index.ts";
import { SourceIndex } from "../index/index.ts";
import { DriveService } from "./service.ts";
let dir: string, db: Db, index: SourceIndex, service: DriveService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slop-drive-"));
  const token = join(dir, "token.json");
  writeFileSync(
    token,
    JSON.stringify({
      refresh_token: "fake",
      access_token: "fake",
      expiry_date: Date.now() + 9999999,
    }),
  );
  const cfg = {
    ...loadConfig({}),
    googleClientId: "fake",
    googleClientSecret: "fake",
    googleTokenPath: token,
    driveSourceFolderId: "root",
    driveReportsFolderId: "reports",
  };
  db = openAndMigrate(":memory:");
  index = new SourceIndex(db);
  service = new DriveService(cfg, db, index);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const file = {
  id: "doc",
  name: "Radio plan",
  mimeType: "text/plain",
  modifiedTime: "2026-10-01T00:00:00Z",
  webViewLink: "https://drive.google.com/doc",
};
const stubGet = () =>
  vi.spyOn(service.api.files, "get").mockImplementation(
    async (p: any) =>
      ({
        data:
          p.fileId === "root"
            ? { id: "root", mimeType: "application/vnd.google-apps.folder" }
            : Readable.from(["Radio uses RFM95"]),
      }) as any,
  );
it("recursively indexes folder contents, skips reports, and avoids downloading unchanged files", async () => {
  const get = stubGet();
  vi.spyOn(service.api.files, "list").mockImplementation(
    async (p: any) =>
      ({
        data: {
          files: p.q.startsWith("'root'")
            ? [
                {
                  id: "nested",
                  mimeType: "application/vnd.google-apps.folder",
                },
                {
                  id: "reports",
                  mimeType: "application/vnd.google-apps.folder",
                },
              ]
            : [file],
        },
      }) as any,
  );
  await service.sync();
  expect(index.search("RFM95")).toHaveLength(1);
  await service.sync();
  expect(
    get.mock.calls.filter(([p]) => (p as any).fileId === "doc"),
  ).toHaveLength(1);
});
it("does not retire existing sources when a folder listing fails", async () => {
  index.upsert({
    kind: "drive",
    externalId: "doc",
    url: "https://drive.google.com/doc",
    text: "Existing radio decision",
    ts: 1,
  });
  stubGet();
  vi.spyOn(service.api.files, "list").mockRejectedValue(Error("offline"));
  await expect(service.sync()).rejects.toThrow("offline");
  expect(index.search("radio")).toHaveLength(1);
});
it("retires sources that disappear from a complete folder listing", async () => {
  index.upsert({
    kind: "drive",
    externalId: "doc",
    url: "https://drive.google.com/doc",
    text: "Old radio decision",
    ts: 1,
  });
  stubGet();
  vi.spyOn(service.api.files, "list").mockResolvedValue({
    data: { files: [] },
  } as any);
  await service.sync();
  expect(index.search("radio")).toEqual([]);
});
it("retires a changed file if its new content cannot be downloaded", async () => {
  index.upsert({
    kind: "drive",
    externalId: "doc",
    url: "https://drive.google.com/doc",
    text: "Old radio decision",
    ts: 1,
  });
  vi.spyOn(service.api.files, "get").mockImplementation(async (p: any) => {
    if (p.fileId === "root")
      return {
        data: { mimeType: "application/vnd.google-apps.folder" },
      } as any;
    throw Error("not accessible");
  });
  vi.spyOn(service.api.files, "list").mockResolvedValue({
    data: { files: [file] },
  } as any);
  await service.sync();
  expect(index.search("radio")).toEqual([]);
});
it("updates an existing report instead of uploading a duplicate", async () => {
  const list = vi
    .spyOn(service.api.files, "list")
    .mockResolvedValue({ data: { files: [{ id: "existing-report" }] } } as any);
  const update = vi
    .spyOn(service.api.files, "update")
    .mockResolvedValue({ data: { id: "existing-report" } } as any);
  expect(await service.saveReport(1, "Radio", "Report")).toBe(
    "existing-report",
  );
  expect(update).toHaveBeenCalledOnce();
  expect((list.mock.calls[0]![0] as any).q).toContain(service.instanceId);
});
