import { describe, expect, it, vi } from 'vitest';
import { cardState, cardStateRequestSchema, type CardStateRequest, type CardStateResult } from '../shared/card-state';
import { cardSchema, emptyLibrary, type Library } from '../shared/model';
import { CardStateQueue, overlayCardStates, type StateSaveSnapshot } from '../src/card-state-actions';

function fixture() {
  const library = { ...emptyLibrary(), revision: 4 };
  library.cards = ['a', 'b'].map(id => cardSchema.parse({ id, project_id: 'bank', title: id, question: '问题', answer_md: '保留原答案', summary_md: '保留原提纲' }));
  return library;
}
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(send: (id: string, input: CardStateRequest) => Promise<CardStateResult>) {
  let library: Library | null = fixture(), context = 0;
  let snapshot: StateSaveSnapshot = { pending: [], failed: [], retrying: false };
  const errors = vi.fn(), reload = vi.fn(async () => library!);
  const queue = new CardStateQueue({ getLibrary: () => library, getContext: () => context, onLibrary: value => { library = value; }, onChange: value => { snapshot = value; }, onError: errors, send, reload });
  return { queue, errors, reload, get library() { return library!; }, set library(value) { library = value; }, get snapshot() { return snapshot; }, get visible() { return overlayCardStates(library, snapshot.pending)!; }, nextContext: () => { context++; } };
}
const success = (library: Library, id: string, input: CardStateRequest): CardStateResult => ({ revision: input.expected_revision + 1, card: { ...cardState(library.cards.find(card => card.id === id)!), ...input.patch, revision: input.card_revision, updated_at: '2026-10-20T12:00:00Z' } });

describe('小型卡片状态契约', () => {
  it('只允许显式状态和两个版本号，拒绝答案、空修改和伪造归属', () => {
    expect(cardStateRequestSchema.parse({ expected_revision: 0, card_revision: 1, patch: { mastery: 'mastered' } }).patch).toEqual({ mastery: 'mastered' });
    for (const patch of [{}, { answer_md: '覆盖答案' }, { mastery: 'unknown' }, { favorite: 'true' }]) expect(() => cardStateRequestSchema.parse({ expected_revision: 0, card_revision: 1, patch })).toThrow();
    expect(() => cardStateRequestSchema.parse({ expected_revision: 0, card_revision: 1, user_id: 'other', patch: { important: true } })).toThrow();
  });
});

