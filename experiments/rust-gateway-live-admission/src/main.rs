use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use tungstenite::{Message, connect};

const CLIENT_ID: &str = "node-host";
const CLIENT_MODE: &str = "node";
const CLIENT_VERSION: &str = "rust-gateway-live-admission/0.1.0";
const PLATFORM: &str = "rust";
const ROLE: &str = "node";

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

fn read_json_message(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<Value, String> {
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

fn connect_gateway(
    url: &str,
    identity_path: &Path,
    min_protocol: u64,
    max_protocol: u64,
) -> Result<(Value, bool), String> {
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
        PLATFORM,
        "",
    ]
    .join("|");
    let signature =
        URL_SAFE_NO_PAD.encode(signing_key.sign(signature_payload.as_bytes()).to_bytes());
    let request_id = "rust-gateway-live-admission-connect";
    let frame = json!({
        "type": "req",
        "id": request_id,
        "method": "connect",
        "params": {
            "minProtocol": min_protocol,
            "maxProtocol": max_protocol,
            "client": {
                "id": CLIENT_ID,
                "displayName": "Rust Gateway live admission",
                "version": CLIENT_VERSION,
                "platform": PLATFORM,
                "mode": CLIENT_MODE
            },
            "commands": [],
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
            let payload = response
                .get("payload")
                .ok_or_else(|| "hello response omitted payload".to_owned())?;
            let result = json!({
                "status": "accepted",
                "authority": "none",
                "deviceId": identity.device_id,
                "selectedProtocol": payload.get("protocol"),
                "role": payload.pointer("/auth/role"),
                "scopes": payload.pointer("/auth/scopes"),
                "commandsDeclared": 0,
                "invocationExecuted": false,
                "runtimeReadinessProven": false,
                "rustAuthorityProven": false
            });
            return Ok((result, true));
        }
        let error = response.get("error").cloned().unwrap_or(Value::Null);
        let result = json!({
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
        });
        return Ok((result, false));
    }
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
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
        _ => Err(
            "usage: rust-gateway-live-admission identity <identity.json> | connect <ws-url> <identity.json> <min-protocol> <max-protocol>"
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
