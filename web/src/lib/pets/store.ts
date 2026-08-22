import type { PetInfo } from "./constants.js";

export interface PetStore {
  list(): Promise<PetInfo[]>;
  load(slug: string): Promise<PetInfo | undefined>;
  install(slug: string, info: PetInfo): Promise<void>;
  remove(slug: string): Promise<void>;
}

export class InMemoryPetStore implements PetStore {
  private pets = new Map<string, PetInfo>();

  async list(): Promise<PetInfo[]> {
    return Array.from(this.pets.values());
  }

  async load(slug: string): Promise<PetInfo | undefined> {
    return this.pets.get(slug);
  }

  async install(slug: string, info: PetInfo): Promise<void> {
    this.pets.set(slug, info);
  }

  async remove(slug: string): Promise<void> {
    this.pets.delete(slug);
  }
}
