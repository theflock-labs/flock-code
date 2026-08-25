use crate::types::{AgentId, AgentStatus};
use bytes::Bytes;
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub enum AppEvent {
    AgentOutput {
        agent_id: AgentId,
        data: Bytes,
    },
    AgentStatusChanged {
        agent_id: AgentId,
        status: AgentStatus,
    },
    AgentExited {
        agent_id: AgentId,
        exit_code: i32,
    },
    /// Knowledge layer became available (Docker + Postgres up and healthy).
    KgAvailable,
    /// Knowledge layer is not reachable.
    KgUnavailable,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<AppEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self { tx }
    }

    pub fn publish(&self, event: AppEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
