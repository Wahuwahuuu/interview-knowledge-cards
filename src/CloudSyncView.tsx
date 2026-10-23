import { useEffect, useState } from 'react';
import { Cloud, Copy, RefreshCw } from 'lucide-react';
import type { CloudSyncStatus } from '../shared/cloud-sync';
import { api } from './api';
import { runtimeMode } from './local-replica';
import { ConfirmationDialog } from './ConfirmationDialog';
import { Markdown } from './Markdown';
import './cloud-sync.css';

const labels:Record<string,string>={question:'问题',title:'标题',summary_md:'面试口述版',answer_md:'完整答案',mastery:'掌握状态',favorite:'收藏',important:'重点',record:'记录版本',delete:'删除与编辑',deleted:'删除与编辑',references:'关联记录'};
function readable(value:unknown):string {
  if(value===null||value===undefined)return '（此端没有这条内容）';
  if(typeof value==='boolean')return value?'是':'否';
  if(typeof value==='string')return value==='mastered'?'已掌握':value==='review'?'待复习':value;
  if(Array.isArray(value))return value.map(readable).join('、');
  if(typeof value==='object'){const v=value as Record<string,unknown>;return ['question','name','summary_md','answer_md','mastery'].filter(k=>v[k]!==undefined).map(k=>`**${labels[k]??'名称'}**\n\n${readable(v[k])}`).join('\n\n')||'相关记录的内容不同，请先调整题目或关系后重新检查。';}
  return String(value);
}
const statusText:Record<CloudSyncStatus['phase'],string>={unlinked:'尚未连接网站',review:'请核对首次合并的题库',paused:'自动同步已暂停',syncing:'正在与网站同步…',idle:'已与网站同步',pending:'本地已保存，等待同步',error:'本地已保存，网站同步暂未完成',conflict:'两边有不同修改，需要处理',recovery:'题库已恢复，需要重新核对'};