describe('立即反馈和后台保存队列', () => {
  it('请求未完成时已显示新状态，连续题目按服务端确认的版本串行保存', async () => {
    const first = deferred<CardStateResult>(), second = deferred<CardStateResult>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const app = setup(send), original = app.library;
    app.queue.enqueue('a', { mastery: 'mastered' }); app.queue.enqueue('b', { mastery: 'mastered' });
    expect(app.visible.cards.map(card => card.mastery)).toEqual(['mastered', 'mastered']);
    expect(app.library).toBe(original); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ expected_revision: 4, card_revision: 1, patch: { mastery: 'mastered' } });
    first.resolve(success(app.library, 'a', send.mock.calls[0][1]));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1].expected_revision).toBe(5);
    second.resolve(success(app.library, 'b', send.mock.calls[1][1]));
    await vi.waitFor(() => expect(app.snapshot.pending).toHaveLength(0));
    expect(app.library.revision).toBe(6); expect(app.library.cards.every(card => card.mastery === 'mastered')).toBe(true);
    expect(app.library.sources).toBe(original.sources); expect(app.library.revisions).toBe(original.revisions);
    expect(app.library.cards[0].answer_md).toBe('保留原答案'); expect(app.reload).not.toHaveBeenCalled();
  });
  it('同题保存中反向修改保持最后的选择，旧响应不会闪回旧状态', async () => {
    const first = deferred<CardStateResult>(), last = deferred<CardStateResult>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise), app = setup(send);
    app.queue.enqueue('a', { mastery: 'mastered' }); app.queue.enqueue('a', { mastery: 'review', important: true });
    first.resolve(success(app.library, 'a', send.mock.calls[0][1]));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(app.visible.cards[0]).toMatchObject({ mastery: 'review', important: true });
    last.resolve(success(app.library, 'a', send.mock.calls[1][1]));
    await vi.waitFor(() => expect(app.queue.hasPending).toBe(false));
    expect(app.library.cards[0]).toMatchObject({ mastery: 'review', important: true });
  });
  it('重复点击已确认状态不请求', async () => {
    const result = deferred<CardStateResult>(), send = vi.fn().mockReturnValue(result.promise), app = setup(send);
    app.queue.enqueue('a', { mastery: 'review' }); expect(send).not.toHaveBeenCalled();
    app.queue.enqueue('a', { mastery: 'mastered' }); app.queue.enqueue('a', { mastery: 'mastered' }); result.resolve(success(app.library, 'a', send.mock.calls[0][1]));
    await vi.waitFor(() => expect(app.queue.hasPending).toBe(false));
    app.queue.enqueue('a', { mastery: 'mastered' }); expect(send).toHaveBeenCalledTimes(1);
  });
  it('失败回退显示并保留所有未保存意图；仅显式重试才刷新和再次提交', async () => {
    const first = deferred<CardStateResult>(), send = vi.fn().mockReturnValueOnce(first.promise), app = setup(send);
    app.queue.enqueue('a', { mastery: 'mastered' }); app.queue.enqueue('b', { favorite: true }); first.reject(new Error('网络中断'));
    await vi.waitFor(() => expect(app.snapshot.failed).toHaveLength(2));
    expect(app.visible.cards[0].mastery).toBe('review'); expect(app.snapshot.pending).toHaveLength(0); expect(app.reload).not.toHaveBeenCalled();
    const fresh = fixture(); fresh.revision = 17; fresh.cards[0].answer_md = '其他页面更新的答案'; fresh.cards[0].revision = 3; app.reload.mockResolvedValueOnce(fresh);
    send.mockImplementation(async (id, input) => success(app.library, id, input));
    await app.queue.retry(); await vi.waitFor(() => expect(app.queue.hasPending).toBe(false));
    expect(send.mock.calls[1][1]).toMatchObject({ expected_revision: 17, card_revision: 3, patch: { mastery: 'mastered' } });
    expect(app.library.cards[0]).toMatchObject({ mastery: 'mastered', answer_md: '其他页面更新的答案' }); expect(app.library.cards[1].favorite).toBe(true); expect(app.snapshot.failed).toHaveLength(0);
  });
  it('重试不会重建其他页面已删除的卡片', async () => {
    const send = vi.fn().mockRejectedValue(new Error('失败')), app = setup(send); app.queue.enqueue('a', { mastery: 'mastered' });
    await vi.waitFor(() => expect(app.snapshot.failed).toHaveLength(1));
    const fresh = fixture(); fresh.cards = fresh.cards.filter(card => card.id !== 'a'); app.reload.mockResolvedValueOnce(fresh);
    await app.queue.retry(); expect(send).toHaveBeenCalledTimes(1); expect(app.library.cards.map(card => card.id)).toEqual(['b']);
  });
  it('账户切换会丢弃旧响应，新的账户无需等待旧请求', async () => {
    const old = deferred<CardStateResult>(), next = deferred<CardStateResult>(), send = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise), app = setup(send);
    app.queue.enqueue('a', { mastery: 'mastered' }); const oldReply = success(app.library, 'a', send.mock.calls[0][1]);
    app.nextContext(); app.queue.reset(); const another = fixture(); another.revision = 30; app.library = another;
    app.queue.enqueue('b', { favorite: true }); expect(send).toHaveBeenCalledTimes(2);
    old.resolve(oldReply); await Promise.resolve(); await Promise.resolve(); expect(app.library.revision).toBe(30); expect(app.visible.cards[0].mastery).toBe('review');
    next.resolve(success(app.library, 'b', send.mock.calls[1][1])); await vi.waitFor(() => expect(app.queue.hasPending).toBe(false));
    expect(app.library.revision).toBe(31); expect(app.library.cards[1].favorite).toBe(true); expect(app.errors).not.toHaveBeenCalled();
  });
  it('其他整库响应插入保存窗口时不覆盖，失败提示要求重新核对', async () => {
    const pending = deferred<CardStateResult>(), send = vi.fn().mockReturnValue(pending.promise), app = setup(send);
    app.queue.enqueue('a', { important: true }); const result = success(app.library, 'a', send.mock.calls[0][1]);
    app.library = { ...fixture(), revision: 12 }; pending.resolve(result);
    await vi.waitFor(() => expect(app.snapshot.failed).toHaveLength(1)); expect(app.library.revision).toBe(12); expect(app.library.cards[0].important).toBe(false);
  });
});
