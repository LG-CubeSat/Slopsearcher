import { drive, type drive_v3 } from "@googleapis/drive";
import { instanceId } from "../instance.ts";
import { Readable } from "node:stream";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { SourceIndex } from "../index/index.ts";
import { googleAuth } from "./auth.ts";
import { exportMime, extractText, supportedMime } from "./extract.ts";
import { logger } from "../log.ts";
const log = logger("drive");
const folderMime = "application/vnd.google-apps.folder";
const fields =
  "id,name,mimeType,modifiedTime,webViewLink,size,trashed,appProperties";
export class DriveService {
  readonly api: drive_v3.Drive;
  #syncing: Promise<void> | undefined;
  readonly instanceId: string;
  constructor(
    private cfg: Config,
    private db: Db,
    private index: SourceIndex,
  ) {
    this.instanceId = instanceId(this.db);
    this.api = drive({ version: "v3", auth: googleAuth(cfg) });
  }
  sync(): Promise<void> {
    if (!this.#syncing)
      this.#syncing = this.performSync().finally(() => {
        this.#syncing = undefined;
      });
    return this.#syncing;
  }
  private async performSync(): Promise<void> {
    if (!this.cfg.driveSourceFolderId) return;
    const files: drive_v3.Schema$File[] = [];
    const visited = new Set<string>();
    const walk = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      // Verify the root too, so losing access never retires the whole index.
      if (id === this.cfg.driveSourceFolderId) {
        const root = (
          await this.api.files.get(
            {
              fileId: id,
              fields: "id,mimeType,trashed",
              supportsAllDrives: true,
            },
            { timeout: 30000 },
          )
        ).data;
        if (root.mimeType !== folderMime || root.trashed)
          throw new Error(
            "DRIVE_SOURCE_FOLDER_ID must be an accessible, untrashed folder",
          );
      }
      let pageToken: string | undefined;
      do {
        const response = await this.api.files.list(
          {
            q: `'${id.replace(/'/g, "\\'")}' in parents and trashed = false`,
            fields: `nextPageToken,incompleteSearch,files(${fields})`,
            pageSize: 1000,
            ...(pageToken ? { pageToken } : {}),
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          },
          { timeout: 30000 },
        );
        if (response.data.incompleteSearch)
          throw new Error(
            "Drive returned an incomplete folder listing; keeping existing sources",
          );
        for (const file of response.data.files ?? []) {
          if (
            !file.id ||
            file.id === this.cfg.driveReportsFolderId ||
            file.appProperties?.slopsearcherTaskId
          )
            continue;
          if (file.mimeType === folderMime) await walk(file.id);
          else files.push(file);
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
    };
    await walk(this.cfg.driveSourceFolderId);
    const seen = new Set(files.map((f) => f.id!));
    let updated = 0;
    for (const file of files) {
      if (!file.id) continue;
      const mime = file.mimeType ?? "";
      const old = this.db
        .prepare<[string], { modified_time: string; metadata_json: string }>(
          "SELECT modified_time,metadata_json FROM drive_files WHERE file_id = ?",
        )
        .get(file.id);
      const previous = old
        ? (JSON.parse(old.metadata_json) as drive_v3.Schema$File)
        : null;
      if (
        old &&
        old.modified_time === file.modifiedTime &&
        previous?.name === file.name &&
        this.index.getByExternalId("drive", file.id)
      ) {
        this.db
          .prepare(
            "UPDATE sources SET fetched_at=? WHERE kind='drive' AND external_id=?",
          )
          .run(Date.now(), file.id);
        continue;
      }
      if (!supportedMime(mime)) {
        this.index.retire("drive", file.id);
        continue;
      }
      try {
        const maxBytes = this.cfg.driveMaxFileMb * 1024 * 1024;
        if (Number(file.size ?? 0) > maxBytes)
          throw new Error("File exceeds DRIVE_MAX_FILE_MB");
        const native = mime.startsWith("application/vnd.google-apps.");
        const response = native
          ? await this.api.files.export(
              { fileId: file.id, mimeType: exportMime(mime) },
              { responseType: "stream", timeout: 60000 },
            )
          : await this.api.files.get(
              { fileId: file.id, alt: "media", supportsAllDrives: true },
              { responseType: "stream", timeout: 60000 },
            );
        const parts: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const part of response.data) {
            const buf = Buffer.from(part);
            bytes += buf.length;
            if (bytes > maxBytes)
              throw new Error("Download exceeds DRIVE_MAX_FILE_MB");
            parts.push(buf);
          }
        } finally {
          response.data.destroy();
        }
        const text = await extractText(
          Buffer.concat(parts),
          exportMime(mime),
          this.cfg.maxSourceCharacters,
          maxBytes,
        );
        this.index.upsert({
          kind: "drive",
          externalId: file.id,
          title: file.name ?? file.id,
          url:
            file.webViewLink ??
            `https://drive.google.com/file/d/${file.id}/view`,
          ts: Date.parse(file.modifiedTime ?? "") || Date.now(),
          text,
        });
        this.db
          .prepare(
            "INSERT INTO drive_files(file_id,modified_time,metadata_json,indexed_at) VALUES(?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET modified_time=excluded.modified_time,metadata_json=excluded.metadata_json,indexed_at=excluded.indexed_at",
          )
          .run(
            file.id,
            file.modifiedTime ?? null,
            JSON.stringify(file),
            Date.now(),
          );
        updated++;
      } catch (e) {
        // Changed material must not keep answering from its old version after a failed download.
        this.index.retire("drive", file.id);
        log.warn(`Could not extract Drive file ${file.id}; will retry`, e);
      }
    }
    for (const row of this.db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM sources WHERE kind='drive' AND deleted_at IS NULL",
      )
      .all())
      if (!seen.has(row.external_id))
        this.index.retire("drive", row.external_id);
    log.info(`Checked ${files.length} Drive files; updated ${updated}`);
  }
  async saveReport(
    taskId: number,
    title: string,
    report: string,
  ): Promise<string | null> {
    if (!this.cfg.driveReportsFolderId) return null;
    const parent = this.cfg.driveReportsFolderId.replace(/'/g, "\\'");
    const existing = await this.api.files.list(
      {
        q: `'${parent}' in parents and trashed=false and appProperties has { key='slopsearcherTaskId' and value='${taskId}' } and appProperties has { key='slopsearcherInstance' and value='${this.instanceId}' }`,
        fields: "files(id)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      { timeout: 30000 },
    );
    const id = existing.data.files?.[0]?.id;
    const metadata = {
      name: `Slopsearch ${taskId} - ${title.replace(/[\r\n]/g, " ").slice(0, 120)}.md`,
      mimeType: "text/markdown",
      appProperties: {
        slopsearcherTaskId: String(taskId),
        slopsearcherInstance: this.instanceId,
      },
    };
    const media = { mimeType: "text/markdown", body: Readable.from([report]) };
    if (id) {
      await this.api.files.update(
        { fileId: id, requestBody: metadata, media, supportsAllDrives: true },
        { timeout: 60000 },
      );
      return id;
    }
    const created = await this.api.files.create(
      {
        requestBody: { ...metadata, parents: [this.cfg.driveReportsFolderId] },
        media,
        fields: "id",
        supportsAllDrives: true,
      },
      { timeout: 60000 },
    );
    return created.data.id ?? null;
  }
}
