use anyhow::Result;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

pub async fn init_pool(db_path: &Path) -> Result<SqlitePool> {
    // WAL + a busy timeout so the concurrent writers (the 15s pane-buffer
    // persist pass, workspace_state saves, prompt queue, presence updates)
    // don't serialize on the rollback-journal lock and hit SQLITE_BUSY. Normal
    // synchronous is the standard safe pairing with WAL for desktop use.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    reclaim_free_pages(&pool).await;

    Ok(pool)
}

/// Free pages above which the file is worth rewriting, as a fraction of the
/// whole. Two conditions, not one: a mostly-empty database is only worth
/// vacuuming if there is also real space in it, and a large database is only
/// worth vacuuming if a real share of it is dead.
const VACUUM_FREE_RATIO: f64 = 0.25;
const VACUUM_MIN_FREE_BYTES: i64 = 4 * 1024 * 1024;

/// Give back the space deleted rows left behind.
///
/// The workload is churn: pane buffers rewritten every 15 seconds and pruned at
/// 14 days, workspace_state blobs replaced on every layout change. SQLite keeps
/// those pages on a free list and reuses them, but it never returns them to the
/// filesystem, and `auto_vacuum` cannot be turned on after the fact without the
/// full rewrite this does. Left alone the file only grows: the first machine
/// looked at was 10 MB holding 2.5 MB of live data.
///
/// Best-effort and silent. A failed VACUUM (no disk space for the temporary
/// copy, another connection holding a read) costs nothing but the space it
/// would have freed, and must never stop the app opening.
async fn reclaim_free_pages(pool: &SqlitePool) {
    let page_size: i64 = match sqlx::query_scalar("PRAGMA page_size").fetch_one(pool).await {
        Ok(v) => v,
        Err(_) => return,
    };
    let (free, total): (i64, i64) = match (
        sqlx::query_scalar("PRAGMA freelist_count").fetch_one(pool).await,
        sqlx::query_scalar("PRAGMA page_count").fetch_one(pool).await,
    ) {
        (Ok(f), Ok(t)) => (f, t),
        _ => return,
    };
    if total <= 0 {
        return;
    }
    let free_bytes = free.saturating_mul(page_size);
    if free_bytes < VACUUM_MIN_FREE_BYTES || (free as f64 / total as f64) < VACUUM_FREE_RATIO {
        return;
    }
    if let Err(e) = sqlx::query("VACUUM").execute(pool).await {
        tracing::warn!(target: "flock_core", error = %e, "VACUUM failed; continuing");
        return;
    }
    // In WAL mode VACUUM rewrites the database *into the WAL*, so on its own it
    // moves the bloat from one file to another and the main file does not
    // shrink until something checkpoints — which might be minutes away, or not
    // this session at all. TRUNCATE folds it back and drops the WAL to zero,
    // which is the point of having run the VACUUM.
    if let Err(e) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool).await {
        tracing::warn!(target: "flock_core", error = %e, "post-VACUUM checkpoint failed");
        return;
    }
    tracing::info!(
        target: "flock_core",
        freed_bytes = free_bytes,
        "vacuumed the workspace database"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch_db(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-db-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("flock.db")
    }

    fn file_len(p: &Path) -> u64 {
        std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }

    /// Write enough pane buffers to matter, delete them, and reopen. The churn
    /// is the real workload in miniature: buffers rewritten constantly and
    /// pruned at 14 days, which is how a 2.5 MB database ends up a 10 MB file.
    #[tokio::test]
    async fn reopening_reclaims_space_left_by_deleted_rows() {
        let path = scratch_db("vacuum");
        let pool = init_pool(&path).await.unwrap();

        let blob = vec![b'x'; 256 * 1024];
        for i in 0..40 {
            sqlx::query("INSERT INTO pane_buffers (pane_id, workspace_id, data, updated_at) VALUES (?, 'ws', ?, 0)")
                .bind(format!("pane-{i}"))
                .bind(&blob)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM pane_buffers").execute(&pool).await.unwrap();
        // Fold the WAL back in, so the file on disk is the one being measured
        // rather than a stub with 10 MB sitting beside it.
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.unwrap();
        let bloated = file_len(&path);
        assert!(bloated > 8 * 1024 * 1024, "expected a bloated file, got {bloated} bytes");
        pool.close().await;

        let pool = init_pool(&path).await.unwrap();
        pool.close().await;

        let reclaimed = file_len(&path);
        assert!(
            reclaimed < bloated / 4,
            "expected the reopen to reclaim the free list: {bloated} -> {reclaimed}"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The other half of the contract: a database that is merely small must not
    /// pay for a rewrite on every launch.
    #[tokio::test]
    async fn a_healthy_database_is_left_alone() {
        let path = scratch_db("healthy");
        let pool = init_pool(&path).await.unwrap();
        sqlx::query("INSERT INTO pane_buffers (pane_id, workspace_id, data, updated_at) VALUES ('p', 'ws', ?, 0)")
            .bind(vec![b'x'; 4096])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.unwrap();
        let before = file_len(&path);
        pool.close().await;

        let pool = init_pool(&path).await.unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM pane_buffers")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;

        assert_eq!(rows, 1, "vacuum must never cost rows");
        assert_eq!(file_len(&path), before, "small database should not be rewritten");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
