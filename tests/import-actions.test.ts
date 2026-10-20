import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLibrary, type ImportBatch } from '../shared/model';
import { ApiError, api, loadLibrary } from '../src/api';
import { applyImportBatch, refreshImportBatch } from '../src/import-actions';

vi.mock('../src/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, api: vi.fn(), loadLibrary: vi.fn() };
});

const apiMock = vi.mocked(api);
const loadLibraryMock = vi.mocked(loadLibrary);

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: 'mysql-import', status: 'pending', base_revision: 7,
    created_at: '2026-10-20T01:00:00.000Z', applied_at: null, mode: 'merge', preview: [],
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe('刷新导入预览', () => {
  it('待确认草稿按最新题库重新生成预览', async () => {
    const refreshed = batch({ base_revision: 8 });
    apiMock.mockResolvedValueOnce(refreshed);

    await expect(refreshImportBatch(batch())).resolves.toBe(refreshed);

    expect(apiMock).toHaveBeenCalledExactlyOnceWith('/imports/mysql-import/repreview', { method: 'POST', body: '{}' });
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });

  it.each(['applied', 'cancelled'] as const)('已结束的 %s 草稿只读取状态', async status => {
    const current = batch({ status });
    apiMock.mockResolvedValueOnce(current);

    await expect(refreshImportBatch(current)).resolves.toBe(current);

    expect(apiMock).toHaveBeenCalledExactlyOnceWith('/imports/mysql-import');
  });
});

describe('确认导入与过期预览处理', () => {
  it('使用审阅时的题库版本确认导入，并返回服务端正式入库结果', async () => {
    const applied = batch({ status: 'applied', applied_at: '2026-10-20T01:01:00.000Z' });
    const library = { ...emptyLibrary(), revision: 8 };
    apiMock.mockResolvedValueOnce({ batch: applied, library });

    await expect(applyImportBatch(batch())).resolves.toEqual({ kind: 'applied', batch: applied, library });

    expect(apiMock).toHaveBeenCalledExactlyOnceWith('/imports/mysql-import/apply', {
      method: 'POST', body: JSON.stringify({ expected_revision: 7 }),
    });
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });

  it('版本冲突后仅刷新预览，必须再次人工确认才会提交新版本', async () => {
    const refreshed = batch({ base_revision: 9 });
    const applied = batch({ ...refreshed, status: 'applied', applied_at: '2026-10-20T01:01:00.000Z' });
    const library = { ...emptyLibrary(), revision: 10 };
    apiMock
      .mockRejectedValueOnce(new ApiError('题库已更新', 409, 'REVISION_CONFLICT'))
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce({ batch: applied, library });

    await expect(applyImportBatch(batch())).resolves.toEqual({ kind: 'refreshed', batch: refreshed });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/imports/mysql-import/apply', '/imports/mysql-import/repreview',
    ]);
    expect(loadLibraryMock).not.toHaveBeenCalled();

    // A separate invocation represents the user's second confirmation.
    await expect(applyImportBatch(refreshed)).resolves.toEqual({ kind: 'applied', batch: applied, library });
    expect(apiMock).toHaveBeenNthCalledWith(3, '/imports/mysql-import/apply', {
      method: 'POST', body: JSON.stringify({ expected_revision: 9 }),
    });
  });

  it('其他页面已完成同一导入时，刷新正式题库并呈现成功，不重复应用', async () => {
    const applied = batch({ status: 'applied', applied_at: '2026-10-20T01:01:00.000Z' });
    const library = { ...emptyLibrary(), revision: 8 };
    apiMock
      .mockRejectedValueOnce(new ApiError('题库已更新', 409, 'REVISION_CONFLICT'))
      .mockResolvedValueOnce(applied);
    loadLibraryMock.mockResolvedValueOnce(library);

    await expect(applyImportBatch(batch())).resolves.toEqual({ kind: 'applied', batch: applied, library });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(loadLibraryMock).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ['其他业务冲突', new ApiError('导入已取消', 409, 'IMPORT_CANCELLED')],
    ['服务端错误', new ApiError('暂时不可用', 500, 'INTERNAL_ERROR')],
    ['非 409 的同名错误', new ApiError('暂时不可用', 500, 'REVISION_CONFLICT')],
    ['网络错误', new TypeError('Failed to fetch')],
    ['非 ApiError 对象', Object.assign(new Error('题库已更新'), { status: 409, code: 'REVISION_CONFLICT' })],
  ])('%s 保留原始错误，不刷新预览或误报成功', async (_label, error) => {
    apiMock.mockRejectedValueOnce(error);

    await expect(applyImportBatch(batch())).rejects.toBe(error);

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });

  it('重新生成预览失败时保留错误，不再次提交旧预览', async () => {
    const refreshError = new ApiError('预览无法生成', 422, 'INVALID_DATA');
    apiMock
      .mockRejectedValueOnce(new ApiError('题库已更新', 409, 'REVISION_CONFLICT'))
      .mockRejectedValueOnce(refreshError);

    await expect(applyImportBatch(batch())).rejects.toBe(refreshError);

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenLastCalledWith('/imports/mysql-import/repreview', { method: 'POST', body: '{}' });
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
});
