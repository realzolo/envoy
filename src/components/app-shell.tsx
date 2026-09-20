"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Ban,
  BookOpenText,
  Boxes,
  FileCode2,
  Gauge,
  Globe2,
  Inbox,
  KeyRound,
  Menu,
  ScrollText,
  Settings,
  Webhook,
  Route,
  SendHorizonal,
  ServerCog,
  RadioTower,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { EnvoyLogo } from "@/components/envoy-logo";
import { LogoutButton } from "@/components/session-actions";

const navigation = [
  {
    label: "",
    items: [
      { href: "/", label: "Overview", icon: Gauge },
      { href: "/emails", label: "Messages", icon: Inbox },
      { href: "/inbound", label: "Inbound", icon: BookOpenText },
    ],
  },
  {
    label: "CONTENT",
    items: [
      { href: "/templates", label: "Templates", icon: FileCode2 },
      { href: "/senders", label: "Sender Profiles", icon: SendHorizonal },
    ],
  },
  {
    label: "INFRASTRUCTURE",
    items: [
      { href: "/providers", label: "Provider Accounts", icon: ServerCog },
      { href: "/domains", label: "Domain Matrix", icon: Globe2 },
      { href: "/routing", label: "Routing", icon: Route },
      { href: "/events", label: "Provider Events", icon: RadioTower },
    ],
  },
  {
    label: "DEVELOPER",
    items: [
      { href: "/api-keys", label: "Service Credentials", icon: KeyRound },
      { href: "/webhooks", label: "Callbacks", icon: Webhook },
      { href: "/suppressions", label: "Suppressions", icon: Ban },
      { href: "/logs", label: "Audit & Revisions", icon: ScrollText },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

function SidebarContent({ onNavigate,email,workspaceName }: { onNavigate?: () => void;email:string;workspaceName:string }) {
  const pathname = usePathname();

  return (
    <>
      <div className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-4">
        <Link href="/" onClick={onNavigate}>
          <EnvoyLogo />
        </Link>
      </div>

      <div className="px-3 pt-3">
        <div className="flex h-10 w-full items-center rounded-md border border-zinc-800 bg-zinc-950 px-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-zinc-100 text-[10px] font-semibold text-zinc-950">
              E
            </span>
            <span className="truncate text-sm text-zinc-200">{workspaceName}</span>
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main navigation">
        {navigation.map((group, groupIndex) => (
          <div key={group.label || "primary"} className={groupIndex ? "mt-5" : ""}>
            {group.label && (
              <p className="mb-1 px-2 text-[11px] font-medium text-zinc-600">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={`flex h-8.5 items-center gap-2.5 rounded-md px-2 text-[13px] transition ${
                      active
                        ? "bg-zinc-800/70 text-zinc-100"
                        : "text-zinc-500 hover:bg-zinc-900/80 hover:text-zinc-200"
                    }`}
                  >
                    <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-800/80 p-3">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-zinc-100 to-zinc-500 text-xs font-medium text-zinc-950">
            {email.slice(0,2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-200">Workspace admin</p>
            <p className="truncate text-[11px] text-zinc-600">{email}</p>
          </div>
          <LogoutButton />
        </div>
      </div>
    </>
  );
}

export function AppShell({ children,email,workspaceName,environment }: { children: ReactNode;email:string;workspaceName:string;environment:string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [healthy,setHealthy]=useState<boolean|null>(null);
  useEffect(()=>{let active=true;const check=async()=>{try{const response=await fetch("/api/health",{cache:"no-store"});if(active)setHealthy(response.ok)}catch{if(active)setHealthy(false)}};void check();const timer=setInterval(check,30_000);return()=>{active=false;clearInterval(timer)}},[]);

  return (
    <div className="min-h-screen bg-transparent">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[228px] flex-col border-r border-zinc-800/80 bg-[#070707] lg:flex">
        <SidebarContent email={email} workspaceName={workspaceName} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
          aria-label="Close navigation"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative flex h-full w-[272px] flex-col border-r border-zinc-800 bg-[#070707] shadow-2xl">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute right-3 top-4 z-10 flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              onClick={() => setMobileOpen(false)}
            >
              <X size={17} aria-hidden="true" />
            </button>
            <SidebarContent email={email} workspaceName={workspaceName} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[228px]">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800/80 bg-[#050505]/85 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              className="flex size-8 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={16} aria-hidden="true" />
            </button>
            <div className="hidden items-center gap-2 text-xs text-zinc-600 sm:flex">
              <Boxes size={14} aria-hidden="true" />
              <span>{environment}</span>
              <span className="text-zinc-800">/</span>
              <span className="text-zinc-400">{workspaceName}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
              <span className="relative flex size-2">
                {healthy&&<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40" />}
                <span className={`relative inline-flex size-2 rounded-full ${healthy===null?"bg-zinc-600":healthy?"bg-emerald-400":"bg-red-400"}`} />
              </span>
              {healthy===null?"Checking system":healthy?"System healthy":"System degraded"}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1480px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
          {children}
        </main>
      </div>
    </div>
  );
}
