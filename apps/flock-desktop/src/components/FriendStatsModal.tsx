import StatsModal from "./StatsModal";
import type { Friend } from "../types";

interface Props {
  friend: Friend;
  onClose: () => void;
  onShowSidebar?: () => void;
  /** What you can do with this friend (watch, co-pilot, a task), at the foot. */
  actions?: React.ReactNode;
}

/** A friend's stats and achievements, as a page of the main panel. */
export default function FriendStatsModal({ friend, onClose, onShowSidebar, actions }: Props) {
  return (
    <StatsModal
      profileId={friend.id}
      handle={friend.handle}
      avatarUrl={friend.avatarUrl ?? null}
      ariaLabel={`${friend.handle} stats`}
      presenceClass={friend.presence}
      presenceText={
        friend.presence === "online"
          ? (friend.agentCount > 0 ? `${friend.agentCount} ${friend.agentCount === 1 ? "agent" : "agents"} running` : "online")
          : "offline"
      }
      errorText={`Stats aren't available for @${friend.handle} yet.`}
      onClose={onClose}
      title={`@${friend.handle}`}
      onShowSidebar={onShowSidebar}
      footer={actions}
    />
  );
}
