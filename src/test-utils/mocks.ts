/**
 * Test utilities and mocks for local simulation objects
 */

export class MockDurableObjectStorage {
  private data: Map<string, any> = new Map();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T = unknown>(options?: any): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const prefix = options?.prefix || "";
    const start = options?.start || "";
    const end = options?.end;

    for (const [key, value] of this.data.entries()) {
      if (key.startsWith(prefix) && key >= start && (!end || key < end)) {
        result.set(key, value as T);
      }
    }

    return result;
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }

  async getAlarm(): Promise<number | null> {
    return null;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    // Mock implementation
  }

  async deleteAlarm(): Promise<void> {
    // Mock implementation
  }

  async sync(): Promise<void> {
    // Mock implementation
  }

  async transaction<T>(closure: (txn: any) => Promise<T>): Promise<T> {
    // Simplified mock - just run the closure
    return closure(this as any);
  }
}

export class MockDurableObjectState {
  id: any;
  storage: MockDurableObjectStorage;

  constructor(id: DurableObjectId) {
    this.id = id;
    this.storage = new MockDurableObjectStorage();
  }
}

export class MockDurableObjectNamespace {
  private objects: Map<string, any> = new Map();

  idFromName(name: string): any {
    return { toString: () => name };
  }

  idFromString(id: string): any {
    return { toString: () => id };
  }

  newUniqueId(): any {
    const id = `unique-${Date.now()}-${Math.random()}`;
    return { toString: () => id };
  }

  get<T>(id: DurableObjectId): T {
    const key = id.toString();
    if (!this.objects.has(key)) {
      throw new Error(`Object ${key} not found in mock namespace`);
    }
    return this.objects.get(key) as T;
  }

  set(id: DurableObjectId, obj: any): void {
    this.objects.set(id.toString(), obj);
  }
}

export function createMockEnv(): any {
  return {
    STAR_SYSTEM: new MockDurableObjectNamespace(),
    SHIP: new MockDurableObjectNamespace(),
    GALAXY_SIZE: "256",
    TICK_INTERVAL_MS: "60000",
    MAX_NPC_TRADERS_PER_SYSTEM: "50",
  };
}
