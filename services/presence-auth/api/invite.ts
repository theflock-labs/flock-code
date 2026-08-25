import type { VercelRequest, VercelResponse } from "@vercel/node";

// Sends the flock invite email on behalf of a signed-in user.
//
// POST { token, email } — token is the caller's Supabase access token. The
// invite itself is recorded in the database by the add_friend_by_email RPC
// before the client calls this. Identity is verified server-side and the
// inviter's name in the email comes from their verified profile, never from
// request input: an invite that lets you impersonate someone else's handle is
// a phishing kit.
//
// Because this delivers from an SPF/DKIM-aligned domain, delivery is gated by
// record_invite_send (003_invite_rate_limit.sql): the caller may only email an
// address they genuinely recorded as a pending invite, and only within a
// per-inviter rate limit. Without that gate the endpoint is an authenticated
// spam cannon aimed at arbitrary addresses.

// The invite comes from the product's own domain, and from a mailbox a human
// could reply to: this is one developer inviting another, so a noreply sender
// would misdescribe it, and replies are a deliverability signal worth having.
//
// This address only works once theflock.sh is a verified Resend domain. As of
// this change it is not: theflock.sh publishes ForwardEmail's SPF and no
// resend._domainkey record, so mail from it fails DKIM alignment. Until the
// records land, set RESEND_FROM to the old verified sender on minnebo.ai.
const FROM = process.env.RESEND_FROM ?? "flock <friends@theflock.sh>";

interface Inviter {
  handle: string;
  displayName: string | null;
}

async function verifyInviter(token: string): Promise<Inviter | null> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const headers = { apikey: anonKey, Authorization: `Bearer ${token}` };

  const userRes = await fetch(`${url}/auth/v1/user`, { headers });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${user.id}&select=handle,display_name`,
    { headers },
  );
  if (!profRes.ok) return null;
  const rows = await profRes.json();
  const handle = rows?.[0]?.handle;
  if (!handle) return null; // no handle claimed → nothing to be connected to
  return { handle, displayName: rows?.[0]?.display_name ?? null };
}

type SendGate = "ok" | "no_invite" | "rate_limited" | "error";

// Server-side abuse gate. Calls the record_invite_send definer RPC with the
// caller's own token, so auth.uid() inside the function is the caller: they
// can only spend their own invite budget and only reach addresses they
// actually invited. Returns "error" on any transport or config failure so the
// caller fails closed (no send).
async function recordInviteSend(token: string, email: string): Promise<SendGate> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return "error";

  const res = await fetch(`${url}/rest/v1/rpc/record_invite_send`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target_email: email }),
  });
  if (!res.ok) {
    console.error(`record_invite_send failed: ${res.status} ${await res.text()}`);
    return "error";
  }

  const status = await res.json();
  if (status === "ok" || status === "no_invite" || status === "rate_limited") {
    return status;
  }
  return "error";
}

// ---------------------------------------------------------------------------
// Brand, as far as email can carry it. Every literal below is a brand token
// value copied from the flock palette,
// because email has no custom properties and Outlook has no rgba().
//
// Type: the three brand faces are self-hosted webfonts, so no mail client will
// load them. What ships is brand.css's own fallback chain, which contains no
// Apple SF on purpose. The brand retired the system stacks, and -apple-system
// would put the banned face first on every Apple client, which is where most
// of this mail is read.
const SANS = "Outfit,'Helvetica Neue',Arial,sans-serif";
const SERIF = "Fraunces,'Iowan Old Style',Georgia,serif";
const MONO = "'IBM Plex Mono',Menlo,Consolas,monospace";

// Colour, Daybreak. Email is a static bright render, so the dark theme has no
// expression here.
const INK = "#0B1B33";         // --ink, and the accent: ink is the loud colour
const SLATE = "#44546C";       // --slate, body copy at rest
const SLATE_SOFT = "#61708A";  // --slate-soft, metadata and labels
const PAPER = "#FCFBF8";       // --paper, the card
const PAPER_2 = "#F4F2EC";     // --paper-2, sunken wells and menu bars
const ELEV = "#FFFFFF";        // --elev, the raised product window
const WARN_TEXT = "#9A6231";   // --warn-text: --warn is a fill, 3.6:1 as text

// --hair and --hair-soft are rgba over a known surface. Flattened here, one
// constant per surface, because the Word-engine Outlooks drop rgba borders.
const HAIR_ON_PAPER = "#DFE0E0";
const HAIR_SOFT_ON_PAPER = "#EBEBEA";
const HAIR_ON_ELEV = "#E2E4E7";
const HAIR_SOFT_ON_ELEV = "#EEEFF1";

// The working wave, frozen. This is the site's own prefers-reduced-motion
// frame for .wb: five segments, the middle three carrying sky, rose and peach
// over the idle blue. Email is the same case as reduced motion. It is also the
// one place the signature trio is allowed, because the rule is that the three
// appear as a set or not at all, never as a lone accent.
const WAVE = ["#DBE5FF", "#7FB4F0", "#F6C6D8", "#FFB59E", "#DBE5FF"]
  .map((c) => `<span style="color:${c};">&#9632;</span>`)
  .join("");

