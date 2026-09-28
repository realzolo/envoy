import type { Metadata } from "next";
import { LoginPageView } from "@/components/login-page-view";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = (await searchParams).next;

  return <LoginPageView next={next} />;
}
