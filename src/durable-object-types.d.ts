declare type DurableObjectId = {
  toString(): string;
};

declare type DurableObjectStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean>;
  list?<T = unknown>(options?: any): Promise<Map<string, T>>;
};

declare type DurableObjectState = {
  id: DurableObjectId;
  storage: DurableObjectStorage;
};

declare type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get<T = unknown>(id: DurableObjectId): T;
};
