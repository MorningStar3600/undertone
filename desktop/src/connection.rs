use crate::bridge::{Ipc, MAX_MESSAGE, RoomAddress, allowed_outbound};
use async_channel::Sender;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::{
    runtime::{Builder, Handle},
    sync::{mpsc, oneshot},
    task::AbortHandle,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

#[derive(Debug)]
pub enum EventKind {
    Message(Value),
    Failed(&'static str),
    Ipc { host: u64, data: Ipc },
}

#[derive(Debug)]
pub struct Event {
    pub generation: u64,
    pub kind: EventKind,
}

/// One current-thread Tokio runtime, one OS thread, zero networking until Join.
pub struct Network {
    handle: Handle,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct Connection {
    sender: mpsc::Sender<Value>,
    abort: AbortHandle,
}

impl Connection {
    pub fn send(&self, message: Value) -> bool {
        allowed_outbound(&message) && self.sender.try_send(message).is_ok()
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.abort.abort();
    }
}
impl Drop for Network {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Network {
    pub fn new() -> anyhow::Result<Self> {
        let runtime = Builder::new_current_thread().enable_all().build()?;
        let handle = runtime.handle().clone();
        let (shutdown, wait) = oneshot::channel();
        std::thread::Builder::new()
            .name("undertone-network".into())
            .spawn(move || {
                runtime.block_on(async {
                    let _ = wait.await;
                });
            })?;
        Ok(Self {
            handle,
            shutdown: Some(shutdown),
        })
    }

    pub fn connect(
        &self,
        generation: u64,
        address: RoomAddress,
        events: Sender<Event>,
    ) -> Connection {
        let (sender, receiver) = mpsc::channel(32);
        let task = self.handle.spawn(async move {
            if let Err(code) = run(generation, address, receiver, &events).await {
                let _ = events
                    .send(Event {
                        generation,
                        kind: EventKind::Failed(code),
                    })
                    .await;
            }
        });
        Connection {
            sender,
            abort: task.abort_handle(),
        }
    }
}

async fn run(
    generation: u64,
    address: RoomAddress,
    mut outgoing: mpsc::Receiver<Value>,
    events: &Sender<Event>,
) -> Result<(), &'static str> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "connectionFailed")?;
    let mut response = client
        .get(address.grant)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "connectionFailed")?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "connectionFailed")? {
        if body.len() + chunk.len() > 16 * 1024 {
            return Err("connectionFailed");
        }
        body.extend_from_slice(&chunk);
    }
    let grant: Value = serde_json::from_slice(&body).map_err(|_| "connectionFailed")?;
    let token = grant["token"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= 8192)
        .ok_or("connectionFailed")?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        connect_async_with_config(address.socket.as_str(), Some(config), false),
    )
    .await
    .map_err(|_| "connectionFailed")?
    .map_err(|_| "connectionFailed")?;
    // Temporary guest credential never enters a browser, log, file, error, or UI event.
    socket
        .send(Message::Text(
            json!({"action":"auth", "token":token}).to_string().into(),
        ))
        .await
        .map_err(|_| "connectionFailed")?;
    drop(grant);
    drop(body);
    let mut capability = false;
    let capability_deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(capability_deadline);
    let mut sends = Vec::with_capacity(32);
    let mut snapshot: Option<(String, tokio::time::Instant)> = None;
    loop {
        let snapshot_deadline = snapshot
            .as_ref()
            .map(|(_, deadline)| *deadline)
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(60));
        tokio::select! {
            _ = &mut capability_deadline, if !capability => return Err("protocolRequired"),
            _ = tokio::time::sleep_until(snapshot_deadline), if snapshot.is_some() => return Err("invalidTimeline"),
            message = outgoing.recv() => {
                let Some(message) = message else { return Ok(()); };
                let now = Instant::now();
                sends.retain(|at| now.duration_since(*at) < Duration::from_secs(10));
                if !allowed_outbound(&message) || sends.len() >= 32 { return Err("bridgeFailed"); }
                sends.push(now);
                if message["action"] == "playback-subscribe" {
                    // Retry subscriptions must not perpetually postpone the first response deadline.
                    let deadline = snapshot.as_ref().map(|(_, deadline)| *deadline)
                        .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(15));
                    snapshot = Some((message["nonce"].as_str().unwrap().to_owned(), deadline));
                }
                socket.send(Message::Text(message.to_string().into())).await.map_err(|_| "connectionFailed")?;
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_MESSAGE { return Err("invalidTimeline"); }
                        let message: Value = serde_json::from_str(&text).map_err(|_| "invalidTimeline")?;
                        if message["action"] == "playback-capabilities" { capability = true; }
                        if message["action"] == "playback-snapshot" && snapshot.as_ref().is_some_and(|(nonce, _)| message["nonce"] == *nonce) {
                            snapshot = None;
                        }
                        // Drop everything else, including user/chat/legacy/auth payloads.
                        if matches!(message["action"].as_str(), Some("playback-capabilities" | "playback-snapshot" | "playback-event" | "playback-result" | "clock-reply")) {
                            events.send(Event { generation, kind: EventKind::Message(message) }).await.map_err(|_| "bridgeFailed")?;
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => socket.send(Message::Pong(bytes)).await.map_err(|_| "connectionFailed")?,
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None => return Err("connectionFailed"),
                    Some(Err(_)) | Some(Ok(_)) => return Err("connectionFailed"),
                }
            }
        }
    }
}
