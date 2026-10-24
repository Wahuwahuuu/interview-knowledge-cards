import type { Library } from '../shared/model';
import type { CloudDelta } from '../shared/cloud-sync';
import { applyLibraryDelta } from '../shared/apply-delta';
import { ApiError, api, loadLibrary } from './api';

export type MutationReply = { delta: CloudDelta };
export function deltaPath(path:string,cursor:number){return path+(path.includes('?')?'&':'?')+'response=delta&cursor='+cursor;}

/** Bring the existing page forward by complete journal transactions, including lost acknowledgements. */
export async function applyMutationReply(library:Library,result:unknown):Promise<Library>{
  // The paired offline adapter already has its durable in-memory library.
  if(result&&typeof result==='object'&&'schema_version' in result)return result as Library;
  if(result&&typeof result==='object'&&'library' in result)return (result as {library:Library}).library;
  let page=(result as MutationReply)?.delta,next=library;
  for(;;){
    if(!page||!Number.isSafeInteger(page.cursor)||page.cursor<next.revision||page.cursor>page.revision||page.hasMore&&page.cursor===next.revision)throw new ApiError('增量保存结果不完整，请保留输入并重试',502,'INVALID_DELTA');
    next=applyLibraryDelta(next,page);
    if(!page.hasMore)return next;
    page=await api<CloudDelta>(`/library/changes?cursor=${next.revision}&epoch=${encodeURIComponent(page.epoch)}`);
  }
}
export async function refreshChangedRecords(library:Library){try{const delta=await api<CloudDelta>('/library/changes?cursor='+library.revision);return await applyMutationReply(library,{delta});}catch(error){if(error instanceof ApiError&&['SYNC_INITIALIZATION_REQUIRED','CLOUD_EPOCH_CHANGED','INVALID_SYNC_CURSOR'].includes(error.code))return loadLibrary();throw error;}}
export async function mutateLibrary(library:Library,path:string,init:RequestInit){return applyMutationReply(library,await api(deltaPath(path,library.revision),init));}
