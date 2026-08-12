use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tungstenite::{Message, connect};

const CLIENT_ID: &str = "node-host";
const CLIENT_MODE: &str = "node";
const CLIENT_VERSION: &str = "rust-gateway-live-admission/0.1.0";
const ADMISSION_PLATFORM: &str = "rust";
const ROLE: &str = "node";
const SYSTEM_WHICH_COMMAND: &str = "system.which";
const ARTIFACT_PROFILE_ID: &str = "rust-gateway-side-effect-free-v1";

type GatewaySocket =
    tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    private_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicIdentity {
    device_id: String,
    public_key: String,
}

struct GatewaySession {
    socket: GatewaySocket,
    identity: PublicIdentity,
    hello: Value,
}

enum GatewayConnection {
    Accepted(Box<GatewaySession>),
    Rejected(Value),
}

fn artifact_profile() -> Value {
    json!({
        "schemaVersion": 1,
        "profileId": ARTIFACT_PROFILE_ID,
        "clientVersion": CLIENT_VERSION,
        "commands": [SYSTEM_WHICH_COMMAND],
        "sideEffectsAllowed": false,
        "runtimeReadinessProven": false,
        "rustAuthorityProven": false,
        "authority": "none"
    })
}

fn load_signing_key(path: &Path) -> Result<SigningKey, String> {
    let stored: StoredIdentity = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|error| format!("failed to read identity {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("invalid identity {}: {error}", path.display()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(stored.private_key)
        .map_err(|error| format!("invalid private key encoding: {error}"))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "private key must contain exactly 32 bytes".to_owned())?;
    Ok(SigningKey::from_bytes(&seed))
}

fn public_identity(signing_key: &SigningKey) -> PublicIdentity {
    let public_bytes = signing_key.verifying_key().to_bytes();
    PublicIdentity {
        device_id: format!("{:x}", Sha256::digest(public_bytes)),
        public_key: URL_SAFE_NO_PAD.encode(public_bytes),
    }
}

fn write_identity(path: &Path) -> Result<PublicIdentity, String> {
    if path.exists() {
        return Ok(public_identity(&load_signing_key(path)?));
    }
    let signing_key = SigningKey::generate(&mut OsRng);
    let stored = StoredIdentity {
        private_key: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
    };
    fs::write(
        path,
        serde_json::to_vec(&stored).map_err(|error| format!("serialize identity: {error}"))?,
    )
    .map_err(|error| format!("failed to write identity {}: {error}", path.display()))?;
    Ok(public_identity(&signing_key))
}

fn read_json_message(socket: &mut GatewaySocket) -> Result<Value, String> {
    loop {
        let message = socket
            .read()
            .map_err(|error| format!("websocket read failed: {error}"))?;
        match message {
            Message::Text(text) => {
                return serde_json::from_str(text.as_str())
                    .map_err(|error| format!("invalid gateway JSON: {error}"));
            }
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .map_err(|error| format!("websocket pong failed: {error}"))?,
            Message::Close(frame) => {
                return Err(format!("gateway closed before response: {frame:?}"));
            }
            _ => {}
        }
    }
}

