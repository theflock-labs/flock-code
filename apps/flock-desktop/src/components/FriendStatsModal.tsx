import StatsModal from "./StatsModal";
import type { Friend } from "../types";

interface Props {
  friend: Friend;
  onClose: () => void;
}

export default function FriendStatsModal({ friend, onClose }: Props) {
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
    />
  );
}
