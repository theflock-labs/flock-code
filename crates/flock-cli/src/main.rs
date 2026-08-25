use anyhow::Result;
use flock_core::{db, paths, AppEvent, EventBus, WorkspaceManager};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    // Resolving the data directory is what performs the one-time `~/.clarence`
    // move, and it has to happen before the log file is opened, because that
    // file lives inside the directory being moved. The TUI is a plausible first
    // post-rebrand launch, so it runs the same migration the desktop app does
    // rather than opening an empty DB beside the user's real one.
    let log_dir = paths::shared_data_dir();
    std::fs::create_dir_all(&log_dir)?;
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("flock.log"))?;
    tracing_subscriber::fmt()
        .with_writer(log_file)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("flock=debug".parse()?),
        )
        .init();

    log_data_dir_migration();

    // `db_path`, not a bare join: a migration that moved the directory but
    // failed to rename the file inside it leaves `clarence.db` there, and
    // opening the new name would create an empty database next to it.
    let db_path = paths::db_path();
    let pool = db::init_pool(&db_path).await?;
    let wm = Arc::new(WorkspaceManager::new(pool));

    let bus = EventBus::new();

    // Start the knowledge layer in the background (best-effort — TUI works without it).
    // CLARENCE_KG_URL is the pre-rebrand name, still honoured because agent hooks
    // already installed in users' ~/.claude/settings.json set it and those files
    // aren't ours to rewrite. Deprecated: drop the fallback a few releases out.
    let kg_url = std::env::var("FLOCK_KG_URL")
        .or_else(|_| std::env::var("CLARENCE_KG_URL"))
        .unwrap_or_else(|_| "postgresql://flock:flock@localhost:15432/flock_kg".into());

    tokio::spawn(run_knowledge_layer(kg_url, bus.clone()));

    flock_tui::run(wm, bus).await?;

    Ok(())
}

/// Connect to the knowledge layer and report availability on the event bus.
async fn run_knowledge_layer(kg_url: String, bus: EventBus) {
    match flock_kg::KnowledgeGraph::connect(&kg_url).await {
        Ok(_) => {
            bus.publish(AppEvent::KgAvailable);
            tracing::info!("knowledge layer connected");
        }
        Err(e) => {
            tracing::warn!("knowledge layer unavailable: {e}");
            bus.publish(AppEvent::KgUnavailable);
        }
    }
}

/// Report how the data directory got where it is. Called once tracing is up:
/// the migration itself runs before that, since the log file it would write to
/// lives inside the directory being migrated.
fn log_data_dir_migration() {
    use paths::Migration;
    let outcome = paths::shared_data_dir_outcome();
    let dir = outcome.dir.display();
    match &outcome.migration {
        Migration::NotNeeded => {}
        Migration::Moved => tracing::info!(dir = %dir, "migrated ~/.clarence to ~/.flock"),
        Migration::Copied => tracing::info!(
            dir = %dir,
            "copied ~/.clarence to ~/.flock; the old directory was left in place and can be removed by hand"
        ),
        Migration::Failed(err) => tracing::warn!(
            dir = %dir,
            error = %err,
            "could not migrate ~/.clarence to ~/.flock; still reading the old location"
        ),
    }
    if let Some(err) = &outcome.db_rename_error {
        tracing::warn!(error = %err, "could not rename clarence.db to flock.db; opening the old name");
    }
}
