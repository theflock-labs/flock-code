use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex, time::Duration};

// ─── Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GhFriend {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Serialize)]
pub struct GitHubStatus {
    pub connected: bool,
    pub user: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub repo: String,      // "owner/repo" format
    pub state: String,
    pub body: Option<String>,
    pub updated_at: String,
    /// The PR's head branch name. Only populated by `workspace_prs` (the
    /// repos/{owner}/{repo}/pulls endpoint returns it directly); the
    /// search-based `list_prs` leaves it empty since that endpoint doesn't
    /// include it.
    pub head_ref: String,
}

/// One row in the watch-repo picker.
#[derive(Debug, Serialize)]
pub struct RepoOption {
    pub full_name: String,
    pub private: bool,
    pub fork: bool,
    pub description: Option<String>,
    /// Last push, ISO8601. Orders the picker so live repos come first; empty
    /// for a repo that has never been pushed to.
    pub pushed_at: String,
}

#[derive(Debug, Serialize)]
pub struct CheckRun {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Review {
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

#[derive(Debug, Serialize)]
pub struct PrDetails {
    pub checks: Vec<CheckRun>,
    pub reviews: Vec<Review>,
    /// The PR's source branch (e.g. "feat/x").
    pub head_ref: String,
    /// The branch the PR merges into (e.g. "master").
    pub base_ref: String,
    /// "open" or "closed" — the merge queue must drop PRs closed externally.
    pub state: String,
    pub merged: bool,
    /// Whether any review has state APPROVED. Computed over the *unfiltered*
    /// review list: `reviews` below drops empty-body entries for display, and
    /// plain approvals usually have no body at all.
    pub approved: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceChecks {
    pub pr_number: u64,
    pub pr_title: String,
    pub pr_url: String,
    pub pr_state: String,
    pub pr_author: String,
    pub base_ref: String,
    pub head_ref: String,
    pub commits: u64,
    pub additions: u64,
    pub deletions: u64,
    pub checks: Vec<CheckRun>,
    /// owner/repo for this workspace, so a merge observer can fetch the PR's
    /// changed files without re-resolving the git remote.
    pub owner_repo: String,
}

// ─── File helpers ─────────────────────────────────────────────────────────

fn token_path() -> PathBuf {
    data_dir().join("github_token")
}

/// The shared `~/.flock` (machine-level, not instance-level: one PAT per
/// machine). flock-core owns the path so the `~/.clarence` migration runs once,
/// before anything here reads a token that hasn't moved yet.
fn data_dir() -> PathBuf {
    flock_core::paths::shared_data_dir()
}

fn read_token() -> Option<String> {
    let p = token_path();
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn write_token(token: &str) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = token_path();
    // Owner-only (0o600) so other users on a multi-user box can't read the
    // PAT. Create with the mode set from the start (no world-readable window),
    // and also fix an existing file's perms since mode() only applies on create.
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        use std::io::Write;

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        file.write_all(token.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, token).map_err(|e| e.to_string())
    }
}

fn delete_token() -> Result<(), String> {
    let p = token_path();
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

// ─── gh CLI helper ────────────────────────────────────────────────────────

/// Where `gh` lives, tried in order. A GUI app launched from Finder/Dock (as
/// opposed to `npm run tauri dev` in a terminal) inherits launchd's minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which doesn't include Homebrew or
/// MacPorts — so a bare `Command::new("gh")` silently fails to find it there
/// even though it works fine in dev mode.
fn gh_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("gh")];
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
        candidates.push(PathBuf::from(dir).join("gh"));
    }
    candidates
}

/// Try to get a token via `gh auth token`. Returns `None` if gh is not
/// installed anywhere we look, or the user isn't logged in.
fn gh_token() -> Option<String> {
    for gh in gh_binary_candidates() {
        match std::process::Command::new(&gh).args(["auth", "token"]).output() {
            Ok(o) if o.status.success() => {
                return String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string());
            }
            // Binary exists but the command failed (e.g. not logged in) —
            // no point trying other candidate paths.
            Ok(_) => return None,
            // This candidate path doesn't exist — try the next one.
            Err(_) => continue,
        }
    }
    None
}

// ─── GitHub API ───────────────────────────────────────────────────────────

/// The token that most recently worked. A single token isn't always enough:
/// orgs with OAuth-app access restrictions 403 the stored device-flow token
/// for repos that a `gh` CLI token can read fine, so a request may only
/// succeed on the second candidate. Remembering the winner avoids paying a
/// doomed request (plus a `gh` subprocess) on every 30s poll.
static WORKING_TOKEN: Mutex<Option<String>> = Mutex::new(None);

enum ApiError {
    /// 401/403/404 — this token was rejected or can't see the resource.
    /// Worth retrying with a different token.
    Auth(String),
    Other(String),
}