fn open_gateway(
    url: &str,
    identity_path: &Path,
    min_protocol: u64,
    max_protocol: u64,
    platform: &str,
    device_family: &str,
    commands: &[&str],
) -> Result<GatewayConnection, String> {
    let device_token = env::var("OPENCLAW_RUST_CANARY_DEVICE_TOKEN")
        .map_err(|_| "OPENCLAW_RUST_CANARY_DEVICE_TOKEN is required".to_owned())?;
    let signing_key = load_signing_key(identity_path)?;
    let identity = public_identity(&signing_key);
    let (mut socket, _) =
        connect(url).map_err(|error| format!("websocket connect failed: {error}"))?;
    let challenge = read_json_message(&mut socket)?;
    let nonce = challenge
        .get("payload")
        .and_then(|payload| payload.get("nonce"))
        .and_then(Value::as_str)
        .filter(|nonce| !nonce.trim().is_empty())
        .ok_or_else(|| "gateway did not provide a connect challenge nonce".to_owned())?;
    let signed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock error: {error}"))?
        .as_millis() as u64;
    let signature_payload = [
        "v3",
        identity.device_id.as_str(),
        CLIENT_ID,
        CLIENT_MODE,
        ROLE,
        "",
        signed_at.to_string().as_str(),
        device_token.as_str(),
        nonce,
        platform,
        device_family,
    ]
    .join("|");
    let signature =
        URL_SAFE_NO_PAD.encode(signing_key.sign(signature_payload.as_bytes()).to_bytes());
    let request_id = "rust-gateway-live-admission-connect";
    let mut client = json!({
        "id": CLIENT_ID,
        "displayName": "Rust Gateway live admission",
        "version": CLIENT_VERSION,
        "platform": platform,
        "mode": CLIENT_MODE
    });
    if !device_family.is_empty() {
        client["deviceFamily"] = Value::String(device_family.to_owned());
    }
    let frame = json!({
        "type": "req",
        "id": request_id,
        "method": "connect",
        "params": {
            "minProtocol": min_protocol,
            "maxProtocol": max_protocol,
            "client": client,
            "commands": commands,
            "role": ROLE,
            "scopes": [],
            "device": {
                "id": identity.device_id,
                "publicKey": identity.public_key,
                "signature": signature,
                "signedAt": signed_at,
                "nonce": nonce
            },
            "auth": {
                "deviceToken": device_token
            }
        }
    });
    socket
        .send(Message::Text(frame.to_string().into()))
        .map_err(|error| format!("websocket write failed: {error}"))?;
    loop {
        let response = read_json_message(&mut socket)?;
        if response.get("type").and_then(Value::as_str) != Some("res")
            || response.get("id").and_then(Value::as_str) != Some(request_id)
        {
            continue;
        }
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            let hello = response
                .get("payload")
                .cloned()
                .ok_or_else(|| "hello response omitted payload".to_owned())?;
            return Ok(GatewayConnection::Accepted(Box::new(GatewaySession {
                socket,
                identity,
                hello,
            })));
        }
        let error = response.get("error").cloned().unwrap_or(Value::Null);
        return Ok(GatewayConnection::Rejected(json!({
            "status": "rejected",
            "authority": "none",
            "deviceId": identity.device_id,
            "code": error.get("code"),
            "message": error.get("message"),
            "detailCode": error.pointer("/details/code"),
            "commandsDeclared": 0,
            "invocationExecuted": false,
            "runtimeReadinessProven": false,
            "rustAuthorityProven": false
        })));
    }
}

fn connect_gateway(
    url: &str,
    identity_path: &Path,
    min_protocol: u64,
    max_protocol: u64,
) -> Result<(Value, bool), String> {
    match open_gateway(
        url,
        identity_path,
        min_protocol,
        max_protocol,
        ADMISSION_PLATFORM,
        "",
        &[],
    )? {
        GatewayConnection::Accepted(session) => Ok((
            json!({
                "status": "accepted",
                "authority": "none",
                "deviceId": session.identity.device_id,
                "selectedProtocol": session.hello.get("protocol"),
                "role": session.hello.pointer("/auth/role"),
                "scopes": session.hello.pointer("/auth/scopes"),
                "commandsDeclared": 0,
                "invocationExecuted": false,
                "runtimeReadinessProven": false,
                "rustAuthorityProven": false
            }),
            true,
        )),
        GatewayConnection::Rejected(result) => Ok((result, false)),
    }
}

fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .map(|extension| extension.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    }
}

