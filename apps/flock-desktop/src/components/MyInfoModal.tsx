import StatsModal from "./StatsModal";

interface Props {
  profileId: string;
  handle: string;
  avatarUrl: string | null;
  onSignOut: () => void;
  onClose: () => void;
}

export default function MyInfoModal({ profileId, handle, avatarUrl, onSignOut, onClose }: Props) {
  return (
    <StatsModal
      profileId={profileId}
      handle={handle}
      avatarUrl={avatarUrl}
      ariaLabel="Your flock info"
      presenceClass="online"
      presenceText="this is you"
      errorText="Your stats aren't available right now."
      showGraph
      onClose={onClose}
      footer={
        <button type="button" className="stats-signout" onClick={onSignOut}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </button>
      }
    />
  );
}
