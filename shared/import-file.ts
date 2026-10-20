import { importSchema, librarySchema, prepareImport, validateLibrary, type ImportEnvelope, type Library } from './model';

export type ImportPage = 'import' | 'backup';
const backupArrays = ['projects', 'topics', 'cards', 'sources', 'occurrences', 'relations', 'revisions'] as const;
export const importFileLimit = 8 * 1024 * 1024;

export function validateMergeImport(value: unknown, library: Library): ImportEnvelope {
  const envelope = importSchema.parse(value);
  if (envelope.mode !== 'merge' || envelope.revisions.length) throw new Error('完整备份请到“备份与恢复”页面上传。');
  librarySchema.parse(prepareImport(library, envelope));
  return envelope;
}

export function parseImportFile(text: string, page: ImportPage, library: Library): ImportEnvelope {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON，请检查文件内容后重新上传。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件内容应是一个完整的 JSON 对象。');
  const raw = value as Record<string, unknown>;
  if (page === 'import') return validateMergeImport(raw, library);
  if (raw.mode !== 'restore' || raw.schema_version !== 1 || !Number.isInteger(raw.revision) || Number(raw.revision) < 0 || backupArrays.some(key => !Array.isArray(raw[key]))) {
    throw new Error('请选择“导出完整备份”下载的 JSON 文件。这个文件缺少完整备份信息，不能用于恢复。');
  }
  const snapshot = librarySchema.parse(raw);
  validateLibrary(snapshot);
  const envelope = importSchema.parse({ ...snapshot, mode: 'restore' });
  librarySchema.parse(prepareImport(library, envelope));
  return envelope;
}
