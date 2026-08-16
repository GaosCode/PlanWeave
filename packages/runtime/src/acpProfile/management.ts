import type { ExecutionHost } from "../types/executor.js";
import {
  acpProfileCanonicalKey,
  acpProfileDescriptorSchema,
  type AcpProfileCatalog,
  type AcpProfileDescriptor
} from "./schema.js";
import { ExecutionHostAcpCommandResolver, type AcpHostCommandResolver } from "./resolver.js";
import { AcpProfileNotFoundError, AcpProfileStore } from "./store.js";

export class AcpProfileManager {
  constructor(
    private readonly store: AcpProfileStore = new AcpProfileStore(),
    private readonly commandResolver: AcpHostCommandResolver = new ExecutionHostAcpCommandResolver()
  ) {}

  list(): Promise<AcpProfileCatalog> {
    return this.store.read();
  }

  async show(profileId: string): Promise<{
    revision: number;
    profile: AcpProfileDescriptor;
  }> {
    const catalog = await this.store.read();
    const key = acpProfileCanonicalKey(profileId);
    const profile = catalog.profiles.find(
      (candidate) => acpProfileCanonicalKey(candidate.id) === key
    );
    if (!profile) throw new AcpProfileNotFoundError(profileId);
    return { revision: catalog.revision, profile };
  }

  async register(input: {
    expectedRevision: number;
    profile: AcpProfileDescriptor;
  }): Promise<AcpProfileCatalog> {
    const profile = await this.validateLaunch(input.profile);
    return this.store.register({ ...input, profile });
  }

  async update(input: {
    expectedRevision: number;
    profileId: string;
    profile: AcpProfileDescriptor;
  }): Promise<AcpProfileCatalog> {
    const profile = await this.validateLaunch(input.profile);
    return this.store.update({ ...input, profile });
  }

  remove(input: { expectedRevision: number; profileId: string }): Promise<AcpProfileCatalog> {
    return this.store.remove(input);
  }

  private async validateLaunch(input: AcpProfileDescriptor): Promise<AcpProfileDescriptor> {
    const profile = acpProfileDescriptorSchema.parse(input);
    await this.commandResolver.resolve(profile.launch.command, profile.host as ExecutionHost);
    return profile;
  }
}
