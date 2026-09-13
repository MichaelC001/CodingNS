import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { createGzip, createGunzip } from "node:zlib";

import { AppError } from "../../shared/errors/app-error.js";
import type {
  SessionCleanupBackupManifest,
  SessionCleanupBackupManifestEntry,
  SessionCleanupCandidate
} from "../../types/domain.js";

interface SessionCleanupArchiveFileRecord {
  type: "file";
  relativePath: string;
  encoding: "base64";
  content: string;
}

interface SessionCleanupArchiveManifestRecord {
  type: "manifest";
  manifest: SessionCleanupBackupManifest;
}

type SessionCleanupArchiveRecord = SessionCleanupArchiveManifestRecord | SessionCleanupArchiveFileRecord;

const MAX_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_RECORDS = 100_000;
const MAX_ARCHIVE_LINE_BYTES = 64 * 1024 * 1024;

export interface SessionCleanupArchiveWriteInput {
  archivePath: string;
  manifest: SessionCleanupBackupManifest;
}

export interface SessionCleanupRestoreInspectionItem {
  entryId: string;
  candidateId: string;
  provider: SessionCleanupCandidate["provider"];
  title: string | null;
  startedAt: string | null;
  lastMessageAt: string | null;
  completeness: SessionCleanupBackupManifestEntry["completeness"];
  restorable: boolean;
  conflict: {
    hasConflict: boolean;
    reasons: string[];
  };
}

export interface SessionCleanupArchiveInspection {
  manifest: SessionCleanupBackupManifest;
  restorableEntries: SessionCleanupRestoreInspectionItem[];
}

export class SessionCleanupArchiveService {
  async writeArchive(input: SessionCleanupArchiveWriteInput): Promise<void> {
    const directory = path.dirname(input.archivePath);
    await mkdir(directory, { recursive: true });
    const source = Readable.from(this.iterArchiveLines(input.manifest), { encoding: "utf8" });
    const gzip = createGzip();
    const output = createWriteStream(input.archivePath);
    await pipeline(source, gzip, output);
  }

  async inspectArchive(archivePath: string): Promise<SessionCleanupArchiveInspection> {
    const manifest = await this.readManifest(archivePath);

    return {
      manifest,
      restorableEntries: manifest.entries.map((entry) => ({
        entryId: entry.entryId,
        candidateId: entry.candidateId,
        provider: entry.provider,
        title: entry.title,
        startedAt: entry.startedAt,
        lastMessageAt: entry.lastMessageAt,
        completeness: entry.completeness,
        restorable: entry.restorable,
        conflict: {
          hasConflict: false,
          reasons: []
        }
      }))
    };
  }

  async readManifest(archivePath: string): Promise<SessionCleanupBackupManifest> {
    const records = await this.readArchiveRecords(archivePath);
    const manifestRecord = records.find((record): record is SessionCleanupArchiveManifestRecord => record.type === "manifest");

    if (!manifestRecord) {
      throw createArchiveError("备份清单损坏或格式不支持", new Error("archive_manifest_missing"));
    }

    return manifestRecord.manifest;
  }

  async readArchiveEntryFile(archivePath: string, relativePath: string): Promise<Buffer | null> {
    const records = await this.readArchiveRecords(archivePath);
    const fileRecord = records.find((record): record is SessionCleanupArchiveFileRecord =>
      record.type === "file" && record.relativePath === relativePath
    ) ?? null;

    return fileRecord ? Buffer.from(fileRecord.content, "base64") : null;
  }

  private async readArchiveRecords(archivePath: string): Promise<SessionCleanupArchiveRecord[]> {
    await assertArchiveReadable(archivePath);

    let compressedSize: number;

    try {
      compressedSize = (await stat(archivePath)).size;
    } catch (error) {
      throw createArchiveError("备份文件读取失败", error);
    }

    if (compressedSize > MAX_ARCHIVE_COMPRESSED_BYTES) {
      throw createArchiveError("备份文件超过允许的压缩大小", new Error("archive_compressed_size_limit"));
    }

    try {
      const records: SessionCleanupArchiveRecord[] = [];
      let decompressedBytes = 0;
      const input = createReadStream(archivePath).pipe(createGunzip());
      const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        const text = String(line).trim();
        if (!text) continue;
        const lineBytes = Buffer.byteLength(text, "utf8");
        decompressedBytes += lineBytes;
        if (lineBytes > MAX_ARCHIVE_LINE_BYTES || decompressedBytes > MAX_ARCHIVE_DECOMPRESSED_BYTES) {
          lines.close();
          input.destroy();
          throw new Error("archive_decompressed_size_limit");
        }
        if (records.length >= MAX_ARCHIVE_RECORDS) {
          lines.close();
          input.destroy();
          throw new Error("archive_record_count_limit");
        }
        records.push(JSON.parse(text) as SessionCleanupArchiveRecord);
      }

      if (records.length === 0) {
        throw new Error("archive_bundle_empty");
      }

      return records;
    } catch (error) {
      throw createArchiveError("备份清单损坏或格式不支持", error);
    }
  }

  private async *iterArchiveLines(manifest: SessionCleanupBackupManifest): AsyncGenerator<string> {
    yield `${serializeArchiveRecord({
      type: "manifest",
      manifest
    })}\n`;

    for (const entry of manifest.entries) {
      for (const file of entry.files) {
        if (file.status !== "included") {
          continue;
        }

        const fileStats = await stat(file.filePath);
        if (fileStats.size > MAX_ARCHIVE_DECOMPRESSED_BYTES) {
          throw new Error("archive_entry_file_size_limit");
        }
        const content = await readFile(file.filePath);
        yield `${serializeArchiveRecord({
          type: "file",
          relativePath: file.relativePath,
          encoding: "base64",
          content: content.toString("base64")
        })}\n`;
      }
    }
  }
}

async function assertArchiveReadable(archivePath: string): Promise<void> {
  try {
    const record = await stat(archivePath);

    if (!record.isFile()) {
      throw new Error("archive_not_file");
    }
  } catch (error) {
    throw createArchiveError("备份文件不存在", error);
  }
}

function serializeArchiveRecord(record: SessionCleanupArchiveRecord): string {
  return JSON.stringify(record);
}

function createArchiveError(detail: string, cause: unknown): AppError {
  return new AppError({
    statusCode: 400,
    errorCode: "cleanup_backup_manifest_invalid",
    detail,
    data: {
      cause: cause instanceof Error ? cause.message : String(cause)
    }
  });
}
