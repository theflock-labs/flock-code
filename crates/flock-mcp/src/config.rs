//! Resolve the managed graph without embedding a shared database password.

use anyhow::{bail, Context, Result};
use std::path::Path;

pub fn graph_url() -> Result<String> {
    if let Some(url) = crate::env::var("FLOCK_KG_URL") {
        if !is_legacy_local(&url) {
            return validate_url(url);
        }
    }
    let home =
        std::env::var_os("HOME").context("HOME is unavailable; set FLOCK_KG_URL explicitly")?;
    read_runtime_url(&Path::new(&home).join(".flock/graph/runtime-url"))
}

fn is_legacy_local(url: &str) -> bool {
    matches!(
        url.trim(),
        "postgresql://flock:flock@localhost:15432/flock_kg"
            | "postgresql://flock:flock@127.0.0.1:15432/flock_kg"
    )
}

fn validate_url(url: String) -> Result<String> {
    let url = url.trim();
    if !(url.starts_with("postgresql://") || url.starts_with("postgres://"))
        || url.chars().any(char::is_control)
    {
        bail!("Graph connection must be a nonempty PostgreSQL URL");
    }
    Ok(url.to_owned())
}

fn read_runtime_url(path: &Path) -> Result<String> {
    let url = flock_pty::egress::read_private_file(path).context(
        "Local graph credentials are unavailable. Start or upgrade the engine in flock Settings → Graph, or set FLOCK_KG_URL for a team graph",
    )?;
    validate_url(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_non_postgres_and_multiline_configuration() {
        for value in [
            "",
            "https://example.test",
            "postgresql://user@localhost/db\nother",
        ] {
            assert!(validate_url(value.to_owned()).is_err());
        }
        assert_eq!(
            validate_url("postgresql://user@localhost/db\n".into()).unwrap(),
            "postgresql://user@localhost/db"
        );
    }

    #[test]
    fn recognizes_only_the_previous_managed_credentials() {
        assert!(is_legacy_local(
            "postgresql://flock:flock@localhost:15432/flock_kg"
        ));
        assert!(!is_legacy_local(
            "postgresql://flock:secret@localhost:15432/flock_kg"
        ));
        assert!(!is_legacy_local(
            "postgresql://flock:flock@team.example:15432/flock_kg"
        ));
    }

    #[test]
    fn credentials_must_exist_and_be_private() {
        let directory = std::env::temp_dir().join(format!(
            "flock-mcp-credentials-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("runtime-url");
        assert!(read_runtime_url(&path).is_err());
        std::fs::write(&path, "postgresql://runtime:fixture@localhost/db\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_runtime_url(&path).is_err());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            read_runtime_url(&path).unwrap(),
            "postgresql://runtime:fixture@localhost/db"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
