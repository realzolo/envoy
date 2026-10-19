/** Application code sees repository capabilities, never a database driver. */
export interface UnitOfWork<Repositories> {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

/** Opaque context for use cases that must participate in an existing transaction. */
export interface TransactionContext {
  readonly transactionId: symbol;
}