export function CloudSyncView({notify}:{notify:(text:string)=>void}) {
  const desktop=runtimeMode()==='desktop';
  const [state,setState]=useState<CloudSyncStatus>(),[devices,setDevices]=useState<{id:string;name:string;last_seen:string}[]>([]);
  const [site,setSite]=useState(''),[code,setCode]=useState(''),[name,setName]=useState('我的 Windows 电脑'),[proxy,setProxy]=useState('');
  const [issued,setIssued]=useState<{code:string;expires:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [confirmation,setConfirmation]=useState<{title:string;description:string;run:()=>Promise<void>}>();
  async function refresh(){if(desktop)setState(await api<CloudSyncStatus>('/desktop/cloud-sync'));else setDevices((await api<{devices:typeof devices}>('/device-sync/devices')).devices);}
  useEffect(()=>{let alive=true;const load=async()=>{try{if(desktop){const next=await api<CloudSyncStatus>('/desktop/cloud-sync');if(alive)setState(next);}else{const next=await api<{devices:typeof devices}>('/device-sync/devices');if(alive)setDevices(next.devices);}}catch(e){if(alive)setError(e instanceof Error?e.message:'同步状态读取未完成');}};void load();const timer=setInterval(()=>void load(),5000);return()=>{alive=false;clearInterval(timer);};},[desktop]);
  async function run(task:()=>Promise<void>){setBusy(true);setError('');try{await task();}catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{setBusy(false);}}
  async function action(path:string,body:unknown={}){setState(await api<CloudSyncStatus>('/desktop/cloud-sync/'+path,{method:'POST',body:JSON.stringify(body)}));}
  return <section className="cloud-sync-panel" data-update-blocked={busy||(!state?.connected&&Boolean(code||site||proxy))?'true':undefined}>
    <h3><Cloud size={20}/>网站与客户端同步</h3>
    <p className="muted">手机在网站修改，电脑联网时自动接收；电脑本地修改也会自动上传。两边不需要连接同一个 Wi-Fi。</p>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {!desktop?<>
      <p>在这台电脑的客户端连接当前网站账号。连接码五分钟有效，只能使用一次；请只交给自己的客户端。</p>
      <button className="primary" disabled={busy} onClick={()=>void run(async()=>{setIssued(await api('/device-sync/code',{method:'POST',body:'{}'}));})}>生成电脑连接码</button>
      {issued&&<div className="website-link-code"><label>连接码<input readOnly aria-label="电脑连接码" value={issued.code}/></label><button className="secondary" onClick={()=>void run(async()=>{await navigator.clipboard.writeText(issued.code);notify('连接码已复制，请粘贴到电脑客户端');})}><Copy size={15}/>复制连接码</button><small>有效至 {new Date(issued.expires).toLocaleTimeString('zh-CN')}。客户端还需填写本网站地址。</small></div>}
      <h4>已连接的客户端</h4>{!devices.length?<p className="muted">还没有客户端连接这个账号。</p>:<div className="record-list">{devices.map(device=><div key={device.id}><span>{device.name}<small>最近同步：{new Date(device.last_seen).toLocaleString('zh-CN')}</small></span><button className="text-button delete-action" disabled={busy} onClick={()=>setConfirmation({title:`撤销「${device.name}」的同步权限？`,description:'客户端保留已有本地题库，不能继续访问这个网站账号；需要重新生成连接码才能恢复同步。',run:async()=>{await api('/device-sync/revoke',{method:'POST',body:JSON.stringify({id:device.id,confirmed:true})});await refresh();}})}>撤销连接</button></div>)}</div>}
    </>:!state?<p className="muted">正在读取连接状态…</p>:!state.connected?<form onSubmit={event=>{event.preventDefault();void run(async()=>{await action('connect',{site,code,name,proxy:proxy||undefined});setCode('');});}}>
      <p>先在网站的「设置 → 网站同步」生成连接码，再填写下面的内容。读取后会显示网站账号和题库数量，确认前不会合并题库。</p>
      <label>网站地址<input type="url" required autoComplete="off" placeholder="https://你的网站地址" value={site} onChange={e=>setSite(e.target.value)}/></label>
      <label>电脑连接码<input required autoComplete="off" spellCheck={false} placeholder="粘贴网站生成的连接码" value={code} onChange={e=>setCode(e.target.value)}/></label>
      <label>这台电脑的名称<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
      <details><summary>网络设置（可选）</summary><p className="muted">电脑访问网站需要代理时，填写已经运行的本机 HTTP 代理地址；不需要时留空。</p><label>本机代理地址<input type="url" placeholder="http://127.0.0.1:7897" value={proxy} onChange={e=>setProxy(e.target.value)}/></label></details>
      <button className="primary" disabled={busy}>{busy?'正在读取网站题库…':'读取网站题库'}</button>
    </form>:<>
      <div className="cloud-sync-summary"><strong role="status">{statusText[state.phase]}</strong><p>网站账号：{state.account?.display_name}（{state.account?.email}）</p><a href={state.site+'/?settings=website-sync'} target="_blank" rel="noreferrer">打开网站设置</a>{state.incremental&&<p className="microcopy">增量同步已启用：平时只同步发生变化的记录。</p>}{state.lastSync&&<p className="microcopy">上次同步：{new Date(state.lastSync).toLocaleString('zh-CN')}</p>}</div>
      {state.error&&<p className="notice warning">{state.error}</p>}{state.phase==='recovery'&&<button className="secondary" disabled={busy} onClick={()=>setConfirmation({title:'重新核对恢复后的两边题库？',description:'保留现有连接配置，先备份本机，再读取完整题库重新核对。未上传的本地修改会参与合并；不同版本保留双方，核对后还需确认开启同步。',run:()=>action('review-restore',{confirmed:true})})}>重新核对题库</button>}
      <details><summary>网络设置</summary><p className="muted">当前代理：{state.proxy??'直接连接网站'}。需要变更时填写下面的本机 HTTP 代理地址，留空表示直接连接。</p><form onSubmit={e=>{e.preventDefault();void run(()=>action('network',{proxy:proxy||undefined}));}}><label>本机代理地址<input type="url" placeholder="http://127.0.0.1:7897" value={proxy} onChange={e=>setProxy(e.target.value)}/></label><button className="secondary" disabled={busy}>保存网络设置</button></form></details>
      {state.phase==='review'?<div className="cloud-first-review"><p>本机有 <strong>{state.localCards}</strong> 张在用卡片，网站有 <strong>{state.remoteCards}</strong> 张。首次合并保留两边独有内容；不同版本会提示选择。开始前会自动备份本地题库。</p><button className="primary" disabled={busy} onClick={()=>void run(()=>action('enable',{confirmed:true}))}>确认合并并开启自动同步</button></div>:<div className="button-row"><button className="primary" disabled={busy||state.phase==='syncing'||state.phase==='recovery'} onClick={()=>void run(()=>action(state.enabled?'now':'enable',state.enabled?{}:{confirmed:true}))}><RefreshCw size={16}/>{state.enabled?'立即同步':'继续自动同步'}</button>{state.enabled&&<button className="secondary" disabled={busy} onClick={()=>void run(()=>action('pause'))}>暂停自动同步</button>}</div>}
      {!!state.conflicts?.length&&<div className="cloud-conflicts"><h4>核对两边的修改</h4><p className="muted">下面同时保留网站与本地内容。选择按钮对本批全部冲突生效；也可先在卡片编辑中调整，再重新检查。</p>{state.conflicts.map((item,index)=><div className="cloud-conflict" key={index}>{item.label&&<h5>{item.label}</h5>}<strong>{labels[item.field]??'内容冲突'}</strong><div className="cloud-conflict-versions"><div><h5>网站版本</h5><Markdown text={readable(item.computer)}/></div><div><h5>本地版本</h5><Markdown text={readable(item.phone)}/></div></div></div>)}<div className="button-row">{(['remote','local'] as const).map(choice=><button className="secondary" key={choice} disabled={busy} onClick={()=>setConfirmation({title:choice==='remote'?'全部采用网站版本？':'全部保留本地版本？',description:'这会处理当前显示的全部冲突；两端已有历史和本地备份仍保留。确认前请核对问题与答案。',run:()=>action('resolve',{choice,confirmed:true})})}>{choice==='remote'?'全部采用网站版本':'全部保留本地版本'}</button>)}<button className="text-button" disabled={busy} onClick={()=>void run(()=>action('recheck'))}>重新检查</button></div></div>}
      <button className="text-button delete-action cloud-unlink" disabled={busy||state.phase==='syncing'} onClick={()=>setConfirmation({title:'解除这个网站连接？',description:'本地与网站题库都保留，尚未上传的修改仍在本机。解除后不再自动同步，重新连接时需要再次核对合并。',run:()=>action('disconnect',{confirmed:true})})}>解除连接</button>
    </>}
    {confirmation&&<ConfirmationDialog title={confirmation.title} description={confirmation.description} busy={busy} error={error} confirmLabel="确认" onCancel={()=>setConfirmation(undefined)} onConfirm={()=>void run(async()=>{await confirmation.run();setConfirmation(undefined);})}/>}
  </section>;
}

export function DesktopCloudBadge({onOpen}:{onOpen:()=>void}) {
  const [state,setState]=useState<CloudSyncStatus>();
  useEffect(()=>{let alive=true;const load=async()=>{try{const value=await api<CloudSyncStatus>('/desktop/cloud-sync');if(alive)setState(value);}catch{/* Local browsing remains available. */}};void load();const timer=setInterval(()=>void load(),5000);return()=>{alive=false;clearInterval(timer);};},[]);
  if(!state?.connected)return null;
  return <button className="sync-badge" onClick={onOpen}><Cloud size={15}/>{statusText[state.phase]}</button>;
}
