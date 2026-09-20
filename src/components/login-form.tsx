"use client";

import { LogIn } from "lucide-react";
import { useState } from "react";

export function LoginForm({next}:{next?:string}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    setPending(false);
    if (!response.ok) {
      setError("The email or password is incorrect.");
      return;
    }
    window.location.href = next?.startsWith("/") ? next : "/";
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={submit}>
      <label className="block text-xs text-zinc-400">Email
        <input name="email" type="email" required defaultValue="admin@envoy.local" className="mt-2 h-10 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none focus:border-zinc-600" />
      </label>
      <label className="block text-xs text-zinc-400">Password
        <input name="password" type="password" required defaultValue="envoy" className="mt-2 h-10 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none focus:border-zinc-600" />
      </label>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <button disabled={pending} className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-100 text-sm font-medium text-zinc-950 disabled:opacity-60">
        <LogIn size={15} /> {pending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
