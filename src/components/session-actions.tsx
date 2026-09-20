"use client";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return <button type="button" title="Sign out" onClick={async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.push("/login");
    router.refresh()
  }} className="flex size-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-900 hover:text-zinc-200">
    <LogOut size={14}/></button>
}
