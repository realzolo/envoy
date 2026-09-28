"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Avatar, Badge, Button, Drawer, Layout, Menu } from "@arco-design/web-react";
import {
  IconBook,
  IconBranch,
  IconCloud,
  IconDashboard,
  IconFile,
  IconLiveBroadcast,
  IconLock,
  IconMenu,
  IconMessage,
  IconMessageBanned,
  IconPublic,
  IconSend,
  IconSettings,
} from "@arco-design/web-react/icon";
import { type ReactNode, useEffect, useState } from "react";
import { EnvoyLogo } from "@/components/envoy-logo";
import { LogoutButton } from "@/components/session-actions";

const navigation = [
  {
    label: "",
    items: [
      { href: "/", label: "Overview", icon: IconDashboard },
      { href: "/emails", label: "Messages", icon: IconMessage },
      { href: "/inbound", label: "Inbound", icon: IconBook },
    ],
  },
  {
    label: "DELIVERY",
    items: [{ href: "/senders", label: "Sender Profiles", icon: IconSend }],
  },
  {
    label: "INFRASTRUCTURE",
    items: [
      { href: "/providers", label: "Provider Accounts", icon: IconCloud },
      { href: "/domains", label: "Sending Domains", icon: IconPublic },
      { href: "/routing", label: "Routing", icon: IconBranch },
      { href: "/events", label: "Provider Events", icon: IconLiveBroadcast },
    ],
  },
  {
    label: "DEVELOPER",
    items: [
      { href: "/api-keys", label: "Service Credentials", icon: IconLock },
      { href: "/webhooks", label: "Callbacks", icon: IconSettings },
      { href: "/suppressions", label: "Suppressions", icon: IconMessageBanned },
      { href: "/logs", label: "Audit Log", icon: IconFile },
    ],
  },
];

function SidebarContent({ onNavigate, email }: { onNavigate?: () => void; email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeKey = navigation.flatMap((group) => group.items).find((item) => (
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  ))?.href;

  return (
    <div className="sidebar-content">
      <div className="brand-bar">
        <Link href="/" onClick={onNavigate}><EnvoyLogo /></Link>
      </div>
      <nav className="app-menu" aria-label="Main navigation">
        <Menu
          mode="vertical"
          selectedKeys={activeKey ? [activeKey] : []}
          onClickMenuItem={(key) => {
            onNavigate?.();
            router.push(key);
          }}
        >
          {navigation.map((group) => {
            const items = group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Menu.Item key={item.href}>
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Menu.Item>
              );
            });

            return group.label ? (
              <Menu.ItemGroup key={group.label} title={group.label}>
                {items}
              </Menu.ItemGroup>
            ) : items;
          })}
        </Menu>
      </nav>
      <div className="user-panel">
        <Avatar size={30} className="workspace-avatar">{email.slice(0, 2).toUpperCase()}</Avatar>
        <div className="user-copy">
          <strong>Administrator</strong>
          <span>{email}</span>
        </div>
        <LogoutButton />
      </div>
    </div>
  );
}

export function AppShell({ children, email }: { children: ReactNode; email: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (active) setHealthy(response.ok);
      } catch {
        if (active) setHealthy(false);
      }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const healthStatus = healthy === null ? "default" : healthy ? "success" : "error";
  const healthText = healthy === null ? "Checking API" : healthy ? "API healthy" : "API degraded";

  return (
    <>
      <Layout className="app-shell" hasSider>
        <Layout.Sider className="app-sider" theme="light">
          <SidebarContent email={email} />
        </Layout.Sider>
        <Layout className="app-body">
          <Layout.Header className="app-topbar">
            <Button
              className="mobile-trigger"
              type="text"
              shape="circle"
              icon={<IconMenu />}
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            />
            <span className="topbar-label">Email delivery control plane</span>
            <Badge className="health" status={healthStatus} text={healthText} />
          </Layout.Header>
          <Layout.Content className="app-content">{children}</Layout.Content>
        </Layout>
      </Layout>
      <Drawer
        bodyStyle={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 0 }}
        className="mobile-drawer"
        placement="left"
        width={280}
        visible={mobileOpen}
        footer={null}
        closable={false}
        onCancel={() => setMobileOpen(false)}
      >
        <SidebarContent email={email} onNavigate={() => setMobileOpen(false)} />
      </Drawer>
    </>
  );
}
