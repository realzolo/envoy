"use client";
import { useEffect,useRef,useState } from "react";
import { Alert,Button,Space,Spin,Typography } from "@arco-design/web-react";
import type { ReadingSession } from "@/modules/mail-reader/contracts";
import styles from "./mail-views.module.css";
const RENEW_BEFORE_MS=30_000;
export function HostedMailReader({kind,id}:{kind:"INBOUND"|"OUTBOUND";id:string}) {
 return <ReaderFrame key={`${kind}:${id}`} kind={kind} id={id}/>;
}
function ReaderFrame({kind,id}:{kind:"INBOUND"|"OUTBOUND";id:string}) {
 const frame=useRef<HTMLIFrameElement>(null),current=useRef<ReadingSession|null>(null);
 const [statistics,setStatistics]=useState<{total:number;ready:number;active:number;failed:number}|null>(null);
 const [url,setUrl]=useState<string|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0),[height,setHeight]=useState(640);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  current.current=null;
  const load=async()=>{
   try{
    const response=await fetch(`/api/admin/${kind==="INBOUND"?"inbound":"deliveries"}/${encodeURIComponent(id)}/reading-session`,{method:"POST",credentials:"same-origin",cache:"no-store",signal:controller.signal});
    if(controller.signal.aborted)return;
    if(!response.ok){
      if([401,403,404,410].includes(response.status)){setUrl(null);current.current=null;setError(true);return;}
      throw new Error("Reader unavailable");
    }
    const descriptor=await response.json() as ReadingSession;if(controller.signal.aborted)return;
    const prior=current.current;current.current=descriptor;
    if(prior?.documentRevision===descriptor.documentRevision&&frame.current?.contentWindow)frame.current.contentWindow.postMessage({type:"envoy:mail-reader:renew",channelId:prior.channelId,session:descriptor},"*");else setUrl(descriptor.url);
    setError(false);timer=setTimeout(()=>void load(),Math.max(1000,Date.parse(descriptor.expiresAt)-Date.now()-RENEW_BEFORE_MS));
   }catch{if(!controller.signal.aborted){setError(true);timer=setTimeout(()=>void load(),10_000);}}
  };
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.current?.contentWindow||!current.current||event.data?.channelId!==current.current.channelId)return;
   if(event.data.type==="envoy:mail-reader:layout"&&Number.isFinite(event.data.height))setHeight(Math.max(100,Math.min(200_000,event.data.height)));
   if(event.data.type==="envoy:mail-reader:expired"){if(timer)clearTimeout(timer);void load();}
   if(event.data.type==="envoy:mail-reader:ready"&&[event.data.total,event.data.ready,event.data.active,event.data.failed].every(value=>Number.isInteger(value)&&value>=0))setStatistics({total:event.data.total,ready:event.data.ready,active:event.data.active,failed:event.data.failed});
   if(event.data.type==="envoy:mail-reader:unavailable"){if(timer)clearTimeout(timer);current.current=null;setError(true);setUrl(null);}
  };
  addEventListener("message",receive);void load();
  return()=>{controller.abort();if(timer)clearTimeout(timer);removeEventListener("message",receive);current.current=null;};
 },[kind,id,attempt]);
 return <div className={styles.previewContent}>
  {error&&<Alert type="warning" content={<Space><span>Mail content is temporarily unavailable.</span><Button size="small" onClick={()=>setAttempt(value=>value+1)}>Retry</Button></Space>}/>}
  {statistics&&(statistics.active>0||statistics.failed>0)&&<Space wrap>
    <Typography.Text type="secondary">图片已加载 {statistics.ready}/{statistics.total}{statistics.active>0?`，${statistics.active} 张正在准备`:""}{statistics.failed>0?`，${statistics.failed} 张暂时无法取得`:""}</Typography.Text>
    {statistics.failed>0&&<Button size="small" onClick={()=>{const session=current.current;if(session)frame.current?.contentWindow?.postMessage({type:"envoy:mail-reader:retry",channelId:session.channelId,operationId:crypto.randomUUID()},"*");}}>重试图片</Button>}
  </Space>}
  {!url&&!error&&<Spin/>}
  {url&&<iframe ref={frame} title="Mail content" className={styles.previewFrame} style={{height}} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" src={url}/>}
 </div>;
}