fn invocation_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn resolve_executable(bin: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for extension in executable_extensions() {
            let candidate =
                if extension.is_empty() || bin.to_ascii_lowercase().ends_with(extension.as_str()) {
                    directory.join(bin)
                } else {
                    directory.join(format!("{bin}{extension}"))
                };
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn send_invoke_result(
    socket: &mut GatewaySocket,
    request_id: &str,
    node_id: &str,
    result: Value,
) -> Result<Value, String> {
    let rpc_id = "rust-gateway-side-effect-free-invocation-result";
    socket
        .send(Message::Text(
            json!({
                "type": "req",
                "id": rpc_id,
                "method": "node.invoke.result",
                "params": {
                    "id": request_id,
                    "nodeId": node_id,
                    "ok": true,
                    "payloadJSON": result.to_string()
                }
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| format!("failed to send invoke result: {error}"))?;
    loop {
        let response = read_json_message(socket)?;
        if response.get("type").and_then(Value::as_str) == Some("res")
            && response.get("id").and_then(Value::as_str) == Some(rpc_id)
        {
            if response.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({
                    "accepted": true,
                    "ignored": response.pointer("/payload/ignored").and_then(Value::as_bool)
                        == Some(true),
                    "gatewayCode": null,
                    "reasonCode": null
                }));
            }
            return Ok(json!({
                "accepted": false,
                "ignored": false,
                "gatewayCode": response.pointer("/error/code"),
                "reasonCode": response.pointer("/error/details/code")
            }));
        }
    }
}

fn send_invoke_progress(
    socket: &mut GatewaySocket,
    request_id: &str,
    node_id: &str,
    seq: u64,
    chunk: &str,
) -> Result<Value, String> {
    let rpc_id = format!("rust-gateway-invocation-progress-{seq}");
    socket
        .send(Message::Text(
            json!({
                "type": "req",
                "id": rpc_id,
                "method": "node.invoke.progress",
                "params": {
                    "invokeId": request_id,
                    "nodeId": node_id,
                    "seq": seq,
                    "chunk": chunk
                }
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| format!("failed to send invoke progress: {error}"))?;
    loop {
        let response = read_json_message(socket)?;
        if response.get("type").and_then(Value::as_str) == Some("res")
            && response.get("id").and_then(Value::as_str) == Some(rpc_id.as_str())
        {
            if response.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({
                    "accepted": true,
                    "ignored": response.pointer("/payload/ignored").and_then(Value::as_bool)
                        == Some(true)
                }));
            }
            return Ok(json!({
                "accepted": false,
                "ignored": false,
                "gatewayCode": response.pointer("/error/code")
            }));
        }
    }
}

fn send_stale_invoke_result(
    url: &str,
    identity_path: &Path,
    min_protocol: u64,
    max_protocol: u64,
    request_id: &str,
) -> Result<(Value, bool), String> {
    match open_gateway(
        url,
        identity_path,
        min_protocol,
        max_protocol,
        invocation_platform(),
        invocation_platform(),
        &[SYSTEM_WHICH_COMMAND],
    )? {
        GatewayConnection::Accepted(mut session) => {
            let result_disposition = send_invoke_result(
                &mut session.socket,
                request_id,
                &session.identity.device_id,
                json!({ "bins": { "node": "stale-result-must-not-settle" } }),
            )?;
            let result_accepted =
                result_disposition.get("accepted").and_then(Value::as_bool) == Some(true);
            let result_ignored =
                result_disposition.get("ignored").and_then(Value::as_bool) == Some(true);
            Ok((
                json!({
                    "status": if result_accepted && result_ignored {
                        "stale-result-ignored"
                    } else {
                        "stale-result-not-fenced"
                    },
                    "authority": "none",
                    "deviceId": session.identity.device_id,
                    "selectedProtocol": session.hello.get("protocol"),
                    "requestId": request_id,
                    "resultAccepted": result_accepted,
                    "resultIgnored": result_ignored,
                    "resultGatewayCode": result_disposition.get("gatewayCode"),
                    "resultReasonCode": result_disposition.get("reasonCode"),
                    "sideEffectsExecuted": false,
                    "runtimeReadinessProven": false,
                    "rustAuthorityProven": false
                }),
                result_accepted && result_ignored,
            ))
        }
        GatewayConnection::Rejected(result) => Ok((result, false)),
    }
}

fn send_unsupported_command(
    socket: &mut GatewaySocket,
    request_id: &str,
    node_id: &str,
    command: &str,
) -> Result<(), String> {
    socket
        .send(Message::Text(
            json!({
                "type": "req",
                "id": "rust-gateway-unsupported-command-result",
                "method": "node.invoke.result",
                "params": {
                    "id": request_id,
                    "nodeId": node_id,
                    "ok": false,
                    "error": {
                        "code": "UNSUPPORTED_COMMAND",
                        "message": format!("unsupported Rust invocation command: {command}")
                    }
                }
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| format!("failed to send unsupported-command result: {error}"))
}

#[derive(Clone, Copy)]
enum ResultMode {
    Immediate,
    Delayed(u64),
    AfterCancel,
    StreamUntilIdle,
    StreamInput,
}

fn serve_one_invocation(
    url: &str,
    identity_path: &Path,
    min_protocol: u64,
    max_protocol: u64,
    result_mode: ResultMode,
) -> Result<(Value, bool), String> {
    let GatewayConnection::Accepted(mut session) = open_gateway(
        url,
        identity_path,
        min_protocol,
        max_protocol,
        invocation_platform(),
        invocation_platform(),
        &[SYSTEM_WHICH_COMMAND],
    )?
    else {
        return Err("gateway rejected the invocation worker connection".to_owned());
    };
    let mut requests_received = 0_u64;
    let mut unsupported_commands_received = 0_u64;
    loop {
        let event = read_json_message(&mut session.socket)?;
        if event.get("type").and_then(Value::as_str) != Some("event")
            || event.get("event").and_then(Value::as_str) != Some("node.invoke.request")
        {
            continue;
        }
        requests_received += 1;
        let payload = event
            .get("payload")
            .ok_or_else(|| "node.invoke.request omitted payload".to_owned())?;
        let request_id = payload
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "node.invoke.request omitted id".to_owned())?;
        let node_id = payload
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| "node.invoke.request omitted nodeId".to_owned())?;
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| "node.invoke.request omitted command".to_owned())?;
        if command != SYSTEM_WHICH_COMMAND {
            unsupported_commands_received += 1;
            send_unsupported_command(&mut session.socket, request_id, node_id, command)?;
            continue;
        }
        let params = payload
            .get("paramsJSON")
            .and_then(Value::as_str)
            .ok_or_else(|| "system.which omitted paramsJSON".to_owned())
            .and_then(|raw| {
                serde_json::from_str::<Value>(raw)
                    .map_err(|error| format!("system.which paramsJSON is invalid: {error}"))
            })?;
        let bins = params
            .get("bins")
            .and_then(Value::as_array)
            .ok_or_else(|| "system.which requires bins".to_owned())?;
        let mut found = serde_json::Map::new();
        for bin in bins {
            let bin = bin
                .as_str()
                .ok_or_else(|| "system.which bins must contain strings".to_owned())?;
            if let Some(path) = resolve_executable(bin) {
                found.insert(
                    bin.to_owned(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
        }
        let mut result = json!({ "bins": found });
        let mut cancellation_request_id: Option<String> = None;
        let mut progress_dispositions: Vec<Value> = Vec::new();
        let mut late_progress_disposition: Option<Value> = None;
        let mut input_sequences: Vec<u64> = Vec::new();
        let mut input_payloads: Vec<Value> = Vec::new();
        let result_delay_ms = match result_mode {
            ResultMode::Immediate => 0,
            ResultMode::Delayed(delay_ms) => {
                println!(
                    "{}",
                    json!({
                        "status": "result-delayed",
                        "requestId": request_id,
                        "delayMs": delay_ms
                    })
                );
                io::stdout()
                    .flush()
                    .map_err(|error| format!("failed to flush delayed-result evidence: {error}"))?;
                thread::sleep(Duration::from_millis(delay_ms));
                delay_ms
            }
            ResultMode::AfterCancel => {
                println!(
                    "{}",
                    json!({
                        "status": "awaiting-cancel",
                        "requestId": request_id
                    })
                );
                io::stdout()
                    .flush()
                    .map_err(|error| format!("failed to flush cancel-wait evidence: {error}"))?;
                loop {
                    let cancel = read_json_message(&mut session.socket)?;
                    if cancel.get("type").and_then(Value::as_str) != Some("event")
                        || cancel.get("event").and_then(Value::as_str) != Some("node.invoke.cancel")
                    {
                        continue;
                    }
                    let cancel_request_id = cancel
                        .pointer("/payload/invokeId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.cancel omitted invokeId".to_owned())?;
                    let cancel_node_id = cancel
                        .pointer("/payload/nodeId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.cancel omitted nodeId".to_owned())?;
                    if cancel_request_id != request_id || cancel_node_id != node_id {
                        continue;
                    }
                    cancellation_request_id = Some(cancel_request_id.to_owned());
                    break;
                }
                0
            }
            ResultMode::StreamUntilIdle => {
                progress_dispositions.push(send_invoke_progress(
                    &mut session.socket,
                    request_id,
                    node_id,
                    1,
                    "second",
                )?);
                progress_dispositions.push(send_invoke_progress(
                    &mut session.socket,
                    request_id,
                    node_id,
                    0,
                    "first",
                )?);
                println!(
                    "{}",
                    json!({
                        "status": "progress-sent-awaiting-idle-cancel",
                        "requestId": request_id,
                        "sentSequences": [1, 0]
                    })
                );
                io::stdout()
                    .flush()
                    .map_err(|error| format!("failed to flush stream evidence: {error}"))?;
                loop {
                    let cancel = read_json_message(&mut session.socket)?;
                    if cancel.get("type").and_then(Value::as_str) != Some("event")
                        || cancel.get("event").and_then(Value::as_str) != Some("node.invoke.cancel")
                    {
                        continue;
                    }
                    let cancel_request_id = cancel
                        .pointer("/payload/invokeId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.cancel omitted invokeId".to_owned())?;
                    let cancel_node_id = cancel
                        .pointer("/payload/nodeId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.cancel omitted nodeId".to_owned())?;
                    if cancel_request_id != request_id || cancel_node_id != node_id {
                        continue;
                    }
                    cancellation_request_id = Some(cancel_request_id.to_owned());
                    break;
                }
                late_progress_disposition = Some(send_invoke_progress(
                    &mut session.socket,
                    request_id,
                    node_id,
                    2,
                    "late",
                )?);
                0
            }
            ResultMode::StreamInput => {
                println!(
                    "{}",
                    json!({
                        "status": "awaiting-input",
                        "requestId": request_id
                    })
                );
                io::stdout()
                    .flush()
                    .map_err(|error| format!("failed to flush input evidence: {error}"))?;
                while input_payloads.len() < 2 {
                    let input = read_json_message(&mut session.socket)?;
                    if input.get("type").and_then(Value::as_str) != Some("event")
                        || input.get("event").and_then(Value::as_str) != Some("node.invoke.input")
                    {
                        continue;
                    }
                    let input_request_id = input
                        .pointer("/payload/id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.input omitted id".to_owned())?;
                    let input_node_id = input
                        .pointer("/payload/nodeId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.input omitted nodeId".to_owned())?;
                    if input_request_id != request_id || input_node_id != node_id {
                        continue;
                    }
                    let sequence = input
                        .pointer("/payload/seq")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "node.invoke.input omitted seq".to_owned())?;
                    let expected_sequence = input_sequences.len() as u64;
                    if sequence != expected_sequence {
                        return Err(format!(
                            "node.invoke.input sequence {sequence} did not match {expected_sequence}"
                        ));
                    }
                    let payload = input
                        .pointer("/payload/payloadJSON")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "node.invoke.input omitted payloadJSON".to_owned())
                        .and_then(|raw| {
                            serde_json::from_str::<Value>(raw).map_err(|error| {
                                format!("node.invoke.input payload is invalid: {error}")
                            })
                        })?;
                    input_sequences.push(sequence);
                    input_payloads.push(payload);
                }
                result["inputs"] = Value::Array(input_payloads.clone());
                0
            }
        };
        let cancellation_expected = matches!(
            result_mode,
            ResultMode::AfterCancel | ResultMode::StreamUntilIdle
        );
        let cancellation_observed = cancellation_request_id.as_deref() == Some(request_id);
        if cancellation_expected && !cancellation_observed {
            return Err("matching node.invoke.cancel was not observed".to_owned());
        }
        let result_disposition =
            send_invoke_result(&mut session.socket, request_id, node_id, result.clone())?;
        let result_accepted =
            result_disposition.get("accepted").and_then(Value::as_bool) == Some(true);
        let result_ignored =
            result_disposition.get("ignored").and_then(Value::as_bool) == Some(true);
        if matches!(result_mode, ResultMode::Immediate | ResultMode::StreamInput)
            && !result_accepted
        {
            return Err(format!(
                "gateway rejected current invoke result: {result_disposition}"
            ));
        }
        let stream_expected = matches!(result_mode, ResultMode::StreamUntilIdle);
        let input_expected = matches!(result_mode, ResultMode::StreamInput);
        let progress_accepted = progress_dispositions.iter().all(|disposition| {
            disposition.get("accepted").and_then(Value::as_bool) == Some(true)
                && disposition.get("ignored").and_then(Value::as_bool) == Some(false)
        });
        let late_progress_ignored = late_progress_disposition
            .as_ref()
            .is_some_and(|disposition| {
                disposition.get("accepted").and_then(Value::as_bool) == Some(true)
                    && disposition.get("ignored").and_then(Value::as_bool) == Some(true)
            });
        let proof_accepted = if input_expected {
            input_sequences == [0, 1] && result_accepted && !result_ignored
        } else if stream_expected {
            progress_accepted
                && late_progress_ignored
                && result_accepted
                && result_ignored
                && cancellation_observed
        } else {
            !cancellation_expected || (result_accepted && result_ignored && cancellation_observed)
        };
        return Ok((
            json!({
                "status": if input_expected {
                    if proof_accepted { "input-received" } else { "input-rejected" }
                } else if stream_expected {
                    if proof_accepted { "idle-cancel-observed" } else { "idle-cancel-not-fenced" }
                } else if cancellation_expected {
                    if proof_accepted { "deadline-cancel-observed" } else { "deadline-cancel-not-fenced" }
                } else if result_accepted {
                    if result_ignored { "late-result-ignored" } else { "executed" }
                } else {
                    "late-result-refused"
                },
                "authority": "none",
                "deviceId": session.identity.device_id,
                "selectedProtocol": session.hello.get("protocol"),
                "command": command,
                "requestId": request_id,
                "resultRequestId": request_id,
                "requestsReceived": requests_received,
                "unsupportedCommandsReceived": unsupported_commands_received,
                "result": result,
                "resultDelayMs": result_delay_ms,
                "cancellationObserved": cancellation_observed,
                "cancellationRequestId": cancellation_request_id,
                "progressDispositions": progress_dispositions,
                "lateProgressAccepted": late_progress_disposition
                    .as_ref()
                    .and_then(|disposition| disposition.get("accepted")),
                "lateProgressIgnored": late_progress_disposition
                    .as_ref()
                    .and_then(|disposition| disposition.get("ignored")),
                "inputSequences": input_sequences,
                "inputPayloads": input_payloads,
                "resultAccepted": result_accepted,
                "resultIgnored": result_ignored,
                "resultGatewayCode": result_disposition.get("gatewayCode"),
                "resultReasonCode": result_disposition.get("reasonCode"),
                "sideEffectsExecuted": false,
                "runtimeReadinessProven": false,
                "rustAuthorityProven": false
            }),
            proof_accepted,
        ));
    }
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [command] if command == "artifact-profile" => Ok((artifact_profile(), true)),
        [command, path] if command == "identity" => {
            write_identity(Path::new(path)).and_then(|identity| {
                serde_json::to_value(identity).map_err(|error| error.to_string())
            }).map(|value| (value, true))
        }
        [command, url, path, min_protocol, max_protocol] if command == "connect" => {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    connect_gateway(url, Path::new(path), min_protocol, max_protocol)
                })
            })
        }
        [command, url, path, min_protocol, max_protocol] if command == "serve-one" => {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    serve_one_invocation(
                        url,
                        Path::new(path),
                        min_protocol,
                        max_protocol,
                        ResultMode::Immediate,
                    )
                })
            })
        }
        [command, url, path, min_protocol, max_protocol, delay_ms]
            if command == "serve-one-delayed" =>
        {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            let delay_ms = delay_ms
                .parse::<u64>()
                .map_err(|error| format!("invalid result delay: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    delay_ms.and_then(|delay_ms| {
                        serve_one_invocation(
                            url,
                            Path::new(path),
                            min_protocol,
                            max_protocol,
                            ResultMode::Delayed(delay_ms),
                        )
                    })
                })
            })
        }
        [command, url, path, min_protocol, max_protocol] if command == "serve-one-after-cancel" => {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    serve_one_invocation(
                        url,
                        Path::new(path),
                        min_protocol,
                        max_protocol,
                        ResultMode::AfterCancel,
                    )
                })
            })
        }
        [command, url, path, min_protocol, max_protocol] if command == "serve-one-stream-idle" => {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    serve_one_invocation(
                        url,
                        Path::new(path),
                        min_protocol,
                        max_protocol,
                        ResultMode::StreamUntilIdle,
                    )
                })
            })
        }
        [command, url, path, min_protocol, max_protocol] if command == "serve-one-input" => {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    serve_one_invocation(
                        url,
                        Path::new(path),
                        min_protocol,
                        max_protocol,
                        ResultMode::StreamInput,
                    )
                })
            })
        }
        [command, url, path, min_protocol, max_protocol, request_id]
            if command == "send-stale-result" =>
        {
            let min_protocol = min_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid min protocol: {error}"));
            let max_protocol = max_protocol
                .parse::<u64>()
                .map_err(|error| format!("invalid max protocol: {error}"));
            min_protocol.and_then(|min_protocol| {
                max_protocol.and_then(|max_protocol| {
                    send_stale_invoke_result(
                        url,
                        Path::new(path),
                        min_protocol,
                        max_protocol,
                        request_id,
                    )
                })
            })
        }
        _ => Err(
            "usage: rust-gateway-live-admission artifact-profile | identity <identity.json> | connect|serve-one|serve-one-after-cancel|serve-one-stream-idle|serve-one-input <ws-url> <identity.json> <min-protocol> <max-protocol> | serve-one-delayed <ws-url> <identity.json> <min-protocol> <max-protocol> <delay-ms> | send-stale-result <ws-url> <identity.json> <min-protocol> <max-protocol> <request-id>"
                .to_owned(),
        ),
    };
    match result {
        Ok((value, accepted)) => {
            println!(
                "{}",
                serde_json::to_string(&value).expect("serialize result")
            );
            if accepted {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(2)
            }
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
