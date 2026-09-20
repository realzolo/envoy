import type { Metadata } from "next";
import { EnvoyLogo } from "@/components/envoy-logo";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string}>}) {
  const next=(await searchParams).next;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050505] px-4">
      <section className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><EnvoyLogo /></div>
        <div className="rounded-lg border border-zinc-800 bg-[#090909] p-6">
          <h1 className="text-lg font-medium text-zinc-100">Admin console</h1>
          <p className="mt-1 text-sm text-zinc-600">Sign in with your workspace administrator credentials.</p>
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
