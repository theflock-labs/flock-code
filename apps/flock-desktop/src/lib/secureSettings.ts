// Whether a NEW workspace starts with secure mode on. Frontend-only
// preference; the backend is unaffected and stays authoritative about what a
// workspace actually is (see `spawn_pane`, which refuses to downgrade a
// workspace that has already spawned securely).
//
// WHY THIS IS A PREFERENCE AND NOT A CONSTANT.
// The jail is the right default: it is what makes the bypass-permission launch
// flags safe, so the answer for almost everyone is yes. But "almost everyone"
// is doing work here that a constant cannot. Docker on a laptop costs a
// multi-GB image, a daemon that has to be running, and a first-pane build the
// user has to sit through, and someone who cannot be walked through installing
// Docker is exactly the person who will read a pane that never starts as the
// app being broken. Turning the toggle off every time is a tax on that person
// forever; turning this off once is not.
//
// It only moves the STARTING POSITION of the toggle in NewWorkspaceDialog. The
// toggle is still there, still per workspace, and still gated on the Docker
// probe — a workspace cannot be secure on a machine with no daemon no matter
// what this says. Nothing here can make an existing workspace less secure.
//
// TWO WRITERS, ONE VALUE, DELIBERATELY. The Settings switch sets it outright,
// and creating a workspace writes back whatever the dialog's switch was left
// at. They are the same question asked in two places, so keeping them as one
// value is what stops Settings claiming one answer while every new workspace
// quietly does the other. NewWorkspaceDialog stores the user's `secure`
// intent, never the Docker-gated `jailed` outcome.

const STORAGE_KEY = "flock:secure-by-default";

/** Does a new workspace start with secure mode checked? Defaults to true: the
 *  jail is what makes the default launch flags safe, so opting out has to be a
 *  decision someone made rather than one they inherited. */
export function getSecureByDefault(): boolean {
  // `!== "false"` rather than `=== "true"`, which is what the other settings
  // modules use. Only the exact string the setter writes turns the jail off,
  // so an absent, corrupted or half-written value lands on the safe side
  // instead of quietly starting workspaces on the host. A storage that
  // throws lands there too, rather than taking NewWorkspaceDialog down.
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setSecureByDefault(on: boolean) {
  localStorage.setItem(STORAGE_KEY, String(on));
}
