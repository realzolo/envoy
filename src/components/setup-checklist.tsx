import Link from "next/link";
import { ArrowRight, Check, Circle } from "lucide-react";

type SetupState = {
  providers: number;
  identities: number;
  products: number;
  senders: number;
  routes: number;
  credentials: number;
  messages: number;
};

const steps = [
  {
    key: "providers",
    href: "/providers",
    title: "Connect a provider",
    description: "Add the sending account you already use."
  },
  {
    key: "identities",
    href: "/domains",
    title: "Verify a sending domain",
    description: "Publish the provider DNS records, then refresh verification."
  },
  {
    key: "productAndCredential",
    href: "/api-keys",
    title: "Create a product and service",
    description: "Issue the credential used by your application."
  },
  {
    key: "senders",
    href: "/senders",
    title: "Add a sender profile",
    description: "Choose the visible From address for a message category."
  },
  {
    key: "routes",
    href: "/routing",
    title: "Set a delivery route",
    description: "Attach the verified identity to the provider account."
  },
  {
    key: "messages",
    href: "/emails/compose",
    title: "Send a test message",
    description: "Use the same acceptance path as your application."
  }
] as const;

export function SetupChecklist({ state }: { state: SetupState }) {
  const complete = (key: typeof steps[number]["key"]) => {
    if (key === "productAndCredential") return state.products > 0 && state.credentials > 0;
    return state[key] > 0;
  };
  const firstIncomplete = steps.find(step => !complete(step.key));
  if (!firstIncomplete) return null;

  return <section className="border-y border-zinc-800 py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-medium text-zinc-100">Finish delivery setup</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">Complete the remaining prerequisites before live sending.</p>
      </div>
      <Link href={firstIncomplete.href}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 text-xs text-zinc-300 hover:text-white">
        Continue setup <ArrowRight size={13} aria-hidden="true"/>
      </Link>
    </div>
    <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {steps.map(step => {
        const done = complete(step.key);
        return <li key={step.key}>
          <Link href={step.href}
                className="group flex min-h-20 gap-3 rounded-md border border-zinc-800 px-3 py-3 transition hover:border-zinc-700 hover:bg-zinc-900/40">
            <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${done ? "border-emerald-700 bg-emerald-950/40 text-emerald-400" : "border-zinc-700 text-zinc-600"}`}>
              {done ? <Check size={12} aria-label="Complete"/> : <Circle size={9} aria-hidden="true"/>}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-medium ${done ? "text-zinc-500" : "text-zinc-200 group-hover:text-white"}`}>{step.title}</span>
              <span className="mt-1 block text-[11px] leading-4 text-zinc-600">{step.description}</span>
            </span>
          </Link>
        </li>
      })}
    </ol>
  </section>;
}
