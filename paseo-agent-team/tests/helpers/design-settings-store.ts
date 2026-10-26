import type { Preferences } from "../../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";

export type SettingsStoreKey = "roles" | "teams" | "preferences";
export type SettingsStoreFault = "throw-before-commit" | "throw-after-commit";

export type StoreDocuments = {
  roles: RolesDocument & Record<string, unknown>;
  teams: TeamsDocument & Record<string, unknown>;
  preferences: Preferences;
};

export type StoreRead = { status: "ready"; revision: string; values: unknown };
export type StoreWrite =
  | { status: "saved"; revision: string; values: unknown }
  | { status: "conflict"; error: string };

/**
 * Stateful CAS settings fake. `read` returns one version's values and revision; `write` compares
 * the exact revision at the commit point, then increments it. Tests inject `beforeWrite` to
 * interleave two clients and one-shot faults to simulate a lost request or lost response.
 * This is test-only; production keeps the preset gateway unchanged.
 */
export class DesignSettingsStore {
  private documents: StoreDocuments;
  private counters: Record<SettingsStoreKey, number> = {
    roles: 1,
    teams: 1,
    preferences: 1,
  };
  private faults: Partial<Record<SettingsStoreKey, SettingsStoreFault>> = {};

  /** Runs inside a write before the CAS comparison; throw or await to interleave clients. */
  beforeWrite?: (key: SettingsStoreKey, values: unknown, expected: string) => Promise<void> | void;

  constructor(documents: StoreDocuments) {
    this.documents = structuredClone(documents);
  }

  revision(key: SettingsStoreKey): string {
    return `${key}-${this.counters[key]}`;
  }

  revisions(): { roles: string; teams: string; preferences: string } {
    return {
      roles: this.revision("roles"),
      teams: this.revision("teams"),
      preferences: this.revision("preferences"),
    };
  }

  values<K extends SettingsStoreKey>(key: K): StoreDocuments[K] {
    return structuredClone(this.documents[key]);
  }

  read(key: SettingsStoreKey): StoreRead {
    return {
      status: "ready",
      revision: this.revision(key),
      values: structuredClone(this.documents[key]),
    };
  }

  failNextWrite(key: SettingsStoreKey, fault: SettingsStoreFault): void {
    this.faults[key] = fault;
  }

  async write<K extends SettingsStoreKey>(
    key: K,
    values: StoreDocuments[K],
    expected: string,
  ): Promise<StoreWrite> {
    await this.beforeWrite?.(key, values, expected);
    const fault = this.faults[key];
    delete this.faults[key];
    if (fault === "throw-before-commit") throw new Error(`transport lost before ${key} commit`);
    if (expected !== this.revision(key)) {
      return { status: "conflict", error: `${key} revision changed` };
    }
    this.documents[key] = structuredClone(values);
    this.counters[key] += 1;
    if (fault === "throw-after-commit") throw new Error(`transport lost after ${key} commit`);
    return { status: "saved", revision: this.revision(key), values: structuredClone(values) };
  }
}
