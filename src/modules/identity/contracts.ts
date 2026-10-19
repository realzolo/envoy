export class ServiceConfigurationConflictError extends Error {
  constructor() { super("This service was changed by another administrator. Close the editor, refresh, and review the latest configuration before saving."); }
}

export type ServiceIdentity={serviceId:string;serviceName:string;rateLimitPerMinute:number;suppressionManagement?:boolean};

export class ContentConflictError extends Error {
  constructor(public code: "CONTENT_BUSY" | "CONTENT_SHARED") { super(code); }
}

