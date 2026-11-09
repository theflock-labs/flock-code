# sqlx-sqlite 0.9.0, patched by flock

This is the crates.io source of `sqlx-sqlite` 0.9.0 with one change, in
`Cargo.toml`:

```diff
 [dependencies.libsqlite3-sys]
-version = ">=0.30.1, <0.38.0"
+version = ">=0.30.1, <0.40.0"
```

Upstream merged the same bound on 2026-11-08 (launchbadge/sqlx#4502,
"Bump the upper bound on libsqlite3-sys to allow 0.39.x") but had not
released it when RUSTSEC-2026-0459 (CVE-2026-119375, SQLite before 3.54)
was published. libsqlite3-sys 0.39 bundles SQLite 3.54, and flock's release
gate does not waive a vulnerability in the shipped dependency graph, so the
bound is relaxed here instead.

It is wired in through `[patch.crates-io]` in the workspace `Cargo.toml`.
Delete that entry and this directory once a released `sqlx-sqlite` allows
libsqlite3-sys 0.39, then `cargo update -p sqlx-sqlite`.
