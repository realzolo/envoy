import type { ReactNode } from "react";

export function PageHeader({
                             title,
                             description,
                             actions,
                           }: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header
      className="flex flex-col gap-4 border-b border-zinc-800/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-medium text-zinc-50">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-zinc-500">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