async fn api_get_with(token: &str, path: &str) -> Result<serde_json::Value, ApiError> {
    let url = format!("https://api.github.com/{}", path.trim_start_matches('/'));
    let client = reqwest::Client::builder()
        .user_agent("flock/0.1")
        .build()
        .map_err(|e| ApiError::Other(e.to_string()))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("HTTP request failed: {}", e)))?;
    let status = resp.status();
    if !status.is_success() {
        // Don't leak the API response body — it may carry internal details.
        // Surface only the status code, still classified so the caller can
        // tell an auth/visibility failure from a transient one. 404 is
        // included: GitHub answers 404 (not 403) for private repos the token
        // simply can't see.
        let msg = format!("GitHub API error {}", status);
        return Err(match status.as_u16() {
            401 | 403 | 404 => ApiError::Auth(msg),
            _ => ApiError::Other(msg),
        });
    }
    resp.json().await.map_err(|e| ApiError::Other(e.to_string()))
}

/// Every token worth trying, in priority order: the stored token (PAT or
/// device-flow), then whatever `gh auth token` yields.
fn candidate_tokens() -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(t) = read_token() {
        if !t.is_empty() {
            tokens.push(t);
        }
    }
    if let Some(t) = gh_token() {
        if !t.is_empty() && !tokens.contains(&t) {
            tokens.push(t);
        }
    }
    tokens
}

/// Whether any GitHub credential is available (stored token or `gh` CLI),
/// without exposing the token itself.
pub fn has_token() -> bool {
    !candidate_tokens().is_empty()
}

/// GET from the GitHub API, trying each available token until one works.
async fn api_get(path: &str) -> Result<serde_json::Value, String> {
    let cached = WORKING_TOKEN.lock().unwrap().clone();
    let mut last_auth_err: Option<String> = None;

    if let Some(token) = &cached {
        match api_get_with(token, path).await {
            Ok(v) => return Ok(v),
            Err(ApiError::Other(e)) => return Err(e),
            Err(ApiError::Auth(e)) => {
                *WORKING_TOKEN.lock().unwrap() = None;
                last_auth_err = Some(e);
            }
        }
    }

    for token in candidate_tokens() {
        if Some(&token) == cached.as_ref() {
            continue;
        }
        match api_get_with(&token, path).await {
            Ok(v) => {
                *WORKING_TOKEN.lock().unwrap() = Some(token);
                return Ok(v);
            }
            Err(ApiError::Auth(e)) => last_auth_err = Some(e),
            Err(ApiError::Other(e)) => return Err(e),
        }
    }

    Err(last_auth_err.unwrap_or_else(|| "Not connected to GitHub".into()))
}

/// GET raw text (not JSON) from the GitHub API with a specific `Accept` media
/// type — used to fetch a PR's unified diff via `application/vnd.github.v3.diff`.
async fn api_get_text_with(token: &str, path: &str, accept: &str) -> Result<String, ApiError> {
    let url = format!("https://api.github.com/{}", path.trim_start_matches('/'));
    let client = reqwest::Client::builder()
        .user_agent("flock/0.1")
        .build()
        .map_err(|e| ApiError::Other(e.to_string()))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("HTTP request failed: {}", e)))?;
    let status = resp.status();
    if !status.is_success() {
        // 406 = the diff exceeds GitHub's media-type size limit; surface it
        // plainly so the UI can nudge the user to open the PR on github.com.
        let msg = if status.as_u16() == 406 {
            "diff is too large to load here".to_string()
        } else {
            format!("GitHub API error {}", status)
        };
        return Err(match status.as_u16() {
            401 | 403 | 404 => ApiError::Auth(msg),
            _ => ApiError::Other(msg),
        });
    }
    resp.text().await.map_err(|e| ApiError::Other(e.to_string()))
}

/// Text counterpart to `api_get`: tries each available token until one works.
async fn api_get_text(path: &str, accept: &str) -> Result<String, String> {
    let cached = WORKING_TOKEN.lock().unwrap().clone();
    let mut last_auth_err: Option<String> = None;

    if let Some(token) = &cached {
        match api_get_text_with(token, path, accept).await {
            Ok(v) => return Ok(v),
            Err(ApiError::Other(e)) => return Err(e),
            Err(ApiError::Auth(e)) => {
                *WORKING_TOKEN.lock().unwrap() = None;
                last_auth_err = Some(e);
            }
        }
    }

    for token in candidate_tokens() {
        if Some(&token) == cached.as_ref() {
            continue;
        }
        match api_get_text_with(&token, path, accept).await {
            Ok(v) => {
                *WORKING_TOKEN.lock().unwrap() = Some(token);
                return Ok(v);
            }
            Err(ApiError::Auth(e)) => last_auth_err = Some(e),
            Err(ApiError::Other(e)) => return Err(e),
        }
    }

    Err(last_auth_err.unwrap_or_else(|| "Not connected to GitHub".into()))
}

