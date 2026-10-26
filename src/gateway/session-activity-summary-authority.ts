import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";

function recapOperatorProfileId(entry: Pick<SessionEntry, "owner" | "createdActor">) {
  const assigned = entry.owner?.actor;
  return assigned
    ? assigned.type === "human"
      ? assigned.id
      : undefined
    : sessionCreatorProfileId(entry.createdActor);
}

/** Bind the session owner's restriction, independently of the viewer requesting a refresh. */
export function createActivitySummaryAuthority({
  agentId,
  getEntry,
  getConfig,
  assertCurrent,
}: {
  agentId: string;
  getEntry: () => Pick<SessionEntry, "owner" | "createdActor">;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
}) {
  const profileId = recapOperatorProfileId(getEntry());
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let authority: ReturnType<typeof captureChannelOperatorRunAuthority> | undefined;
  let active = true;
  const assertOwnerCurrent = () => {
    assertCurrent();
    if (!active || recapOperatorProfileId(getEntry()) !== profileId) {
      throw new Error("Activity recap operator ownership is no longer current");
    }
  };
  return {
    operatorOwned: Boolean(profileId),
    assertCurrent(this: void) {
      assertOwnerCurrent();
      authority?.assertCurrent();
    },
    async prepare(this: void) {
      assertOwnerCurrent();
      if (!profileId) {
        return undefined;
      }
      const prepared = await prepareUserProfileIdentity(profileId);
      identity = prepared;
      assertOwnerCurrent();
      const original = prepared.readCurrentProfile();
      authority = captureChannelOperatorRunAuthority({
        ...original,
        scopes: [],
        gatewayAccessGrant: null,
        getRuntimeConfig: getConfig,
        assertCurrent: () => {
          assertOwnerCurrent();
          const profile = prepared.readCurrentProfile();
          if (
            profile.assignedRole !== original.assignedRole ||
            profile.githubLogin !== original.githubLogin
          ) {
            throw new Error("Activity recap operator role changed");
          }
          const role = resolveOperatorRolePolicyForAssignment(
            profileId,
            profile.assignedRole,
            getConfig(),
            profile.githubLogin ?? null,
          );
          if (role && role.agents !== "*" && !role.agents.includes(agentId)) {
            throw new Error("Activity recap operator role cannot access this agent");
          }
        },
      });
      return authority;
    },
    // The recap owner joins preparation and completion before releasing this lease.
    release(this: void) {
      active = false;
      identity?.release();
    },
  };
}