// One agent row in the cockpit mock, mirroring the site's .mock-agent-row: the
// name in ink, the kind in mono metadata, the status carrying the colour, the
// intent underneath. Working takes ink and the frozen wave, waiting takes
// --warn-text. The app has no green "running" state and neither does this.
function agentRow(
  name: string,
  kind: string,
  status: "working" | "needs input",
  age: string,
  intent: string,
): string {
  const working = status === "working";
  const wave = working
    ? `<span style="font-family:${MONO};font-size:8px;letter-spacing:1px;">${WAVE}</span>&nbsp;`
    : "";
  return `          <tr><td style="padding:11px 15px;border-top:1px solid ${HAIR_SOFT_ON_ELEV};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="vertical-align:middle;">
                <span style="font-family:${MONO};font-size:11.5px;font-weight:600;color:${INK};">${name}</span>
                <span style="font-family:${MONO};font-size:10.5px;color:${SLATE_SOFT};">&nbsp;&nbsp;${kind}</span>
              </td>
              <td align="right" style="vertical-align:middle;white-space:nowrap;">
                ${wave}<span style="font-family:${MONO};font-size:10.5px;color:${working ? INK : WARN_TEXT};">${status}</span>
                <span style="font-family:${MONO};font-size:10.5px;color:${SLATE_SOFT};">&nbsp;${age}</span>
              </td>
            </tr></table>
            <span style="font-family:${MONO};font-size:10.5px;line-height:1.9;color:${SLATE};">${intent}</span>
          </td></tr>`;
}