/// The full unified diff for a pull request, as GitHub renders it.
pub async fn pr_diff(owner_repo: &str, number: u64) -> Result<String, String> {
    api_get_text(
        &format!("repos/{}/pulls/{}", owner_repo, number),
        "application/vnd.github.v3.diff",
    )
    .await
}

/// Write (POST/PUT) a JSON body to the GitHub API with one token. Unlike the
/// GET helpers, non-2xx responses surface GitHub's own "message" field —
/// merge failures ("Pull Request is not mergeable", "required status checks
/// have not succeeded") must be readable in the UI, not just a status code.
async fn api_send_with(
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    let url = format!("https://api.github.com/{}", path.trim_start_matches('/'));
    let client = reqwest::Client::builder()
        .user_agent("flock/0.1")
        .build()
        .map_err(|e| ApiError::Other(e.to_string()))?;
    let resp = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .json(body)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("HTTP request failed: {}", e)))?;
    let status = resp.status();
    if !status.is_success() {
        let api_msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|j| j["message"].as_str().map(|s| s.to_string()));
        let msg = match api_msg {
            Some(m) if !m.is_empty() => m,
            _ => format!("GitHub API error {}", status),
        };
        return Err(match status.as_u16() {
            401 | 403 | 404 => ApiError::Auth(msg),
            _ => ApiError::Other(msg),
        });
    }
    // 204-style empty bodies parse as nothing — treat that as null, not an error.
    Ok(resp.json().await.unwrap_or(serde_json::Value::Null))
}

/// Write counterpart to `api_get`: tries each available token until one works.
async fn api_send(
    method: reqwest::Method,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cached = WORKING_TOKEN.lock().unwrap().clone();
    let mut last_auth_err: Option<String> = None;

    if let Some(token) = &cached {
        match api_send_with(token, method.clone(), path, body).await {
            Ok(v) => return Ok(v),
            Err(ApiError::Other(e)) => return Err(e),
            Err(ApiError::Auth(e)) => {
                *WORKING_TOKEN.lock().unwrap() = None;
                last_auth_err = Some(e);
            }
        }
    }

    for token in candidate_tokens() {
        if Some(&token) == cached.as_ref() {
            continue;
        }
        match api_send_with(&token, method.clone(), path, body).await {
            Ok(v) => {
                *WORKING_TOKEN.lock().unwrap() = Some(token);
                return Ok(v);
            }
            Err(ApiError::Auth(e)) => last_auth_err = Some(e),
            Err(ApiError::Other(e)) => return Err(e),
        }
    }

    Err(last_auth_err.unwrap_or_else(|| "Not connected to GitHub".into()))
}

/// Submit an APPROVE review on the PR as the token's user.
pub async fn approve_pr(owner_repo: &str, number: u64, body: Option<String>) -> Result<(), String> {
    api_send(
        reqwest::Method::POST,
        &format!("repos/{}/pulls/{}/reviews", owner_repo, number),
        &serde_json::json!({
            "event": "APPROVE",
            "body": body.unwrap_or_default(),
        }),
    )
    .await
    .map(|_| ())
}

/// Merge the PR with the given method ("squash" | "merge" | "rebase").
pub async fn merge_pr(owner_repo: &str, number: u64, method: &str) -> Result<(), String> {
    api_send(
        reqwest::Method::PUT,
        &format!("repos/{}/pulls/{}/merge", owner_repo, number),
        &serde_json::json!({ "merge_method": method }),
    )
    .await
    .map(|_| ())
}

/// GitHub's computed mergeability for a PR. `mergeable` is calculated lazily
/// server-side, so it can be `null` on the first fetch after a push — callers
/// must treat `None` as "still computing", not "no".
#[derive(Debug, Serialize)]
pub struct PrMeta {
    pub mergeable: Option<bool>,
    /// clean | dirty (conflicts) | behind | blocked | unstable | draft | unknown.
    pub mergeable_state: String,
    pub base_ref: String,
    pub head_ref: String,
}

