export { mailReader } from "@/bootstrap/mail-reader";
export { ReaderError } from "./application/service";
export { renderReader } from "./domain/frame";
export type { ReadingSession, ReaderTarget, ReaderResourceTarget } from "./contracts";

import { mailReader } from "@/bootstrap/mail-reader";
import { readerCache } from "./infrastructure/cache.repository";

export const prepareReaderResource = mailReader.prepareResource;

export const pendingReaderResources = readerCache.pending;

export const cancelUnauthorizedReaderDemand = readerCache.cancelUnauthorizedDemand;
export const deferReaderPreparationDemand = readerCache.deferPreparationDemand;

export { registerReadingSource } from "./infrastructure/registration";
