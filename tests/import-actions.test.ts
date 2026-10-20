import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLibrary, type ImportBatch } from '../shared/model';
import { ApiError, api, loadLibrary } from '../src/api';
import { applyImportBatch, cancelImportBatch, refreshImportBatch } from '../src/import-actions';

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

describe('取消导入草稿', () => {
  it('只取消指定草稿，不提交导入或读取整库', async () => {
    const cancelled = batch({ status: 'cancelled' }); apiMock.mockResolvedValueOnce(cancelled);
    await expect(cancelImportBatch(batch())).resolves.toBe(cancelled);
    expect(apiMock).toHaveBeenCalledExactlyOnceWith('/imports/mysql-import/cancel', { method: 'POST', body: '{}' });
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'applied'] as const)('已结束的 %s 记录不会再次发起取消', async status => {
    const current = batch({ status }); await expect(cancelImportBatch(current)).resolves.toBe(current); expect(apiMock).not.toHaveBeenCalled();
  });
  it('另一页面已经导入时返回真实的已应用状态', async () => {
    const applied = batch({ status: 'applied' }); apiMock.mockResolvedValueOnce(applied);
    await expect(cancelImportBatch(batch())).resolves.toBe(applied);
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
  it('失败或仍是待确认时不误报取消成功', async () => {
    const error = new TypeError('Failed to fetch'); apiMock.mockRejectedValueOnce(error);
    await expect(cancelImportBatch(batch())).rejects.toBe(error);
    apiMock.mockResolvedValueOnce(batch()); await expect(cancelImportBatch(batch())).rejects.toThrow('取消状态尚未确认');
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
});

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
  it('重新预览时草稿被取消，读取最终状态且不重新生成草稿', async () => {
    const cancelled = batch({ status: 'cancelled' });
    apiMock.mockRejectedValueOnce(new ApiError('已取消', 409)).mockResolvedValueOnce(cancelled);
    await expect(refreshImportBatch(batch())).resolves.toBe(cancelled);
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual(['/imports/mysql-import/repreview', '/imports/mysql-import']);
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
    ['其他业务冲突', new ApiError('批次暂时锁定', 409, 'IMPORT_LOCKED')],
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

  it('确认时草稿已取消，只同步记录，不导入或读取整库', async () => {
    const cancelled = batch({ status: 'cancelled' });
    apiMock.mockRejectedValueOnce(new ApiError('导入已取消', 409, 'IMPORT_CANCELLED')).mockResolvedValueOnce(cancelled);
    await expect(applyImportBatch(batch())).resolves.toEqual({ kind: 'cancelled', batch: cancelled });
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual(['/imports/mysql-import/apply', '/imports/mysql-import']);
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
  it('版本冲突刷新期间取消也正确呈现终态，不自动再次确认', async () => {
    const cancelled = batch({ status: 'cancelled' });
    apiMock.mockRejectedValueOnce(new ApiError('题库更新', 409, 'REVISION_CONFLICT')).mockRejectedValueOnce(new ApiError('已取消', 409)).mockResolvedValueOnce(cancelled);
    await expect(applyImportBatch(batch())).resolves.toEqual({ kind: 'cancelled', batch: cancelled });
    expect(apiMock.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1);
    expect(loadLibraryMock).not.toHaveBeenCalled();
  });
});
