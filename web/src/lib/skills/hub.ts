/**
 * Web-side Skills Hub helpers.
 *
 * Wraps the in-process `@hermes/agent-core` SkillsHubClient with backend
 * install/uninstall/update RPC calls. This keeps registry browsing local while
 * disk mutations go through Hermes Core's /api/skills/hub/* endpoints.
 */

export {
  SkillHubEntry,
  SkillHubTrustLevel,
  SkillsHubClient,
  SkillsHubIndex,
} from "@hermes/agent-core";

import {
  fetchJSON,
  postJSON,
} from "@/lib/transport";
import {
  CheckSkillUpdatesResponse,
  InstallSkillResponse,
  UninstallSkillResponse,
  UpdateSkillResponse,
} from "@hermes/protocol";

export interface InstallSkillOptions {
  /** Optional registry URL hint for the backend resolver. */
  registryUrl?: string;
  /** Skip the third-party/community trust confirmation. */
  force?: boolean;
  /** Skip user confirmation dialogs (used in slash commands). */
  skipConfirm?: boolean;
}

/** Install a skill by identifier (e.g. `official/coding/rust` or a URL). */
export async function installSkill(
  identifier: string,
  options: InstallSkillOptions = {},
) {
  return postJSON(
    "/api/skills/hub/install",
    {
      identifier,
      ...(options.registryUrl && { registry_url: options.registryUrl }),
      ...(options.force && { force: true }),
      ...(options.skipConfirm && { skip_confirm: true }),
    },
    InstallSkillResponse,
  );
}

/** Uninstall a hub-installed skill by its local name. */
export async function uninstallSkill(name: string) {
  return postJSON(
    "/api/skills/hub/uninstall",
    { name },
    UninstallSkillResponse,
  );
}

/** Check which hub-installed skills have updates. */
export async function checkSkillUpdates(name?: string) {
  const path = name
    ? `/api/skills/hub/check?name=${encodeURIComponent(name)}`
    : "/api/skills/hub/check";
  return fetchJSON(path, undefined, CheckSkillUpdatesResponse);
}

/** Update one or all hub-installed skills. */
export async function updateSkill(name?: string) {
  return postJSON(
    "/api/skills/hub/update",
    name ? { name } : {},
    UpdateSkillResponse,
  );
}
