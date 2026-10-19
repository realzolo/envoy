# Business modules

Each business module owns its use cases and persistence semantics. Add code in this direction:

```text
public.ts / contracts.ts
application/  -> domain/
    |
    v
repository ports
    ^
    |
infrastructure/ repositories and adapters
```

- Keep business decisions in application/domain code. A service should read as a business workflow.
- Name Repository methods after a specific operation. Put SQL, Drizzle tables, row locks, database field mapping and constraint handling in infrastructure.
- The application chooses `UnitOfWork.run` boundaries. All participating repositories share its transaction connection; application code never receives a PostgreSQL client.
- Export other modules' server capabilities through `public.ts`. Export browser-safe request/response types through `contracts.ts`. Do not import another module's private service or repository.
- Keep Next.js sessions and `server-only` in the web adapter. Shared use cases must run in the standalone worker.
- Return an explicit DTO selected for the use case. Never expose credential ciphertext or a whole database row to a client component.
- Keep resource HTTP handlers thin; add management operations to their owning business module.
- Preserve executed migrations. Update typed definitions, append the next ordered SQL migration and checksum, and regenerate `db/schema.sql`. Validate populated upgrades and rollback.

See [the full architecture](../../docs/ARCHITECTURE.md) for ownership, permitted dependencies, transactions and verification. Run `pnpm architecture:check` before submitting changes.
