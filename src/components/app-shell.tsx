"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Drawer,
  Layout,
  Menu,
  Message,
  Popover,
  Space,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconBook,
  IconBranch,
  IconCloud,
  IconDashboard,
  IconFile,
  IconLiveBroadcast,
  IconLock,
  IconMenu,
  IconMenuFold,
  IconMenuUnfold,
  IconMessage,
  IconMessageBanned,
  IconPoweroff,
  IconPublic,
  IconRefresh,
  IconSend,
  IconSettings,
} from "@arco-design/web-react/icon";
import { type ReactNode, useEffect, useState } from "react";
import { EnvoyLogo } from "@/components/envoy-logo";
import styles from "./app-shell.module.css";

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
    label: "Delivery",
    items: [{ href: "/senders", label: "Senders", icon: IconSend }],
  },
  {
    label: "Infrastructure",
    items: [
      { href: "/providers", label: "Provider Accounts", icon: IconCloud },
      { href: "/domains", label: "Sending Domains", icon: IconPublic },
      { href: "/routing", label: "Routing", icon: IconBranch },
      { href: "/events", label: "Provider Events", icon: IconLiveBroadcast },
    ],
  },
  {
    label: "Developer",
    items: [
      { href: "/api-keys", label: "Service Credentials", icon: IconLock },
      { href: "/webhooks", label: "Callbacks", icon: IconSettings },
      { href: "/suppressions", label: "Suppressions", icon: IconMessageBanned },
      { href: "/logs", label: "Audit Log", icon: IconFile },
    ],
  },
];

function Navigation({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = navigation.flatMap(group => group.items).find(item => item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <nav className={styles.menu} aria-label="Main navigation">
      <Menu
        mode="vertical"
        collapse={collapsed}
        selectedKeys={active ? [active.href] : []}
        onClickMenuItem={key => { onNavigate?.(); router.push(key); }}
      >
        {navigation.flatMap(group => {
          const items = group.items.map(item => {
            const Icon = item.icon;
            return (
              <Menu.Item key={item.href} aria-label={item.label} aria-current={active?.href === item.href ? "page" : undefined} renderItemInTooltip={() => item.label}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </Menu.Item>
            );
          });
          return group.label && !collapsed ? <Menu.ItemGroup key={group.label} title={group.label}>{items}</Menu.ItemGroup> : items;
        })}
      </Menu>
    </nav>
  );
}

function LocationBreadcrumb() {
  const pathname = usePathname();
  const group = navigation.find(group => group.items.some(item => item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`)));
  const item = group?.items.find(item => item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`));
  const detail = item && pathname !== item.href;
  if (!group?.label && !detail) return null;
  return (
    <Breadcrumb className={styles.breadcrumb}>
      {group?.label && <Breadcrumb.Item key="group">{group.label}</Breadcrumb.Item>}
      <Breadcrumb.Item key="page">{detail ? <Link href={item.href}>{item.label}</Link> : item?.label ?? "Overview"}</Breadcrumb.Item>
      {detail && <Breadcrumb.Item key="detail">{pathname === "/emails/compose" ? "Compose message" : "Details"}</Breadcrumb.Item>}
    </Breadcrumb>
  );
}

export function AppShell({ children, email }: { children: ReactNode; email: string }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function checkHealth() {
    setCheckingHealth(true);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      setHealthy(response.ok);
    } catch { setHealthy(false); }
    finally { setCheckingHealth(false); setLastChecked(new Date()); }
  }

  useEffect(() => {
    let active = true;
    const check = async () => {
      setCheckingHealth(true);
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (active) { setHealthy(response.ok); setLastChecked(new Date()); }
      } catch {
        if (active) { setHealthy(false); setLastChecked(new Date()); }
      } finally { if (active) setCheckingHealth(false); }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Sign out failed. Please try again.");
      router.push("/login");
      router.refresh();
    } catch { Message.error("Sign out failed. Please try again."); setSigningOut(false); }
  }

  const healthStatus = healthy === null ? "default" : healthy ? "success" : "error";
  const healthText = healthy === null ? "Checking API" : healthy ? "API healthy" : "API degraded";

  return (
    <Layout className={`${styles.shell} ${collapsed ? styles.collapsed : ""}`}>
      <Layout.Header className={styles.header}>
        <div className={styles.headerLeft}>
          <Button className={styles.mobileTrigger} type="text" shape="circle" icon={<IconMenu />} aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} />
          <Link className={styles.brand} href="/" aria-label="Envoy overview"><EnvoyLogo /></Link>
        </div>
        <div className={styles.headerRight}>
          <Popover
            position="br"
            title="Service health"
            trigger="click"
            content={(
              <Space direction="vertical" size="small" className={styles.healthPanel}>
                <Badge status={healthStatus} text={healthText} />
                <Typography.Text>{healthy === null ? "Checking application dependencies." : healthy ? "The API and its required dependencies are responding." : "One or more required dependencies are unavailable."}</Typography.Text>
                <Typography.Text type="secondary">{lastChecked ? `Last checked ${lastChecked.toLocaleTimeString("en-US")}` : "Not checked yet"}</Typography.Text>
                <Button icon={<IconRefresh aria-hidden="true" />} loading={checkingHealth} onClick={() => void checkHealth()} size="small" type="secondary">Check again</Button>
              </Space>
            )}
          >
            <Button type="text" className={styles.healthTrigger} aria-label={healthText}>
              <Badge status={healthStatus} />
              <span className={styles.healthLabel}>{healthText}</span>
            </Button>
          </Popover>
          <Popover
            position="br"
            trigger="click"
            title="Administrator"
            content={(
              <Space direction="vertical" className={styles.accountPanel}>
                <Typography.Text>{email}</Typography.Text>
                <Button long icon={<IconPoweroff aria-hidden="true" />} loading={signingOut} onClick={() => void signOut()}>Sign out</Button>
              </Space>
            )}
          >
            <Button type="text" shape="circle" className={styles.accountTrigger} aria-label={`Account: ${email}`}>
              <Avatar size={32}>{email.slice(0, 2).toUpperCase()}</Avatar>
            </Button>
          </Popover>
        </div>
      </Layout.Header>
      <Layout className={styles.workspace}>
        <Layout.Sider className={styles.sider} width={220} collapsedWidth={48} collapsed={collapsed} collapsible trigger={null} theme="light">
          <div className={styles.siderContent}>
            <Navigation collapsed={collapsed} />
            <div className={styles.siderFooter}>
              <Tooltip content={collapsed ? "Expand navigation" : "Collapse navigation"} position="right">
                <Button size="mini" type="secondary" icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} />
              </Tooltip>
            </div>
          </div>
        </Layout.Sider>
        <Layout className={styles.body}>
          <LocationBreadcrumb />
          <Layout.Content className={`app-content ${styles.content}`}>{children}</Layout.Content>
        </Layout>
      </Layout>
      <Drawer
        title={<EnvoyLogo />}
        placement="left"
        width="min(280px, calc(100vw - 48px))"
        visible={mobileOpen}
        footer={<Button long onClick={() => setMobileOpen(false)}>Close navigation</Button>}
        focusLock
        unmountOnExit
        bodyStyle={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 0 }}
        onCancel={() => setMobileOpen(false)}
      >
        <Navigation onNavigate={() => setMobileOpen(false)} />
      </Drawer>
    </Layout>
  );
}
