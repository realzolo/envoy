import { Route } from "lucide-react";

export function EnvoyLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" aria-label="Envoy">
      <span
        className="flex size-7 items-center justify-center rounded-[6px] border border-zinc-700 bg-zinc-100 text-zinc-950 shadow-[0_0_18px_rgba(255,255,255,0.1)]">
        <Route aria-hidden="true" size={15} strokeWidth={2.2}/>
      </span>
      {!compact && (
        <span className="text-[15px] font-medium text-white">Envoy</span>
      )}
    </div>
  );
}
