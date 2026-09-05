The desktop graph is managed through **Settings → flock Graph → Start the engine**. Start it once after upgrading to provision private credentials, rotate the old administrator password and apply migrations. The existing `flock-graph_flock-graph-data` volume remains in place. A running container without secure provisioning is shown as requiring setup.

The older development stack in this directory uses a different volume. Start or upgrade it with:

```sh
cargo build -p flock-mcp --locked
FLOCK_MCP_BINARY=target/debug/flock-mcp python3 docker/secure-local-graph.py
```

The script preserves `flock-pg-data`, creates private credentials in `docker/.graph-secrets`, rotates the existing password through the container's local socket, and applies schema migrations before publishing `runtime-url`. Interrupted runs reuse the saved credentials and can be retried. It never removes a container's data volume. Do not run the desktop and legacy stacks together: both reserve loopback port 15432.

Keep a backup of the data volume and its credential files together. Do not delete or regenerate `credentials.json` as a troubleshooting step. The administrator credential is used for migrations; agents and the desktop use `flock_app`, which has table read/write access but cannot create roles, databases, schema objects or read server files. This is a local single-user database; the runtime credential authorizes access to the whole local graph, not a tenant boundary.

For the desktop, `flock-mcp` discovers `~/.flock/graph/runtime-url` automatically. For this development stack, explicitly set `FLOCK_KG_URL` from `docker/.graph-secrets/runtime-url` in your local process configuration. Never commit either credential file or a generated URL. Both compose entry points publish Postgres only on `127.0.0.1`; there is no built-in password.

To administer a team database, run `FLOCK_KG_URL=<admin URL> flock-mcp migrate` in an operator-controlled environment and configure normal clients with a separate role that has only the permissions they need.
