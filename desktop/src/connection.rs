use crate::bridge::{Ipc, MAX_MESSAGE, RoomAddress, allowed_outbound};
use crate::session::{
    self, ErrorCode, NativeCommand, NativeError, NativeState, RestKind, SessionCache,
};
use async_channel::Sender;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::{
    runtime::{Builder, Handle},
    sync::{mpsc, oneshot, watch},
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

/// Never block the WebView callback or silently lose playback authority.
/// A full inbox sets the captured host's terminal flag; no queued event is evicted.
pub fn enqueue_ipc(
    events: &Sender<Event>,
    generation: u64,
    host: u64,
    data: Ipc,
    overflow: &AtomicBool,
) {
    if let Err(async_channel::TrySendError::Full(_)) = events.try_send(Event {
        generation,
        kind: EventKind::Ipc { host, data },
    }) {
        overflow.store(true, Ordering::Release);
    }
}

/// One current-thread Tokio runtime, one OS thread, zero networking until Join.
pub struct Network {
    handle: Handle,
    shutdown: Option<oneshot::Sender<()>>,
    cache: Arc<Mutex<SessionCache>>,
    active: Mutex<Option<AbortHandle>>,
}

pub struct Connection {
    sender: mpsc::Sender<Value>,
    abort: AbortHandle,
    native_sender: mpsc::Sender<NativeEnvelope>,
    native: watch::Receiver<NativeState>,
}

struct NativeEnvelope {
    account: u64,
    socket: u64,
    track: u64,
    command: NativeCommand,
}

struct CacheLease {
    shared: Arc<Mutex<SessionCache>>,
    epoch: u64,
}
impl CacheLease {
    fn update(&self, update: impl FnOnce(&mut SessionCache)) {
        let mut cache = self.shared.lock().unwrap();
        if cache.epoch == self.epoch {
            update(&mut cache);
        }
    }
}

impl Connection {
    pub fn send(&self, message: Value) -> bool {
        allowed_outbound(&message) && self.sender.try_send(message).is_ok()
    }
    /// A separate native queue; never callable by WebView IPC.
    pub fn send_native(&self, command: NativeCommand) -> bool {
        let state = self.native.borrow();
        self.native_sender
            .try_send(NativeEnvelope {
                account: state.account_generation,
                socket: state.socket_generation,
                track: state.track_generation,
                command,
            })
            .is_ok()
    }
    /// Coalesced snapshots are bounded and contain no bearer/password/raw REST payload.
    pub fn subscribe_native(&self) -> watch::Receiver<NativeState> {
        self.native.clone()
    }
    pub fn native_state(&self) -> NativeState {
        self.native.borrow().clone()
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
            cache: Arc::new(Mutex::new(SessionCache::default())),
            active: Mutex::new(None),
        })
    }

    pub fn connect(
        &self,
        generation: u64,
        address: RoomAddress,
        events: Sender<Event>,
    ) -> Connection {
        let (sender, receiver) = mpsc::channel(32);
        let (native_sender, native_receiver) = mpsc::channel(8);
        let (native_state, native) = watch::channel(NativeState {
            generation,
            ..NativeState::default()
        });
        // A Network owns one active room, and one memory-only origin/base-path session.
        if let Some(task) = self.active.lock().unwrap().take() {
            task.abort();
        }
        let cache = self.cache.clone();
        let key = session::base(&address).to_string();
        let epoch = {
            let mut cache = cache.lock().unwrap();
            let epoch = cache.epoch.wrapping_add(1);
            if cache.key != key {
                *cache = SessionCache {
                    key,
                    ..SessionCache::default()
                };
            }
            cache.epoch = epoch;
            epoch
        };
        let cache = CacheLease {
            shared: cache,
            epoch,
        };
        let task = self.handle.spawn(async move {
            if let Err(code) = run(
                generation,
                address,
                receiver,
                native_receiver,
                &native_state,
                cache,
                &events,
            )
            .await
            {
                native_state.send_modify(|s| {
                    s.connected = false;
                    s.http_busy = false;
                    s.error = Some(NativeError::new(ErrorCode::Network));
                });
                let _ = events
                    .send(Event {
                        generation,
                        kind: EventKind::Failed(code),
                    })
                    .await;
            }
        });
        *self.active.lock().unwrap() = Some(task.abort_handle());
        Connection {
            sender,
            abort: task.abort_handle(),
            native_sender,
            native,
        }
    }
}

