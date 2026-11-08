import { memo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { inviteMailto, sendInviteEmail, type AddFriendResult } from "../lib/flockId";
import { MY_WINDOW_ID } from "../lib/windowId";
import type { Friend } from "../types";
import { Menu, useMenu, type MenuEntry } from "./Menu";
import { CheckIcon, ChevronDownIcon, MoreIcon, PlusIcon, XIcon } from "./icons";

const COLLAPSED_KEY = "flock:v2-people-collapsed";

export interface PeopleProps {
  friends: Friend[];
  /** Your own handle: your other windows are not a friend. */
  myHandle: string | null;
  onAdd: (input: string) => Promise<AddFriendResult>;
  onAccept: (profileId: string) => Promise<void>;
  onRemove: (profileId: string) => Promise<void>;
  /** Their page: stats, achievements, what you can do together. */
  onOpen: (friend: Friend) => void;
  /** What you can do with an online friend: watch, co-pilot, a task. */
  actions?: (friend: Friend) => MenuEntry[];
}

function ago(seconds: number | null): string {
  if (!seconds) return "offline";
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 3600) return `seen ${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `seen ${Math.round(s / 3600)}h ago`;
  return `seen ${Math.round(s / 86400)}d ago`;
}

function Avatar({ friend }: { friend: Friend }) {
  return (
    <span className="v2-avatar sm" aria-hidden="true">
      {friend.avatarUrl ? <img src={friend.avatarUrl} alt="" referrerPolicy="no-referrer" /> : friend.handle.slice(0, 2).toUpperCase()}
      {friend.presence === "online" && <span className="v2-avatar-dot" />}
    </span>
  );
}

/** The people you work with, under your projects: who is online and what they
 *  are running, requests to answer, and adding someone by handle or email.
 *  One quiet group, folded away like a project when you want the room. */
function People({ friends, myHandle, onAdd, onAccept, onRemove, onOpen, actions }: PeopleProps) {
  // Folded until you open it: the projects are what the sidebar is for, and
  // the folded head still says who is online and whether anyone is asking.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Friend | null>(null);
  const menu = useMenu();

  const real = friends.filter((f) => f.windowId !== MY_WINDOW_ID && !!f.handle && f.handle !== myHandle);
  const accepted = real.filter((f) => f.friendStatus === "accepted");
  const requests = real.filter((f) => f.friendStatus === "pending_in");
  const sent = real.filter((f) => f.friendStatus === "pending_out");
  const online = accepted.filter((f) => f.presence === "online").sort((a, b) => b.agentCount - a.agentCount);
  const offline = accepted.filter((f) => f.presence !== "online").sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* a preference */
      }
      return !c;
    });

  const submit = async () => {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await onAdd(value);
      if (result === "invited") {
        try {
          await sendInviteEmail(value);
          setNote({ text: `Invite sent to ${value}.` });
        } catch {
          setNote({ text: "Couldn't send it from flock, so it's drafted in your mail app." });
          openUrl(inviteMailto(value, myHandle)).catch(console.error);
        }
      } else if (result === "already") {
        setNote({ text: "Already friends, or a request is waiting." });
      } else if (result === "self") {
        setNote({ text: "That's you." });
      } else {
        setNote({ text: `Request sent to @${value.replace(/^@/, "")}.` });
      }
      setInput("");
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const row = (f: Friend, sub: string, trailing?: React.ReactNode) => (
    <li key={f.id} className="v2-person" data-online={f.presence === "online" || undefined}>
      <button type="button" className="v2-person-main" onClick={() => onOpen(f)} title={`@${f.handle}`}>
        <Avatar friend={f} />
        <span className="v2-person-text">
          <span className="v2-person-name">{f.handle}</span>
          <span className="v2-person-sub">{sub}</span>
        </span>
      </button>
      {trailing ?? (
        <button
          type="button"
          className="v2-icon-btn v2-person-more"
          aria-label={`More for @${f.handle}`}
          aria-haspopup="menu"
          aria-expanded={menu.open && menuFor?.id === f.id}
          onClick={(e) => {
            setMenuFor(f);
            menu.toggle(e);
          }}
        >
          <MoreIcon size={15} />
        </button>
      )}
    </li>
  );

  const entriesFor = (f: Friend): MenuEntry[] => [
    { label: "Stats and achievements", onSelect: () => onOpen(f) },
    ...(actions && f.presence === "online" ? [{ separator: true } as MenuEntry, ...actions(f)] : []),
    { separator: true },
    { label: "Remove friend", danger: true, onSelect: () => void onRemove(f.id).catch(console.error) },
  ];

  const onlineLabel = accepted.length > 0 ? `${online.length} online` : null;

  return (
    <section className="v2-people" aria-label="People" data-collapsed={collapsed || undefined}>
      <div className="v2-project-head">
        <button type="button" className="v2-project-name" aria-expanded={!collapsed} onClick={toggle}>
          <ChevronDownIcon size={13} />
          <span>People</span>
          {onlineLabel && <span className="v2-people-online">{onlineLabel}</span>}
          {collapsed && requests.length > 0 && (
            <span className="v2-count mark" title={`${requests.length} friend ${requests.length === 1 ? "request" : "requests"}`}>
              {requests.length}
            </span>
          )}
        </button>
        <button
          type="button"
          className="v2-icon-btn"
          aria-label="Add a friend"
          title="Add a friend"
          onClick={() => {
            if (collapsed) toggle();
            setAdding((a) => !a);
            setNote(null);
          }}
        >
          <PlusIcon size={15} />
        </button>
      </div>

      {!collapsed && (
        <>
          {adding && (
            <div className="v2-people-add">
              <input
                autoFocus
                value={input}
                placeholder="Handle, or an email to invite"
                aria-label="Friend's handle or email"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setInput(e.target.value);
                  setNote(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                  else if (e.key === "Escape") {
                    e.stopPropagation();
                    setAdding(false);
                    setInput("");
                  }
                }}
              />
            </div>
          )}
          {note && <p className={`v2-people-note${note.error ? " error" : ""}`}>{note.text}</p>}

          <ul className="v2-people-list">
            {requests.map((f) =>
              row(
                f,
                "wants to connect",
                <span className="v2-person-actions">
                  <button type="button" className="v2-icon-btn" aria-label={`Accept @${f.handle}`} title="Accept" onClick={() => void onAccept(f.id).catch(console.error)}>
                    <CheckIcon size={15} />
                  </button>
                  <button type="button" className="v2-icon-btn" aria-label={`Decline @${f.handle}`} title="Decline" onClick={() => void onRemove(f.id).catch(console.error)}>
                    <XIcon size={15} />
                  </button>
                </span>,
              ),
            )}
            {online.map((f) => row(f, f.agentCount > 0 ? `${f.agentCount} ${f.agentCount === 1 ? "agent" : "agents"} running` : "online"))}
            {offline.length > 0 &&
              (online.length === 0 || offlineOpen ? (
                offline.map((f) => row(f, ago(f.lastSeen)))
              ) : (
                <li>
                  <button type="button" className="v2-people-more" onClick={() => setOfflineOpen(true)}>
                    {offline.length} offline
                  </button>
                </li>
              ))}
            {sent.map((f) =>
              row(
                f,
                "request sent",
                <span className="v2-person-actions">
                  <button type="button" className="v2-icon-btn" aria-label={`Cancel the request to @${f.handle}`} title="Cancel request" onClick={() => void onRemove(f.id).catch(console.error)}>
                    <XIcon size={15} />
                  </button>
                </span>,
              ),
            )}
          </ul>
          {real.length === 0 && !adding && (
            <button type="button" className="v2-people-more" onClick={() => setAdding(true)}>
              Add a friend to share agents with
            </button>
          )}
        </>
      )}
      {menu.anchor && menuFor && <Menu anchor={menu.anchor} entries={entriesFor(menuFor)} onClose={menu.close} label={`@${menuFor.handle}`} align="end" />}
    </section>
  );
}

export default memo(People);
