export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface RuntimeConfig {
  rootDir: string;
  indexDir: string;
  dbPath: string;
  exportDir: string;
  configFilePath: string | null;
  watchDebounceMs: number;
  parserTimeoutMs: number;
  /** 单个文件允许交给解析器读取的最大字节数，避免大文件把 helper 撑爆。 */
  maxParserFileBytes?: number;
  disabledParserExtensions: string[];
  allowedExtensions: string[];
  includedHiddenPaths: string[];
  writeBatchSize: number;
  maxIndexConcurrency: number;
  logLevel: LogLevel;
}