async fn run(
    generation: u64,
    address: RoomAddress,
    mut outgoing: mpsc::Receiver<Value>,
    mut native: mpsc::Receiver<NativeEnvelope>,
    state_events: &watch::Sender<NativeState>,
    cache: CacheLease,
    events: &Sender<Event>,
) -> Result<(), &'static str> {
    let client = session::client().map_err(|_| "connectionFailed")?;
    let base = session::base(&address);
    let cached = cache.shared.lock().unwrap().token.clone();
    let token = if let Some(token) = cached {
        token
    } else {
        let token = session::grant(&client, &address)
            .await
            .map_err(|_| "connectionFailed")?;
        cache.update(|cache| cache.token = Some(token.clone()));
        token
    };
    let mut state = NativeState {
        generation,
        account: cache.shared.lock().unwrap().account.clone(),
        ..NativeState::default()
    };
    'reconnect: loop {
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
        state.connected = true;
        state_events.send_replace(state.clone());
        let mut capability = false;
        let capability_deadline = tokio::time::sleep(Duration::from_secs(10));
        tokio::pin!(capability_deadline);
        let mut sends = Vec::with_capacity(32);
        let mut snapshot: Option<(String, tokio::time::Instant)> = None;
        // Keeping the future in this actor ensures abort/drop cancels all HTTP work too.
        let mut rest: Option<RestFuture> = None;
        let mut identity_busy = false;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            let snapshot_deadline = snapshot
                .as_ref()
                .map(|(_, deadline)| *deadline)
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(60));
            tokio::select! {
                _ = tick.tick() => {
                    let was_busy=state.room.busy;
                    state.room.expire(Instant::now());
                    if was_busy != state.room.busy { state_events.send_replace(state.clone()); }
                }
                command = native.recv() => {
                    let Some(envelope) = command else { return Ok(()); };
                    if envelope.account != state.account_generation || envelope.socket != state.socket_generation
                        || (matches!(envelope.command,NativeCommand::SetTag{..}|NativeCommand::LoadTrackMoods{..}) && envelope.track != state.track_generation) {
                        state.error = Some(NativeError::new(ErrorCode::Stale));
                    } else {
                        match envelope.command {
                            NativeCommand::RefreshRoom => {
                                if rest.is_some() { state.error=Some(NativeError::new(ErrorCode::Busy)); state_events.send_replace(state.clone()); continue; }
                                state.http_busy = false; state.socket_generation += 1;
                                state.connected = false; state.room = state.room.refreshed(); state.preview=None;
                                state_events.send_replace(state.clone());
                                continue 'reconnect;
                            }
                            NativeCommand::Music(command) if !state.account.expired && state.connected => {
                                if let Some(message) = state.room.prepare(command,state.preview.as_ref().map(|p|&p.reference),state.account_generation,generation,state.socket_generation) {
                                    socket.send(Message::Text(message.to_string().into())).await.map_err(|_|"connectionFailed")?;
                                }
                            }
                            command => {
                                let identity = matches!(command,NativeCommand::Login{..}|NativeCommand::Logout);
                                if rest.is_some() && (!identity || identity_busy) { state.error=Some(NativeError::new(ErrorCode::Busy)); }
                                else {
                                    match session::prepare(&client,&base,&token,&state,command) {
                                        Ok((kind,request)) => {
                                            if identity || matches!(kind,RestKind::Account) {
                                                state.account_generation += 1; state.clear_private(); state.account.expired=true; state.connected=false; state.room=Default::default();
                                                cache.update(|cache|cache.account=Default::default());
                                            }
                                            if matches!(kind,RestKind::Preview) {state.preview=None;}
                                            session::start(&mut state,&kind);
                                            state.error=None; state.http_busy=true;
                                            identity_busy=kind.identity();
                                            let client=client.clone(); let base=base.clone(); let token=token.clone();
                                            let account=state.account_generation; let track=state.track_generation;
                                            rest=Some(Box::pin(async move {
                                                let mut result=session::response(request).await;
                                                if kind.identity() && result.is_ok() {
                                                    result=session::response(client.get(base.join("user/").unwrap()).bearer_auth(token)).await;
                                                }
                                                RestCompletion {account,track,kind,result}
                                            }));
                                        }
                                        Err(error) => state.error=Some(error),
                                    }
                                }
                            }
                        }
                    }
                    state_events.send_replace(state.clone());
                }
                done = async { rest.as_mut().unwrap().await }, if rest.is_some() => {
                    rest=None; state.http_busy=false; identity_busy=false;
                    let identity=done.kind.identity();
                    if done.account==state.account_generation && done.result.as_ref().is_err_and(|e|e.code==ErrorCode::Auth) {
                        state.account_generation += 1;
                        state.clear_private();
                        state.account.expired=true;
                        state.room=Default::default();
                        cache.update(|cache| {cache.account=state.account.clone(); cache.token=None;});
                        state.error=done.result.err();
                    } else if done.account != state.account_generation || (matches!(done.kind,RestKind::Tags(..)|RestKind::Tag(_)) && done.track!=state.track_generation) {
                        state.error=Some(NativeError::new(ErrorCode::Stale));
                    } else {
                        let result=done.result.and_then(|v|session::apply(&mut state,&done.kind,v));
                        session::finish(&mut state,&done.kind,result.is_err());
                        match result {
                            Ok(()) => {
                            cache.update(|cache| { cache.account=state.account.clone(); if matches!(done.kind,RestKind::Account) {cache.token=Some(token.clone());} });
                                if identity || matches!(done.kind,RestKind::Account) {
                                    state.socket_generation += 1; state.connected=false; state.room=Default::default();
                                    state_events.send_replace(state.clone());
                                    continue 'reconnect;
                                }
                            }
                            Err(error) => {
                                state.error=Some(error);
                            }
                        }
                    }
                    state_events.send_replace(state.clone());
                }
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
                            if matches!(message["action"].as_str(),Some("sync"|"user"|"you"|"music-result")) {
                            state.room.project(&message,state.account_generation);
                            if state.connected && state.account.logged_in && state.room.own_logged_in==Some(false) {
                                state.account_generation+=1; state.clear_private(); state.account.expired=true;
                                cache.update(|cache|cache.account=state.account.clone());
                            }
                            state.track_changed();
                            state_events.send_replace(state.clone());
                            }
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
}

struct RestCompletion {
    account: u64,
    track: u64,
    kind: RestKind,
    result: Result<Value, NativeError>,
}
type RestFuture = std::pin::Pin<Box<dyn std::future::Future<Output = RestCompletion> + Send>>;