pub async fn pr_meta(owner_repo: &str, number: u64) -> Result<PrMeta, String> {
    let json = api_get(&format!("repos/{}/pulls/{}", owner_repo, number)).await?;
    Ok(PrMeta {
        mergeable: json["mergeable"].as_bool(),
        mergeable_state: json["mergeable_state"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        base_ref: json["base"]["ref"].as_str().unwrap_or("").to_string(),
        head_ref: json["head"]["ref"].as_str().unwrap_or("").to_string(),
    })
}

/// Ask GitHub to update the PR's head branch from its base (the web UI's
/// "Update branch" button; merge vs. rebase follows the repo's settings).
/// Non-2xx surfaces GitHub's own "message" via `api_send` — a 422 carries a
/// readable reason (merge conflict, or branch already up to date).
pub async fn update_pr_branch(owner_repo: &str, number: u64) -> Result<(), String> {
    api_send(
        reqwest::Method::PUT,
        &format!("repos/{}/pulls/{}/update-branch", owner_repo, number),
        &serde_json::json!({}),
    )
    .await
    .map(|_| ())
}

/// The latest substantive review per reviewer — GitHub's review list keeps
/// every superseded submission, so an author who requested changes and later
/// approved appears twice; only their newest APPROVED / CHANGES_REQUESTED /
/// COMMENTED entry counts. (`pr_details`' display list drops body-less
/// reviews, which is exactly what plain approvals are — hence this separate
/// reduction over the raw list.)
#[derive(Debug, Serialize)]
pub struct PrApproval {
    pub author: String,
    pub state: String,
    pub submitted_at: String,
}

pub async fn pr_approvals(owner_repo: &str, number: u64) -> Result<Vec<PrApproval>, String> {
    let json = api_get(&format!(
        "repos/{}/pulls/{}/reviews?per_page=100",
        owner_repo, number
    ))
    .await?;
    let items = json.as_array().cloned().unwrap_or_default();
    let mut latest: std::collections::HashMap<String, PrApproval> =
        std::collections::HashMap::new();
    for r in &items {
        let state = r["state"].as_str().unwrap_or("");
        if !matches!(state, "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED") {
            continue; // PENDING / DISMISSED never count
        }
        let author = r["user"]["login"].as_str().unwrap_or("").to_string();
        if author.is_empty() {
            continue;
        }
        let submitted_at = r["submitted_at"].as_str().unwrap_or("").to_string();
        // ISO8601 timestamps compare correctly as strings.
        let newer = latest
            .get(&author)
            .map_or(true, |prev| submitted_at >= prev.submitted_at);
        if newer {
            latest.insert(
                author.clone(),
                PrApproval { author, state: state.to_string(), submitted_at },
            );
        }
    }
    let mut out: Vec<PrApproval> = latest.into_values().collect();
    out.sort_by(|a, b| a.submitted_at.cmp(&b.submitted_at));
    Ok(out)
}

/// Dry-run the PR against its base in a local checkout and list conflicting
/// paths, without touching any user branch or worktree. Fetches both sides
/// into force-updated temp refs under `refs/flock/`, then asks
/// `git merge-tree --write-tree` (git >= 2.38) what a merge would do: exit 0
/// means clean (empty vec), exit 1 lists the conflicted paths after the tree
/// oid on the first line. Temp refs are deleted best-effort afterwards.
pub fn analyze_pr_conflicts(
    repo_path: &str,
    number: u64,
    base_ref: &str,
) -> Result<Vec<String>, String> {
    if base_ref.is_empty()
        || base_ref.starts_with('-')
        || base_ref == "HEAD"
        || base_ref.contains('\0')
    {
        return Err(format!("invalid base ref: '{}'", base_ref));
    }

    let pr_ref = format!("refs/flock/pr-{}", number);
    let base_tmp = format!("refs/flock/base-{}", number);

    let fetch = std::process::Command::new("git")
        .args([
            "-C",
            repo_path,
            "fetch",
            "origin",
            &format!("+refs/pull/{}/head:{}", number, pr_ref),
            &format!("+refs/heads/{}:{}", base_ref, base_tmp),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !fetch.status.success() {
        // Sanitize — stderr can carry the remote URL.
        return Err("git fetch failed".to_string());
    }

    let merge = std::process::Command::new("git")
        .args([
            "-C",
            repo_path,
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &base_tmp,
            &pr_ref,
        ])
        .output();

    // Clean up the temp refs whatever merge-tree said; best-effort.
    for r in [&pr_ref, &base_tmp] {
        let _ = std::process::Command::new("git")
            .args(["-C", repo_path, "update-ref", "-d", r])
            .output();
    }

    let merge = merge.map_err(|e| e.to_string())?;
    match merge.status.code() {
        Some(0) => Ok(Vec::new()),
        Some(1) => Ok(String::from_utf8_lossy(&merge.stdout)
            .lines()
            .skip(1) // first line is the (partial) tree oid
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()),
        // Any other exit code: pre-2.38 git (no --write-tree), bad refs, etc.
        _ => Err("git merge-tree failed (requires git >= 2.38)".to_string()),
    }
}

// ─── OAuth Device Flow ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DeviceFlowStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub async fn oauth_device_start(client_id: &str) -> Result<DeviceFlowStart, String> {
    let client = reqwest::Client::builder()
        .user_agent("flock/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "read:user,user:follow,repo")])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = json["error"].as_str() {
        return Err(format!("{}: {}", err, json["error_description"].as_str().unwrap_or("")));
    }

    Ok(DeviceFlowStart {
        user_code: json["user_code"].as_str().unwrap_or("").to_string(),
        verification_uri: json["verification_uri"].as_str()
            .unwrap_or("https://github.com/activate").to_string(),
        device_code: json["device_code"].as_str().unwrap_or("").to_string(),
        interval: json["interval"].as_u64().unwrap_or(5),
        expires_in: json["expires_in"].as_u64().unwrap_or(900),
    })
}

/// Poll until the user authorizes. Stores the token and returns it on success.
pub async fn oauth_device_poll(client_id: &str, device_code: &str, interval: u64) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("flock/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    let mut poll_interval = Duration::from_secs(interval);

    loop {
        if tokio::time::Instant::now() > deadline {
            return Err("authorization timed out".into());
        }
        tokio::time::sleep(poll_interval).await;

        let resp = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        match json["error"].as_str() {
            None => {
                let token = json["access_token"].as_str()
                    .ok_or("no access_token in response")?
                    .to_string();
                write_token(token.trim())?;
                return Ok(token);
            }
            Some("authorization_pending") => continue,
            Some("slow_down") => { poll_interval += Duration::from_secs(5); continue; }
            Some(e) => return Err(format!("{}: {}", e,
                json["error_description"].as_str().unwrap_or(""))),
        }
    }
}

// ─── Public commands ──────────────────────────────────────────────────────

pub async fn check_connection() -> GitHubStatus {
    match api_get("user").await {
        Ok(json) => GitHubStatus {
            connected: true,
            user: json["login"].as_str().map(|s| s.to_string()),
            avatar_url: json["avatar_url"].as_str().map(|s| s.to_string()),
        },
        Err(_) => GitHubStatus {
            connected: false,
            user: None,
            avatar_url: None,
        },
    }
}

pub fn store_pat(token: String) -> Result<(), String> {
    *WORKING_TOKEN.lock().unwrap() = None;
    write_token(token.trim())
}

pub fn disconnect() -> Result<(), String> {
    *WORKING_TOKEN.lock().unwrap() = None;
    delete_token()
}

pub async fn list_prs() -> Result<Vec<PullRequest>, String> {
    let json = api_get("search/issues?q=is:pr+is:open+author:@me&sort=updated&per_page=20").await?;
    let items = json["items"]
        .as_array()
        .ok_or_else(|| "Unexpected API response".to_string())?;
    let prs: Vec<PullRequest> = items
        .iter()
        .map(|item| {
            // repository_url = "https://api.github.com/repos/owner/repo"
            let repo = item["repository_url"]
                .as_str()
                .and_then(|u| {
                    let parts: Vec<&str> = u.rsplitn(3, '/').collect();
                    if parts.len() >= 2 { Some(format!("{}/{}", parts[1], parts[0])) } else { None }
                })
                .unwrap_or_else(|| "unknown/unknown".to_string());
            PullRequest {
                number: item["number"].as_u64().unwrap_or(0),
                title: item["title"].as_str().unwrap_or("").to_string(),
                author: item["user"]["login"].as_str().unwrap_or("").to_string(),
                repo,
                state: item["state"].as_str().unwrap_or("").to_string(),
                body: item["body"].as_str().map(|s| s.to_string()),
                updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
                head_ref: String::new(),
            }
        })
        .collect();
    Ok(prs)
}

/// List all open PRs (from any author) for the repo checked out at
/// `repo_path` — resolved via its git `origin` remote, not scoped to the
/// current user. Used to populate the sidebar's PR list for the focused
/// workspace so any open PR in that repo can be picked for review.
pub async fn workspace_prs(repo_path: &str) -> Result<Vec<PullRequest>, String> {
    let owner_repo = owner_repo_from_git(repo_path)
        .ok_or_else(|| "Could not resolve GitHub repo from git remote".to_string())?;
    repo_prs(&owner_repo).await
}

/// List all open PRs for an "owner/repo" slug directly — the PR-watch poll
/// works from configured slugs, with no local checkout to resolve.
pub async fn repo_prs(owner_repo: &str) -> Result<Vec<PullRequest>, String> {
    // sort=updated keeps the sidebar ordering workspace_prs always had.
    let path = format!(
        "repos/{}/pulls?state=open&sort=updated&direction=desc&per_page=50",
        owner_repo
    );
    let json = api_get(&path).await?;
    let items = json
        .as_array()
        .ok_or_else(|| "Unexpected API response".to_string())?;
    let prs: Vec<PullRequest> = items
        .iter()
        .map(|item| PullRequest {
            number: item["number"].as_u64().unwrap_or(0),
            title: item["title"].as_str().unwrap_or("").to_string(),
            author: item["user"]["login"].as_str().unwrap_or("").to_string(),
            repo: owner_repo.to_string(),
            state: item["state"].as_str().unwrap_or("").to_string(),
            body: item["body"].as_str().map(|s| s.to_string()),
            updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
            head_ref: item["head"]["ref"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(prs)
}

/// Every repo the token can see, newest push first — the pool the watch-repo
/// picker chooses from, so a slug never has to be typed from memory.
///
/// `affiliation` is spelled out rather than left to its default (which happens
/// to be the same three values): the point of the picker is that a repo you
/// only reach through an org shows up, and that shouldn't rest on a default.
///
/// Capped at 5 pages. `sort=pushed` means the tail that falls off is the
/// stalest, which is the right thing to lose — but it *is* a cap, so the
/// manual `owner/repo` field stays as the way to reach anything past it (and
/// anything you have no membership in at all, like a public repo you merely
/// want to watch).
pub async fn list_repos() -> Result<Vec<RepoOption>, String> {
    let mut repos: Vec<RepoOption> = Vec::new();
    for page in 1..=5u32 {
        let path = format!(
            "user/repos?affiliation=owner,collaborator,organization_member\
             &sort=pushed&direction=desc&per_page=100&page={}",
            page
        );
        let json = api_get(&path).await?;
        let arr = match json.as_array() {
            Some(a) if !a.is_empty() => a.clone(),
            _ => break,
        };
        let len = arr.len();
        for r in &arr {
            // An archived repo can't take a new PR, so it would only ever be
            // dead weight in the list.
            if r["archived"].as_bool().unwrap_or(false) {
                continue;
            }
            let Some(full_name) = r["full_name"].as_str() else { continue };
            repos.push(RepoOption {
                full_name: full_name.to_string(),
                private: r["private"].as_bool().unwrap_or(false),
                fork: r["fork"].as_bool().unwrap_or(false),
                description: r["description"].as_str().map(|s| s.to_string()),
                pushed_at: r["pushed_at"].as_str().unwrap_or("").to_string(),
            });
        }
        if len < 100 {
            break;
        }
    }
    // The API sorts within a page; re-sort so the seam between pages doesn't
    // show. Empty `pushed_at` (a repo with no commits) sorts last.
    repos.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
    Ok(repos)
}

/// Fetch a PR's exact head commit and check it out into a local branch named
/// after its head ref. Uses GitHub's `refs/pull/{number}/head` ref rather
/// than `origin/{head_ref}` so this works even when the PR comes from a
/// fork (where the branch doesn't exist on `origin` at all).
///
/// Fetches into `FETCH_HEAD` rather than directly into a named local branch:
/// git refuses a fetch that targets whatever branch is currently checked
/// out ("refusing to fetch into branch ... checked out"), which reliably
/// happens whenever a PR's head ref matches the repo's current branch.
/// `checkout -B <branch> FETCH_HEAD` has no such restriction — it correctly
/// resets the branch in place even if it's the one you're already on.
pub fn checkout_pr(repo_path: &str, number: u64, head_ref: &str) -> Result<(), String> {
    // Validate head_ref to prevent abuse of git branch name semantics.
    // Git branch names must be valid ref names; reject anything that looks
    // like a flag, "HEAD", or contains characters that could confuse git.
    let local_branch = if head_ref.is_empty() {
        format!("pr-{}", number)
    } else {
        if head_ref.starts_with('-') || head_ref == "HEAD" || head_ref.contains('\0') {
            return Err(format!("invalid branch name: '{}'", head_ref));
        }
        head_ref.to_string()
    };

    let fetch = std::process::Command::new("git")
        .args(["-C", repo_path, "fetch", "origin", &format!("pull/{}/head", number)])
        .output()
        .map_err(|e| e.to_string())?;
    if !fetch.status.success() {
        // Sanitize error output — don't leak remote URLs or internal paths.
        return Err("git fetch failed".to_string());
    }

    let checkout = std::process::Command::new("git")
        .args(["-C", repo_path, "checkout", "-B", &local_branch, "FETCH_HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    if !checkout.status.success() {
        return Err("git checkout failed".to_string());
    }

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PrWorktree {
    pub path: String,
    pub branch: String,
}

/// Run a git subcommand in `dir`, returning trimmed stdout. Errors name only
/// the subcommand — stderr can carry remote URLs and local paths, which the
/// hardening pass keeps out of messages that cross the IPC boundary.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !out.status.success() {
        return Err(format!("git {} failed", args.first().unwrap_or(&"")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Check out a PR's head into a dedicated git worktree under
/// `~/.flock/worktrees`, leaving the repo's own checkout untouched. This
/// is what "review" uses: the reviewing agent gets its own directory, so a
/// dirty tree or in-flight merge in the main checkout can't fail the
/// checkout — and the review can't clobber anyone's in-progress work.
/// Reviewing the same PR again reuses the worktree, reset to the PR's
/// current head.
pub fn checkout_pr_worktree(repo_path: &str, number: u64, head_ref: &str) -> Result<PrWorktree, String> {
    let branch = if head_ref.is_empty() {
        format!("pr-{}", number)
    } else {
        if head_ref.starts_with('-') || head_ref == "HEAD" || head_ref.contains('\0') {
            return Err(format!("invalid branch name: '{}'", head_ref));
        }
        head_ref.to_string()
    };

    run_git(repo_path, &["fetch", "origin", &format!("pull/{}/head", number)])?;
    let sha = run_git(repo_path, &["rev-parse", "FETCH_HEAD"])?;

    let repo_name = std::path::Path::new(repo_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo");
    let dir = data_dir()
        .join("worktrees")
        .join(format!("{}-pr-{}", repo_name, number));
    let path = dir.to_string_lossy().to_string();
    // The PR branch may be checked out in another worktree (often the main
    // checkout itself) — git refuses to share a branch across worktrees, so
    // fall back to a review-scoped branch name when that happens.
    let fallback = format!("review/pr-{}", number);

    if dir.exists() {
        for b in [&branch, &fallback] {
            if run_git(&path, &["checkout", "-B", b, &sha]).is_ok() {
                return Ok(PrWorktree { path, branch: b.clone() });
            }
        }
        return Err(
            "couldn't reuse the existing review worktree — it may have uncommitted changes".into(),
        );
    }

    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Clear any registration left behind by a manually-deleted worktree dir.
    let _ = run_git(repo_path, &["worktree", "prune"]);

    for b in [&branch, &fallback] {
        if run_git(repo_path, &["worktree", "add", &path, "-B", b, &sha]).is_ok() {
            return Ok(PrWorktree { path, branch: b.clone() });
        }
    }
    Err("git worktree add failed".into())
}

async fn fetch_logins(path: &str) -> Result<std::collections::HashSet<String>, String> {
    // Fetch up to 3 pages (300 users) — enough for almost everyone
    let mut logins = std::collections::HashSet::new();
    for page in 1..=3u32 {
        let paged = format!("{}{}page={}&per_page=100", path,
            if path.contains('?') { "&" } else { "?" }, page);
        let json = api_get(&paged).await?;
        let arr = match json.as_array() {
            Some(a) if !a.is_empty() => a.clone(),
            _ => break,
        };
        for user in &arr {
            if let Some(login) = user["login"].as_str() {
                logins.insert(login.to_string());
            }
        }
        if arr.len() < 100 { break; }
    }
    Ok(logins)
}

pub async fn list_mutual_follows() -> Result<Vec<GhFriend>, String> {
    // Fetch following and followers in parallel, then intersect
    let (following_res, followers_res) = tokio::join!(
        fetch_logins("user/following"),
        fetch_logins("user/followers"),
    );
    let following = following_res?;
    let followers = followers_res?;
    let mutual: Vec<&String> = following.intersection(&followers).collect();
    if mutual.is_empty() {
        return Ok(vec![]);
    }
    // Fetch avatar URLs for mutual follows (batch by fetching user objects)
    let mut friends = Vec::new();
    for login in mutual {
        if let Ok(json) = api_get(&format!("users/{}", login)).await {
            friends.push(GhFriend {
                login: login.clone(),
                avatar_url: json["avatar_url"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    friends.sort_by(|a, b| a.login.cmp(&b.login));
    Ok(friends)
}

pub async fn pr_details(owner_repo: &str, number: u64) -> Result<PrDetails, String> {
    // Fetch HEAD sha then check-runs and reviews in parallel
    let pr_json = api_get(&format!("repos/{}/pulls/{}", owner_repo, number)).await?;
    let sha = pr_json["head"]["sha"].as_str().unwrap_or("").to_string();
    let head_ref = pr_json["head"]["ref"].as_str().unwrap_or("").to_string();
    let base_ref = pr_json["base"]["ref"].as_str().unwrap_or("").to_string();
    let state = pr_json["state"].as_str().unwrap_or("open").to_string();
    let merged = pr_json["merged"].as_bool().unwrap_or(false);

    let checks_path = format!("repos/{}/commits/{}/check-runs?per_page=30", owner_repo, sha);
    let reviews_path = format!("repos/{}/pulls/{}/reviews?per_page=30", owner_repo, number);
    let (checks_res, reviews_res) = tokio::join!(
        api_get(&checks_path),
        api_get(&reviews_path),
    );

    let checks = checks_res
        .ok()
        .and_then(|j| j["check_runs"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|c| CheckRun {
            name: c["name"].as_str().unwrap_or("").to_string(),
            status: c["status"].as_str().unwrap_or("").to_string(),
            conclusion: c["conclusion"].as_str().map(|s| s.to_string()),
            html_url: c["html_url"].as_str().map(|s| s.to_string()),
        })
        .collect();

    let all_reviews = reviews_res
        .ok()
        .and_then(|j| j.as_array().cloned())
        .unwrap_or_default();
    let approved = all_reviews
        .iter()
        .any(|r| r["state"].as_str() == Some("APPROVED"));
    let reviews = all_reviews
        .iter()
        .filter(|r| !r["body"].as_str().unwrap_or("").is_empty())
        .map(|r| Review {
            author: r["user"]["login"].as_str().unwrap_or("").to_string(),
            state: r["state"].as_str().unwrap_or("").to_string(),
            body: r["body"].as_str().unwrap_or("").to_string(),
            submitted_at: r["submitted_at"].as_str().unwrap_or("").to_string(),
        })
        .collect();

    Ok(PrDetails { checks, reviews, head_ref, base_ref, state, merged, approved })
}

// ─── Workspace PR checks (notification bar) ───────────────────────────────

/// Resolve "owner/repo" from the `origin` remote of a local git checkout.
/// Handles both SSH (`git@github.com:owner/repo.git`) and HTTPS
/// (`https://github.com/owner/repo.git`) remote URL forms.
fn owner_repo_from_git(repo_path: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", repo_path, "remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8(out.stdout).ok()?.trim().to_string();
    let stripped = url.strip_suffix(".git").unwrap_or(&url);
    let path = if let Some(rest) = stripped.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("ssh://git@github.com/") {
        rest
    } else {
        return None;
    };
    let parts: Vec<&str> = path.splitn(2, '/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

/// The `https://github.com/owner/repo` base URL for a local checkout, or
/// `None` when the repo has no GitHub `origin` remote. Used to deep-link
/// commits/branches out to github.com.
pub fn repo_web_url(repo_path: &str) -> Option<String> {
    owner_repo_from_git(repo_path).map(|nwo| format!("https://github.com/{}", nwo))
}

/// Resolve the branch actually checked out at `repo_path` right now, via
/// `git rev-parse --abbrev-ref HEAD`. The workspace's stored `branch` field
/// is only a creation-time default (e.g. "main") and goes stale the moment
/// anyone runs `git checkout` inside the workspace — which agents do
/// constantly — so it can't be trusted for a live-status lookup.
fn current_git_branch(repo_path: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        None // detached HEAD or empty repo
    } else {
        Some(branch)
    }
}

/// Find the open PR (if any) for the branch currently checked out at
/// `repo_path`, and return its CI check-run statuses. Returns `Ok(None)`
/// when there's no open PR for the branch (not an error state).
pub async fn workspace_checks(repo_path: &str) -> Result<Option<WorkspaceChecks>, String> {
    let owner_repo = owner_repo_from_git(repo_path)
        .ok_or_else(|| "Could not resolve GitHub repo from git remote".to_string())?;
    let (owner, _) = owner_repo
        .split_once('/')
        .ok_or_else(|| "Malformed owner/repo".to_string())?;
    let branch = current_git_branch(repo_path)
        .ok_or_else(|| "Could not resolve current git branch".to_string())?;

    let pulls_path = format!(
        "repos/{}/pulls?head={}:{}&state=open",
        owner_repo, owner, branch
    );
    let pulls = api_get(&pulls_path).await?;
    let pr = match pulls.as_array().and_then(|a| a.first()) {
        Some(pr) => pr,
        None => return Ok(None),
    };

    let pr_number = pr["number"].as_u64().unwrap_or(0);
    let sha = pr["head"]["sha"].as_str().unwrap_or("").to_string();

    // The list endpoint doesn't carry commit/diff counts — only the
    // single-PR endpoint does — so fetch it alongside the check-runs.
    let pr_path = format!("repos/{}/pulls/{}", owner_repo, pr_number);
    let checks_path = format!("repos/{}/commits/{}/check-runs?per_page=30", owner_repo, sha);
    let (pr_res, checks_res) = tokio::join!(api_get(&pr_path), api_get(&checks_path));

    let pr_full = pr_res.unwrap_or_else(|_| pr.clone());
    let pr_title = pr_full["title"].as_str().unwrap_or("").to_string();
    let pr_url = pr_full["html_url"].as_str().unwrap_or("").to_string();
    let pr_state = pr_full["state"].as_str().unwrap_or("open").to_string();
    let pr_author = pr_full["user"]["login"].as_str().unwrap_or("").to_string();
    let base_ref = pr_full["base"]["ref"].as_str().unwrap_or("").to_string();
    let head_ref = pr_full["head"]["ref"].as_str().unwrap_or("").to_string();
    let commits = pr_full["commits"].as_u64().unwrap_or(0);
    let additions = pr_full["additions"].as_u64().unwrap_or(0);
    let deletions = pr_full["deletions"].as_u64().unwrap_or(0);

    let checks = checks_res
        .ok()
        .and_then(|j| j["check_runs"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|c| CheckRun {
            name: c["name"].as_str().unwrap_or("").to_string(),
            status: c["status"].as_str().unwrap_or("").to_string(),
            conclusion: c["conclusion"].as_str().map(|s| s.to_string()),
            html_url: c["html_url"].as_str().map(|s| s.to_string()),
        })
        .collect();

    Ok(Some(WorkspaceChecks {
        pr_number, pr_title, pr_url, pr_state, pr_author, base_ref, head_ref,
        commits, additions, deletions, checks,
        owner_repo,
    }))
}

/// List the file paths a PR changed (first 100 — plenty for outcome linking).
/// Used to wire a merged PR back to the decisions recorded about those files.
pub async fn pr_files(owner_repo: &str, number: u64) -> Result<Vec<String>, String> {
    let json = api_get(&format!("repos/{}/pulls/{}/files?per_page=100", owner_repo, number)).await?;
    Ok(json
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|f| f["filename"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}
