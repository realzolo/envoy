"use client";
import { Radio,Select,Space,Typography } from "@arco-design/web-react";
import { type Row,value } from "@/components/admin-console-shared";
export type RoutingServiceScope = { mode: "all" | "selected"; serviceIds: string[] };
export function ServiceScopeEditor({ services, value: scope = {mode:"all",serviceIds:[]}, onChange }: {
  services: Row[]; value?: RoutingServiceScope; onChange?: (scope: RoutingServiceScope) => void;
}) {
  return <Space direction="vertical" style={{width:"100%"}}>
    <Radio.Group value={scope.mode} options={[{value:"all",label:"All services"},{value:"selected",label:"Selected services"}]}
      onChange={mode => onChange?.({mode,serviceIds:mode === "all" ? [] : scope.serviceIds})} />
    {scope.mode === "all" && <Typography.Text type="secondary">Includes current and future services. Domain permissions apply separately.</Typography.Text>}
    {scope.mode === "selected" && <Select mode="multiple" showSearch allowClear placeholder="Search and select services"
      value={scope.serviceIds} options={services.map(service=>({value:value(service,"id"),label:`${value(service,"name")}${service.status === "suspended" ? " (paused)" : ""}`}))}
      onChange={(ids:string[])=>onChange?.({mode:"selected",serviceIds:ids})} />}
  </Space>;
}