function inviteHtml(inv: Inviter): string {
  const who = inv.displayName ? esc(inv.displayName) : `@${esc(inv.handle)}`;
  const at = `@${esc(inv.handle)}`;
  const cta = `https://theflock.sh/?ref=${encodeURIComponent(inv.handle)}`;
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background-color:${PAPER_2};">
<!-- Preheader: controls the inbox snippet, invisible in the body -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Claude Code, OpenCode, and Codex in one cockpit, sharing one memory. ${at} pulled up the second chair.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:36px 16px;">

<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <!-- Paper card on the sunken surface, product window raised above it: the
       site's own elevation order, in the site's own three greys -->
  <tr><td style="background-color:${PAPER};border:1px solid ${HAIR_ON_PAPER};border-radius:16px;padding:52px 48px 44px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

      <!-- One bird, one colorway, in both themes. The PNG is generated from the
           same sprite as the site's SVG by flock-website/scripts/generate-goose.py:
           mail clients do not render SVG, and a hand-kept raster is exactly how
           this slot came to point at a retired colorway that the site later
           archived out from under it.

           The bird was removed from every top-level lockup on 2026-07-29, the
           site nav and footer and the app's sidebar, and it stays here for the
           same reason it stays on the social card: this is a one-off moment
           rather than chrome somebody looks at all day, and with images blocked
           the wordmark below still carries the mail on its own. -->
      <tr><td align="center" style="padding-bottom:10px;">
        <img src="https://theflock.sh/email-goose-firstlight.png" width="144" height="56" alt="" style="display:block;margin:0 auto;border:0;" />
      </td></tr>
      <!-- The wordmark is artwork now, because as of 2026-07-29 it is drawn
           rather than set: the f's curl is brought down to 720, and a letter
           we have redrawn is not one any client has a font for. Live text
           here would ship Outfit's f, which is the one thing the change was
           for. flock-website/scripts/generate-wordmark.py writes the PNG from
           the same outlines brand.css uses.

           IT IS STILL A WORD WITH IMAGES BLOCKED. The alt is the logotype and
           it carries the type styles, so a client that refuses the image
           renders "flock" at the same size and colour rather than leaving a
           hole where the mark was — which is what the live-text version was
           protecting, and it is protected. Lowercase is load-bearing: the
           logotype is never sentence-cased, and literal lowercase beats
           text-transform, which Outlook's Word engine ignores.

           THERE IS NO height ATTRIBUTE, AND THAT IS THE POINT. With
           height="24" on it the alt is clipped to a 24px box and 33px text
           simply does not appear — the mark is gone rather than degraded,
           which is the one outcome this row exists to prevent. Verified both
           ways. The width stays so Outlook reserves the column; height:auto
           lets the box grow to the word when the image never arrives.

           The crest is frozen, not animated: mail cannot run the drift, so
           the PNG bakes the same still the app holds under reduced motion.
           2x for the 69x24 slot, matching the goose above. -->
      <tr><td align="center" style="padding-bottom:14px;">
        <img src="https://theflock.sh/email-wordmark.png" width="69" alt="flock" style="display:block;margin:0 auto;border:0;height:auto;font-family:${SANS};font-size:33px;font-weight:500;letter-spacing:-0.6px;color:${INK};" />
      </td></tr>
      <tr><td align="center" style="padding-bottom:44px;">
        <span style="font-family:${MONO};font-size:9.5px;letter-spacing:2.7px;color:${SLATE_SOFT};">AGENTIC CODING COCKPIT</span>
      </td></tr>

      <tr><td align="center" style="padding-bottom:14px;">
        <span style="font-family:${MONO};font-size:11.5px;letter-spacing:1px;color:${SLATE_SOFT};"><span style="color:${INK};">${who}</span> invited you</span>
      </td></tr>
      <!-- The site's h1, verbatim, down to the serif italic on "formation".
           A written sentence takes the sans side of the two-family split; the
           mono kicker above carries the metadata. -->
      <tr><td align="center" style="padding-bottom:18px;">
        <span style="font-family:${SANS};font-size:27px;font-weight:700;line-height:1.25;letter-spacing:-0.5px;color:${INK};">Your coding agents,<br>in <span style="font-family:${SERIF};font-weight:400;font-style:italic;letter-spacing:-0.27px;">formation</span>.</span>
      </td></tr>
      <tr><td align="center" style="padding-bottom:36px;">
        <span style="font-family:${SANS};font-size:14.5px;line-height:1.75;color:${SLATE};">Claude Code, OpenCode, and Codex in one workspace,<br>sharing one memory. ${at} pulled up the second chair.</span>
      </td></tr>

      <!-- The cockpit as the app actually stacks it: one workspace, its agents
           listed under it, all three engines the sentence above promises.
           Names, kinds and intents are lifted from the site's own mock so the
           two demos cannot drift into describing different products. -->
      <tr><td style="padding-bottom:32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${ELEV};border:1px solid ${HAIR_ON_ELEV};border-radius:12px;">
          <tr><td style="background-color:${PAPER_2};padding:11px 15px;border-bottom:1px solid ${HAIR_ON_ELEV};border-radius:11px 11px 0 0;">
            <span style="font-size:11px;color:#F2A69B;">&#9679;</span>
            <span style="font-size:11px;color:#F4D49B;">&#9679;</span>
            <span style="font-size:11px;color:#A9D9AE;">&#9679;</span>
            <span style="font-family:${MONO};font-size:10.5px;color:${SLATE_SOFT};">&nbsp;&nbsp;flock &#183; your-project</span>
          </td></tr>
${agentRow("Ozzy", "claude", "working", "1m", "Fix the flaky pty_resize_race test")}
${agentRow("Wren", "codex", "working", "2m", "Refactor the token-bucket store")}
${agentRow("Lark", "opencode", "needs input", "3m", "Wire the merge queue into the PR hub")}
        </table>
      </td></tr>

      <tr><td align="center" style="padding-bottom:14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="background-color:${INK};border-radius:10px;">
            <a href="${cta}" style="display:block;padding:16px 0;font-family:${SANS};font-size:15px;font-weight:700;color:${PAPER};text-decoration:none;">Download for Mac&nbsp;&nbsp;&#8594;</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td align="center" style="padding-bottom:36px;">
        <span style="font-family:${SANS};font-size:12.5px;color:${SLATE_SOFT};">Free and open source. No card required.</span><br>
        <span style="font-family:${SANS};font-size:11.5px;line-height:2;color:${SLATE_SOFT};">Apple Silicon &#183; macOS 12+</span>
      </td></tr>

      <tr><td align="center" style="border-top:1px solid ${HAIR_SOFT_ON_PAPER};padding-top:26px;">
        <span style="font-family:${SANS};font-size:12.5px;line-height:1.75;color:${SLATE_SOFT};">Sign in with Google using <span style="color:${INK};">this email address</span><br>and you and <span style="color:${INK};font-weight:600;">${at}</span> are connected automatically.</span>
      </td></tr>

    </table>
  </td></tr>

  <tr><td align="center" style="padding:20px 8px 0;">
    <span style="font-family:${MONO};font-size:10px;color:${SLATE_SOFT};">theflock.sh &#183; sent because ${at} invited this address</span><br>
    <span style="font-family:${MONO};font-size:9px;letter-spacing:2.5px;color:${SLATE_SOFT};">GEESE FLY AT FIRST LIGHT</span>
  </td></tr>
</table>

</td></tr></table>
</body></html>
`;
}

// The comments above are for whoever edits this next, not for the person
// receiving the mail, and they were going out over the wire: 14% of the
// delivered payload was design commentary. Strip them at send time so the
// source stays annotated and the recipient gets the markup.
//
// Outlook's conditional comments are load-bearing markup, not commentary, so
// anything opening with `<!--[` survives. There are none today; there will be
// the first time this template needs an mso fallback.
function stripComments(html: string): string {
  return html.replace(/<!--(?!\[)[\s\S]*?-->/g, "").replace(/\n\s*\n\s*\n/g, "\n\n");
}

function inviteText(inv: Inviter): string {
  const who = inv.displayName ? `${inv.displayName} (@${inv.handle})` : `@${inv.handle}`;
  return (
    `${who} invited you to flock.\n\n` +
    `flock is the agentic development environment: Claude Code, OpenCode, and Codex ` +
    `in one cockpit, sharing one memory. @${inv.handle} pulled up the second chair.\n\n` +
    `Download for Mac: https://theflock.sh/?ref=${encodeURIComponent(inv.handle)}\n` +
    `Free and open source. No card required. Apple Silicon, macOS 12+.\n\n` +
    `Sign in with Google using this email address and you and @${inv.handle} are connected automatically.`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const { token, email } = req.body ?? {};
  if (!token || !email) return res.status(400).json({ error: "missing token or email" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "invalid email" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY not configured" });

  const inviter = await verifyInviter(token);
  if (!inviter) return res.status(401).json({ error: "invalid token or no handle claimed" });

  const gate = await recordInviteSend(token, email);
  if (gate === "no_invite") {
    return res.status(403).json({ error: "no pending invite for this address" });
  }
  if (gate === "rate_limited") {
    return res.status(429).json({ error: "invite rate limit reached, try again later" });
  }
  if (gate !== "ok") {
    return res.status(500).json({ error: "invite check failed" });
  }

  const subjectWho = inviter.displayName ?? `@${inviter.handle}`;
  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: `${subjectWho} invited you to flock`,
      html: stripComments(inviteHtml(inviter)),
      text: inviteText(inviter),
      // An invite is one person mailing another, not bulk, so Gmail's
      // one-click POST requirement does not apply. The mailto still gives
      // filters the opt-out signal they look for on an HTML mail, and it
      // reaches a real inbox: friends@ forwards via ForwardEmail.
      headers: {
        "List-Unsubscribe": "<mailto:friends@theflock.sh?subject=unsubscribe>",
      },
    }),
  });

  if (!sendRes.ok) {
    console.error(`resend send failed: ${sendRes.status} ${await sendRes.text()}`);
    return res.status(502).json({ error: "send failed" });
  }
  return res.json({ sent: true });
}
