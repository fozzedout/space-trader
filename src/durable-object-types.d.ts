export declare type DurableObjectId = {
  toString(): string;
};

export interface DurableObjectStorageListOptions {
  prefix?: string;
}

export declare type DurableObjectStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean>;
  list?<T = unknown>(options?: DurableObjectStorageListOptions): Promise<Map<string, T>>;
};

export declare type DurableObjectState = {
  id: DurableObjectId;
  storage: DurableObjectStorage;
};

export declare type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get<T = unknown>(id: DurableObjectId): T;
};
