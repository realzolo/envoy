"use client";

import styles from "@/components/dashboard.module.css";
import { Alert,Badge,Button,Card,Collapse,Select,Space,Tag,Typography } from "@arco-design/web-react";
import { useState } from "react";

export type SetupChain = {
  id:string; service:string; category:string; sender:string;
  grant:boolean;credential:boolean;provider:boolean;identity:boolean;route:boolean;tested:boolean;observable:boolean;event_seen:boolean;
};
export type SetupState = { chains: SetupChain[] };

export function SetupChecklist({state}:{state:SetupState}) {
  const [selected,setSelected]=useState(state.chains[0]?.id);
  const chain=state.chains.find(row=>row.id===selected) ?? state.chains[0];
  const steps = [
    {title:"Service credential",done:chain?.credential,href:"/api-keys"},
    {title:"Sending permission",done:chain?.grant,href:"/api-keys"},
    {title:"Tested provider",done:chain?.provider,href:"/providers"},
    {title:"Verified domain",done:chain?.identity,href:"/domains"},
    {title:"Matching route",done:chain?.route,href:"/routing"},
    {title:"Test delivery accepted",done:chain?.tested,href:"/emails/compose"},
    {title:"Verified event received",done:chain?.observable && chain?.event_seen,href:"/events"}
  ];
  const next=steps.find(step=>!step.done);
  const ready=Boolean(chain?.credential && chain.grant && chain.provider && chain.identity && chain.route);
  const completed=steps.filter(step=>step.done).length;
  return <Card title="Outbound configuration" extra={<Tag color={ready ? "green":"orange"}>{ready ? "Send configuration ready":"Setup required"}</Tag>}>
    {chain ? <Space direction="vertical" size="medium" style={{width:"100%"}}>
      <div className={styles.readiness}>
        <Select aria-label="Service and domain authorization readiness" value={chain.id} onChange={setSelected} options={state.chains.map(row=>({value:row.id,label:`${row.service} / ${row.category} / ${row.sender}`}))}/>
        {next ? <Button href={next.href} type="primary">{next.title}</Button> : <Typography.Text type="success">All checks complete</Typography.Text>}
      </div>
      <Collapse bordered={false} style={{width:"100%"}}>
        <Collapse.Item name="checks" header={`${completed} of ${steps.length} checks complete`}>
          <Typography.Text type="secondary">Checks apply to outbound configuration for the selected service, sender, and category. Runtime authorization and capacity are checked on every submission. Inbound routes, received-mail evidence, and callback delivery are separate; a successful callback does not prove processing.</Typography.Text>
          <div className={styles.readinessSteps}>{steps.map(step=><div className={styles.readinessStep} key={step.title}><Badge status={step.done ? "success":"default"}/><Button href={step.href} type="text">{step.title}</Button></div>)}</div>
          {!chain.observable && <Alert style={{marginTop:16}} type="info" content="Configure provider webhook verification on a provider used by this route to observe delivery events."/>}
        </Collapse.Item>
      </Collapse>
    </Space> : <Space direction="vertical" size="medium" style={{width:"100%"}}>
      <Alert type="info" content="Connect a provider, verify a domain, then create a service credential and authorize its sender domain to start sending."/>
      <Space wrap><Button href="/providers" type="primary">Connect provider</Button><Button href="/domains">Domains</Button><Button href="/api-keys">Services</Button></Space>
    </Space>}
  </Card>
}
