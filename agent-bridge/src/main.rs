#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod types;
mod scanner;
mod laundry;
mod runner;
mod preflight;

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::types::*;

pub static BROADCAST_WS_TX: LazyLock<Mutex<Option<mpsc::UnboundedSender<Message>>>> =
    LazyLock::new(|| Mutex::new(None));

pub fn send_ws_message(msg: Message) {
    if let Ok(guard) = BROADCAST_WS_TX.lock() {
        if let Some(tx) = &*guard {
            let _ = tx.send(msg);
        }
    }
}

pub fn send_sync_progress(
    id: &str,
    transferred_bytes: u64,
    total_bytes: u64,
    speed_mbps: f64,
    status: &str,
    progress: f64,
) {
    let msg = json!({
        "type": "SYNC_PROGRESS",
        "id": id,
        "transferredBytes": transferred_bytes,
        "totalBytes": total_bytes,
        "speedMBps": speed_mbps,
        "status": status,
        "progress": progress,
    });
    send_ws_message(Message::Text(msg.to_string()));
}

async fn perform_sync_tool(
    transfer_id: String,
    resource: String,
    download_url: String,
    target_rel_dir: String,
    auto_root: PathBuf,
    state: AppState,
) {
    log_msg(&state, format!("[Bridge] Starting sync for {} from {}", resource, download_url));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Determine parent directory relative to auto_root
    let clean_res = resource.replace('\\', "/");
    let dest_rel = if clean_res.ends_with("/android-gts")
        || clean_res.ends_with("/android-cts")
        || clean_res.ends_with("/android-sts")
    {
        Path::new(&clean_res).parent().unwrap_or(Path::new(&clean_res)).to_string_lossy().to_string()
    } else if !target_rel_dir.is_empty() {
        target_rel_dir
    } else {
        clean_res.clone()
    };

    let dest_parent = auto_root.join(&dest_rel);
    if let Err(e) = fs::create_dir_all(&dest_parent) {
        log_msg(&state, format!("[Bridge] Failed to create destination dir {:?}: {}", dest_parent, e));
        send_sync_progress(&transfer_id, 0, 0, 0.0, "failed", 0.0);
        return;
    }

    send_sync_progress(&transfer_id, 0, 0, 0.0, "running", 0.1);

    let res = match client.get(&download_url).send().await {
        Ok(r) => r,
        Err(e) => {
            log_msg(&state, format!("[Bridge] Download request failed: {}", e));
            send_sync_progress(&transfer_id, 0, 0, 0.0, "failed", 0.0);
            return;
        }
    };

    if !res.status().is_success() {
        log_msg(&state, format!("[Bridge] Download returned error status: {}", res.status()));
        send_sync_progress(&transfer_id, 0, 0, 0.0, "failed", 0.0);
        return;
    }

    let total_bytes = res.content_length().unwrap_or(0);
    let is_tar = res.headers().get("X-Archive-Type").and_then(|v| v.to_str().ok()).unwrap_or("") == "tar.gz"
        || download_url.contains(".tar.gz");

    let header_filename = res.headers().get("X-Filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let raw_filename = if !header_filename.is_empty() {
        header_filename.to_string()
    } else {
        let last_part = Path::new(&clean_res).file_name().unwrap_or_default().to_string_lossy().to_string();
        if is_tar {
            format!("{}.tar.gz", last_part)
        } else {
            format!("{}.zip", last_part)
        }
    };

    let raw_file_path = dest_parent.join(&raw_filename);
    let temp_file_path = dest_parent.join(format!(".tmp_download_{}", transfer_id));

    let mut file = match tokio::fs::File::create(&temp_file_path).await {
        Ok(f) => f,
        Err(e) => {
            log_msg(&state, format!("[Bridge] Failed to create temp download file: {}", e));
            send_sync_progress(&transfer_id, 0, 0, 0.0, "failed", 0.0);
            return;
        }
    };

    use tokio::io::AsyncWriteExt;
    let mut stream = res.bytes_stream();
    let mut transferred: u64 = 0;
    let start_time = std::time::Instant::now();
    let mut last_report = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if let Err(e) = file.write_all(&chunk).await {
                    log_msg(&state, format!("[Bridge] Error writing chunk: {}", e));
                    let _ = tokio::fs::remove_file(&temp_file_path).await;
                    send_sync_progress(&transfer_id, transferred, total_bytes, 0.0, "failed", 0.0);
                    return;
                }
                transferred += chunk.len() as u64;

                if last_report.elapsed().as_millis() >= 300 {
                    let elapsed_secs = start_time.elapsed().as_secs_f64().max(0.001);
                    let speed = (transferred as f64 / (1024.0 * 1024.0)) / elapsed_secs;
                    let progress = if total_bytes > 0 {
                        ((transferred as f64 / total_bytes as f64) * 100.0).min(99.0)
                    } else {
                        50.0
                    };
                    send_sync_progress(&transfer_id, transferred, total_bytes, speed, "running", progress);
                    last_report = std::time::Instant::now();
                }
            }
            Err(e) => {
                log_msg(&state, format!("[Bridge] Stream error: {}", e));
                let _ = tokio::fs::remove_file(&temp_file_path).await;
                send_sync_progress(&transfer_id, transferred, total_bytes, 0.0, "failed", 0.0);
                return;
            }
        }
    }

    let _ = file.flush().await;
    drop(file);

    // Rename temp file to permanent raw zip/tar file so it is retained!
    if let Err(e) = tokio::fs::rename(&temp_file_path, &raw_file_path).await {
        log_msg(&state, format!("[Bridge] Failed to rename temp file to {:?}: {}", raw_file_path, e));
    }

    log_msg(
        &state,
        format!(
            "[Bridge] Download finished ({} bytes). Preserved raw archive at {:?}. Extracting into {:?}...",
            transferred, raw_file_path, dest_parent
        ),
    );

    send_sync_progress(&transfer_id, transferred, total_bytes, 0.0, "extracting", 99.0);

    // Extract archive while preserving raw zip file
    let is_sts = clean_res.to_uppercase().contains("STS") || raw_filename.to_uppercase().contains("STS");
    let mut extract_success = false;

    if is_tar {
        if let Ok(tar_file) = fs::File::open(&raw_file_path) {
            let gz = flate2::read::GzDecoder::new(tar_file);
            let mut archive = tar::Archive::new(gz);
            extract_success = archive.unpack(&dest_parent).is_ok();
        }
    } else {
        // Zip archive extraction: handle STS password ("sts") and general suites
        if is_sts {
            // 1. Try unzip with password "sts"
            let st = std::process::Command::new("unzip")
                .args(["-o", "-P", "sts", &raw_file_path.to_string_lossy(), "-d", &dest_parent.to_string_lossy()])
                .status();
            if let Ok(s) = st {
                extract_success = s.success();
            }

            // 2. Try 7z with password "sts" if unzip failed
            if !extract_success {
                let st7z = std::process::Command::new("7z")
                    .args(["x", "-y", "-psts", &raw_file_path.to_string_lossy(), &format!("-o{}", dest_parent.to_string_lossy())])
                    .status();
                if let Ok(s) = st7z {
                    extract_success = s.success();
                }
            }

            // 3. Fallback to standard unzip without password
            if !extract_success {
                let st_plain = std::process::Command::new("unzip")
                    .args(["-o", &raw_file_path.to_string_lossy(), "-d", &dest_parent.to_string_lossy()])
                    .status();
                if let Ok(s) = st_plain {
                    extract_success = s.success();
                }
            }
        } else {
            // Non-STS suite (CTS, GTS, etc.)
            let st = std::process::Command::new("unzip")
                .args(["-o", &raw_file_path.to_string_lossy(), "-d", &dest_parent.to_string_lossy()])
                .status();
            if let Ok(s) = st {
                extract_success = s.success();
            }

            if !extract_success {
                let st_pass = std::process::Command::new("unzip")
                    .args(["-o", "-P", "sts", &raw_file_path.to_string_lossy(), "-d", &dest_parent.to_string_lossy()])
                    .status();
                if let Ok(s) = st_pass {
                    extract_success = s.success();
                }
            }

            if !extract_success {
                if let Ok(zfile) = fs::File::open(&raw_file_path) {
                    if let Ok(mut archive) = zip::ZipArchive::new(zfile) {
                        extract_success = archive.extract(&dest_parent).is_ok();
                    }
                }
            }
        }
    }

    if extract_success {
        // Ensure results and subplans directories exist inside extracted suite directories (e.g. CTS/14_r13/android-cts/results/)
        let sub_dirs = ["android-cts", "android-gts", "android-sts"];
        for sub in &sub_dirs {
            let suite_path = dest_parent.join(sub);
            if suite_path.is_dir() {
                let _ = fs::create_dir_all(suite_path.join("results"));
                let _ = fs::create_dir_all(suite_path.join("subplans"));
            }
        }
        let _ = fs::create_dir_all(dest_parent.join("results"));

        let _ = std::process::Command::new("chmod")
            .args(["-R", "+x", &dest_parent.to_string_lossy()])
            .output();

        log_msg(
            &state,
            format!(
                "[Bridge] Successfully extracted and created results directory for {} (raw zip preserved at {:?})",
                resource, raw_file_path
            ),
        );
        send_sync_progress(&transfer_id, transferred, total_bytes, 0.0, "completed", 100.0);

        let (pc_id, auto_root_path) = {
            let cfg = state.config.lock().unwrap();
            (cfg.pc_id.clone(), PathBuf::from(&cfg.auto_root))
        };
        let rep = preflight::run_preflight_check(&auto_root_path, &pc_id);
        let p_msg = json!({
            "type": "PREFLIGHT_REPORT",
            "pcId": pc_id,
            "report": rep,
        });
        send_ws_message(Message::Text(p_msg.to_string()));
    } else {
        log_msg(&state, format!("[Bridge] Extraction failed for archive {:?}", raw_file_path));
        send_sync_progress(&transfer_id, transferred, total_bytes, 0.0, "failed", 0.0);
    }
}

struct AppState {
    config: Arc<Mutex<BridgeConfig>>,
    status: Arc<Mutex<BridgeLiveStatus>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    restart_trigger: Arc<tokio::sync::Notify>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            status: Arc::clone(&self.status),
            logs: Arc::clone(&self.logs),
            restart_trigger: Arc::clone(&self.restart_trigger),
        }
    }
}

fn config_path() -> PathBuf {
    dirs_next_or_home().join(".gba_agent_bridge_config.json")
}

fn dirs_next_or_home() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn load_initial_config() -> BridgeConfig {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "LAB-WORKSTATION".to_string());

    let default_pc_id = env::var("PC_ID").unwrap_or(host);
    let default_hub_url = env::var("HUB_URL").unwrap_or_else(|_| "wss://agent.endrisusanto.my.id/ws/bridge".to_string());
    let default_auto_root = env::var("AUTO_ROOT").unwrap_or_else(|_| {
        let candidates = [
            "/run/media/endri-pro/BINARY_HDD1/AUTO",
            "/run/media/endri-pro/BINARY_HDD/AUTO",
            "/home/endri-pro/Desktop/GBA/AUTO",
        ];
        for c in candidates {
            let p = std::path::Path::new(c);
            if p.exists() && p.is_dir() {
                return c.to_string();
            }
        }
        "/run/media/endri-pro/BINARY_HDD/AUTO".to_string()
    });
    let default_cucian_dir = env::var("CUCIAN_DIR").unwrap_or_else(|_| {
        dirs_next_or_home().join("Downloads").join("CUCIAN").to_string_lossy().to_string()
    });

    let path = config_path();
    if path.is_file() {
        if let Ok(data) = fs::read_to_string(path) {
            if let Ok(mut cfg) = serde_json::from_str::<BridgeConfig>(&data) {
                if cfg.cucian_dir.is_empty() {
                    cfg.cucian_dir = default_cucian_dir.clone();
                }
                let _ = fs::create_dir_all(&cfg.cucian_dir);
                return cfg;
            }
        }
    }

    let _ = fs::create_dir_all(&default_cucian_dir);
    BridgeConfig {
        pc_id: default_pc_id,
        hub_url: default_hub_url,
        auto_root: default_auto_root,
        cucian_dir: default_cucian_dir,
    }
}

fn save_config_to_disk(cfg: &BridgeConfig) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn log_msg(state: &AppState, line: impl AsRef<str>) {
    let text = line.as_ref().to_string();
    println!("{}", text);
    if let Ok(mut logs) = state.logs.lock() {
        logs.push_back(text);
        if logs.len() > 200 {
            logs.pop_front();
        }
    }
}

// Background WebSocket Worker Thread
async fn run_bridge_worker(state: AppState) {
    loop {
        let (hub_url, pc_id, auto_root_str, cucian_dir_str) = {
            let cfg = state.config.lock().unwrap();
            (cfg.hub_url.clone(), cfg.pc_id.clone(), cfg.auto_root.clone(), cfg.cucian_dir.clone())
        };

        let auto_root = PathBuf::from(&auto_root_str);
        let cucian_dir = PathBuf::from(&cucian_dir_str);
        let _ = fs::create_dir_all(&cucian_dir);

        log_msg(&state, format!("[Bridge] Connecting to Hub: {} as PC_ID: {}", hub_url, pc_id));

        match connect_async(&hub_url).await {
            Ok((ws_stream, _)) => {
                log_msg(&state, format!("[Bridge] Successfully connected to Hub at {}", hub_url));
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = true;
                    st.pc_id = pc_id.clone();
                    st.hub_url = hub_url.clone();
                    st.auto_root = auto_root_str.clone();
                    st.cucian_dir = cucian_dir_str.clone();
                }

                let (mut write, mut read) = ws_stream.split();

                // 1. Send Node Registration & Initial Preflight Report
                let zips = scanner::scan_laundry_zips(&auto_root, Some(&cucian_dir));
                let reg_msg = json!({
                    "type": "REGISTER_NODE",
                    "pcId": pc_id,
                    "os": env::consts::OS,
                    "autoRoot": auto_root_str,
                    "cucianDir": cucian_dir_str,
                    "laundryZips": zips,
                });
                let _ = write.send(Message::Text(reg_msg.to_string())).await;

                let initial_preflight = preflight::run_preflight_check(&auto_root, &pc_id);
                let preflight_msg = json!({
                    "type": "PREFLIGHT_REPORT",
                    "pcId": pc_id,
                    "report": initial_preflight,
                });
                let _ = write.send(Message::Text(preflight_msg.to_string())).await;

                // 2. Spawn periodic scanner loop
                let auto_root_scan = auto_root.clone();
                let cucian_dir_scan = cucian_dir.clone();
                let pc_id_scan = pc_id.clone();
                let (scan_tx, mut scan_rx) = mpsc::unbounded_channel::<Message>();
                *BROADCAST_WS_TX.lock().unwrap() = Some(scan_tx.clone());
                let scan_tx_loop = scan_tx.clone();

                let scanner_handle = tokio::spawn(async move {
                    let mut tick_counter: u32 = 0;
                    loop {
                        let devs = scanner::scan_all_devices(&auto_root_scan);
                        let zips = scanner::scan_laundry_zips(&auto_root_scan, Some(&cucian_dir_scan));

                        let dev_msg = json!({
                            "type": "DEVICE_LIST_UPDATE",
                            "pcId": pc_id_scan,
                            "devices": devs,
                        });
                        let _ = scan_tx_loop.send(Message::Text(dev_msg.to_string()));

                        let zip_msg = json!({
                            "type": "LAUNDRY_ZIP_LIST",
                            "pcId": pc_id_scan,
                            "zips": zips,
                        });
                        let _ = scan_tx_loop.send(Message::Text(zip_msg.to_string()));

                        // Preflight scan every 10 seconds (every 4 ticks)
                        tick_counter += 1;
                        if tick_counter >= 4 {
                            tick_counter = 0;
                            let report = preflight::run_preflight_check(&auto_root_scan, &pc_id_scan);
                            let p_msg = json!({
                                "type": "PREFLIGHT_REPORT",
                                "pcId": pc_id_scan,
                                "report": report,
                            });
                            let _ = scan_tx_loop.send(Message::Text(p_msg.to_string()));
                        }

                        sleep(Duration::from_millis(2500)).await;
                    }
                });

                // 3. Message loop
                loop {
                    tokio::select! {
                        _ = state.restart_trigger.notified() => {
                            log_msg(&state, "[Bridge] Reconnect triggered by config update");
                            break;
                        }

                        Some(out_msg) = scan_rx.recv() => {
                            if write.send(out_msg).await.is_err() {
                                break;
                            }
                        }

                        in_msg = read.next() => {
                            match in_msg {
                                Some(Ok(Message::Text(text))) => {
                                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                        match msg_type {
                                            "CMD_RUN_SUITE" => {
                                                if let Some(payload_val) = val.get("payload") {
                                                    match serde_json::from_value::<RunSuitePayload>(payload_val.clone()) {
                                                        Ok(mut payload) => {
                                                            let run_id = payload.run_id.clone().unwrap_or_else(|| {
                                                                format!("run-{}", SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs())
                                                            });
                                                            payload.run_id = Some(run_id.clone());
                                                            log_msg(&state, format!("[Bridge] Received CMD_RUN_SUITE: {} (run_id: {})", payload.test_type, run_id));
                                                            let auto_root_run = auto_root.clone();
                                                            let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();
                                                            let (stat_tx, mut stat_rx) = mpsc::unbounded_channel::<(String, String, u64)>();

                                                            let run_id_log = run_id.clone();
                                                            let run_id_stat = run_id.clone();
                                                            let run_id_fin = run_id.clone();
                                                            let test_type_stat = payload.test_type.clone();
                                                            let workflow_id_stat = payload.workflow_id.clone();
                                                            let laundry_zip_stat = payload.laundry_zip_path.clone();

                                                            // Immediately announce run start
                                                            send_ws_message(Message::Text(json!({
                                                                "type": "SUITE_STATUS_UPDATE",
                                                                "run_id": run_id,
                                                                "workflow_id": payload.workflow_id,
                                                                "laundry_zip_path": payload.laundry_zip_path,
                                                                "test_type": payload.test_type,
                                                                "suite": payload.test_type,
                                                                "status": "Running",
                                                                "elapsed_secs": 0
                                                            }).to_string()));

                                                            tokio::spawn(async move {
                                                                while let Some(line) = log_rx.recv().await {
                                                                    send_ws_message(Message::Text(json!({
                                                                        "type": "LOG_STREAM",
                                                                        "run_id": run_id_log,
                                                                        "line": line
                                                                    }).to_string()));
                                                                }
                                                            });

                                                            tokio::spawn(async move {
                                                                while let Some((suite, status, elapsed)) = stat_rx.recv().await {
                                                                    send_ws_message(Message::Text(json!({
                                                                        "type": "SUITE_STATUS_UPDATE",
                                                                        "run_id": run_id_stat,
                                                                        "workflow_id": workflow_id_stat,
                                                                        "laundry_zip_path": laundry_zip_stat,
                                                                        "test_type": test_type_stat,
                                                                        "suite": suite,
                                                                        "status": status,
                                                                        "elapsed_secs": elapsed
                                                                    }).to_string()));
                                                                }
                                                            });

                                                            let state_clone = state.clone();
                                                            thread::spawn(move || {
                                                                let outcome = runner::execute_suite_run(
                                                                    &auto_root_run,
                                                                    &payload,
                                                                    log_tx,
                                                                    stat_tx,
                                                                );
                                                                let (exit_code, zip_files, first_zip, summary) = match &outcome {
                                                                    Ok(o) => (
                                                                        o.exit_code,
                                                                        o.zip_files.clone(),
                                                                        o.zip_files.first().cloned(),
                                                                        json!({
                                                                            "passed": o.passed,
                                                                            "failed": o.failed,
                                                                            "total": o.total,
                                                                            "run_time": format!("{}s", o.elapsed_secs),
                                                                            "test_type": payload.test_type
                                                                        })
                                                                    ),
                                                                    Err(_) => (
                                                                        1,
                                                                        Vec::new(),
                                                                        None,
                                                                        json!({
                                                                            "passed": 0,
                                                                            "failed": 1,
                                                                            "total": 1,
                                                                            "run_time": "0s",
                                                                            "test_type": payload.test_type
                                                                        })
                                                                    ),
                                                                };
                                                                send_ws_message(Message::Text(json!({
                                                                    "type": "RUN_FINISHED",
                                                                    "run_id": run_id_fin,
                                                                    "exit_code": exit_code,
                                                                    "summary": summary,
                                                                    "zip_file": first_zip,
                                                                    "zip_files": zip_files
                                                                }).to_string()));
                                                                log_msg(&state_clone, format!("[Bridge] Run completed: exit_code={exit_code}, zips={:?}", zip_files));
                                                            });
                                                        }
                                                        Err(e) => {
                                                            let err_msg = format!("[Bridge Error] Failed to parse RunSuitePayload: {e}");
                                                            log_msg(&state, &err_msg);
                                                            eprintln!("{err_msg}");
                                                        }
                                                    }
                                                }
                                            }

                                            "CMD_SET_LAMP" => {
                                                if let (Some(serial), Some(brighten)) = (
                                                    val.get("serial").and_then(|s| s.as_str()),
                                                    val.get("brighten").and_then(|b| b.as_bool()),
                                                ) {
                                                    let _ = scanner::set_device_lamp(serial, brighten);
                                                }
                                            }

                                            "CMD_CANCEL_RUN" => {
                                                if let Some(run_id) = val.get("run_id").and_then(|s| s.as_str()) {
                                                    log_msg(&state, &format!("[Bridge] Received CMD_CANCEL_RUN for {run_id}"));
                                                    let cancelled = runner::cancel_suite_run(run_id);
                                                    log_msg(&state, &format!("[Bridge] Cancel outcome for {run_id}: {cancelled}"));
                                                    let mut registry = scanner::read_busy_registry(&auto_root);
                                                    registry.devices.retain(|_, d| d.run_id != run_id);
                                                    let _ = scanner::write_busy_registry(&auto_root, &registry);
                                                }
                                            }

                                            "CMD_RESET_BUSY" => {
                                                let mut registry = scanner::read_busy_registry(&auto_root);
                                                registry.devices.clear();
                                                let _ = scanner::write_busy_registry(&auto_root, &registry);
                                                log_msg(&state, "[Bridge] Reset busy registry on node");
                                            }

                                            "CMD_ANALYZE_LAUNDRY" => {
                                                if let Some(zip_path) = val.get("zip_path").and_then(|s| s.as_str()) {
                                                    let target_pc_id = val.get("targetPcId").and_then(|s| s.as_str()).unwrap_or(&pc_id);
                                                    match laundry::analyze_laundry_zip(zip_path) {
                                                        Ok(rows) => {
                                                            let reply = json!({
                                                                "type": "LAUNDRY_ANALYSIS_RESULT",
                                                                "targetPcId": target_pc_id,
                                                                "pcId": target_pc_id,
                                                                "zip_path": zip_path,
                                                                "rows": rows
                                                            });
                                                            let _ = write.send(Message::Text(reply.to_string())).await;
                                                        }
                                                        Err(err) => {
                                                            let reply = json!({
                                                                "type": "LAUNDRY_ANALYSIS_RESULT",
                                                                "targetPcId": target_pc_id,
                                                                "pcId": target_pc_id,
                                                                "zip_path": zip_path,
                                                                "error": err
                                                            });
                                                            let _ = write.send(Message::Text(reply.to_string())).await;
                                                        }
                                                    }
                                                }
                                            }

                                            "CMD_TRIGGER_PREFLIGHT" => {
                                                let report = preflight::run_preflight_check(&auto_root, &pc_id);
                                                let p_msg = json!({
                                                    "type": "PREFLIGHT_REPORT",
                                                    "pcId": pc_id,
                                                    "report": report,
                                                });
                                                let _ = write.send(Message::Text(p_msg.to_string())).await;
                                                log_msg(&state, format!("[Bridge] Sent on-demand Preflight Report ({} items)", report.items.len()));
                                            }

                                            "CMD_SYNC_TOOL" => {
                                                let transfer_id = val.get("id").and_then(|v| v.as_str()).unwrap_or("tr-unknown").to_string();
                                                let resource = val.get("resource").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let target_rel_dir = val.get("target_rel_dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                
                                                let hub_http_base = hub_url
                                                    .replace("ws://", "http://")
                                                    .replace("wss://", "https://")
                                                    .replace("/ws/bridge", "");

                                                let raw_download_url = val.get("download_url")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("");

                                                let download_url = if raw_download_url.starts_with("http://") || raw_download_url.starts_with("https://") {
                                                    raw_download_url.to_string()
                                                } else if raw_download_url.starts_with('/') {
                                                    format!("{}{}", hub_http_base.trim_end_matches('/'), raw_download_url)
                                                } else {
                                                    format!("{}/api/sync/file?path={}", hub_http_base.trim_end_matches('/'), resource)
                                                };

                                                let auto_root_cloned = auto_root.clone();
                                                let state_cloned = state.clone();

                                                tokio::spawn(async move {
                                                    perform_sync_tool(
                                                        transfer_id,
                                                        resource,
                                                        download_url,
                                                        target_rel_dir,
                                                        auto_root_cloned,
                                                        state_cloned,
                                                    ).await;
                                                });
                                            }

                                            _ => {}
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                                    log_msg(&state, "[Bridge] Hub connection closed");
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }

                *BROADCAST_WS_TX.lock().unwrap() = None;
                scanner_handle.abort();
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = false;
                }
            }
            Err(err) => {
                *BROADCAST_WS_TX.lock().unwrap() = None;
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = false;
                }
                log_msg(&state, format!("[Bridge] Connection failed: {}. Retrying in 1 second...", err));
            }
        }

        tokio::select! {
            _ = state.restart_trigger.notified() => {
                log_msg(&state, "[Bridge] Reconnect triggered by user");
            }
            _ = sleep(Duration::from_millis(1000)) => {}
        }
    }
}

// Tauri IPC Commands for Local Bridge Tray UI
#[tauri::command]
fn get_bridge_status(state: tauri::State<AppState>) -> BridgeLiveStatus {
    let mut st = state.status.lock().unwrap().clone();
    if let Ok(logs) = state.logs.lock() {
        st.recent_logs = logs.iter().cloned().collect();
    }
    st
}

#[tauri::command]
fn save_bridge_config(
    pc_id: String,
    hub_url: String,
    auto_root: String,
    cucian_dir: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let clean_pc = pc_id.trim().to_string();
    let clean_url = hub_url.trim().to_string();
    let clean_root = auto_root.trim().to_string();
    let clean_cucian = cucian_dir.trim().to_string();

    if clean_pc.is_empty() {
        return Err("PC ID cannot be empty".to_string());
    }
    if clean_url.is_empty() {
        return Err("Hub URL cannot be empty".to_string());
    }

    if !clean_cucian.is_empty() {
        let _ = fs::create_dir_all(&clean_cucian);
    }
    if !clean_root.is_empty() {
        let _ = fs::create_dir_all(&clean_root);
    }

    let new_cfg = BridgeConfig {
        pc_id: clean_pc.clone(),
        hub_url: clean_url.clone(),
        auto_root: clean_root.clone(),
        cucian_dir: clean_cucian.clone(),
    };

    save_config_to_disk(&new_cfg)?;

    {
        let mut cfg = state.config.lock().unwrap();
        *cfg = new_cfg;
    }

    {
        let mut st = state.status.lock().unwrap();
        st.pc_id = clean_pc;
        st.hub_url = clean_url;
        st.auto_root = clean_root;
        st.cucian_dir = clean_cucian;
    }

    state.restart_trigger.notify_one();
    Ok(())
}

#[tauri::command]
async fn select_auto_folder() -> Option<String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("Select AUTO Suite Directory")
        .pick_folder()
        .await;
    folder.map(|f| f.path().to_string_lossy().to_string())
}

#[tauri::command]
async fn select_cucian_folder() -> Option<String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("Pilih Folder Target Scanner Laundry (CUCIAN)")
        .pick_folder()
        .await;
    if let Some(ref f) = folder {
        let _ = fs::create_dir_all(f.path());
    }
    folder.map(|f| f.path().to_string_lossy().to_string())
}

#[tauri::command]
fn clear_bridge_logs(state: tauri::State<AppState>) {
    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let is_headless = args.iter().any(|a| a == "--headless" || a == "-d");

    let mut initial_config = load_initial_config();

    if let Some(pos) = args.iter().position(|a| a == "--server" || a == "-s") {
        if let Some(val) = args.get(pos + 1) {
            initial_config.hub_url = val.clone();
        }
    }
    if let Some(pos) = args.iter().position(|a| a == "--node-id" || a == "-n") {
        if let Some(val) = args.get(pos + 1) {
            initial_config.pc_id = val.clone();
        }
    }
    if let Some(pos) = args.iter().position(|a| a == "--auto-root" || a == "-a") {
        if let Some(val) = args.get(pos + 1) {
            initial_config.auto_root = val.clone();
        }
    }
    if let Some(pos) = args.iter().position(|a| a == "--cucian-dir" || a == "-c") {
        if let Some(val) = args.get(pos + 1) {
            initial_config.cucian_dir = val.clone();
        }
    }

    let _ = fs::create_dir_all(&initial_config.cucian_dir);

    let app_state = AppState {
        config: Arc::new(Mutex::new(initial_config.clone())),
        status: Arc::new(Mutex::new(BridgeLiveStatus {
            pc_id: initial_config.pc_id.clone(),
            hub_url: initial_config.hub_url.clone(),
            auto_root: initial_config.auto_root.clone(),
            cucian_dir: initial_config.cucian_dir.clone(),
            is_connected: false,
            device_count: 0,
            devices: Vec::new(),
            zip_count: 0,
            recent_logs: Vec::new(),
        })),
        logs: Arc::new(Mutex::new(VecDeque::new())),
        restart_trigger: Arc::new(tokio::sync::Notify::new()),
    };

    log_msg(&app_state, "==================================================");
    log_msg(&app_state, " GBA Agentic Auto Bridge Started");
    log_msg(&app_state, format!(" PC ID:       {}", initial_config.pc_id));
    log_msg(&app_state, format!(" Hub URL:     {}", initial_config.hub_url));
    log_msg(&app_state, format!(" AUTO Root:   {}", initial_config.auto_root));
    log_msg(&app_state, format!(" CUCIAN Dir:  {}", initial_config.cucian_dir));
    log_msg(&app_state, format!(" Mode:        {}", if is_headless { "Headless Daemon" } else { "Tauri Desktop with AppTray" }));
    log_msg(&app_state, "==================================================");

    if is_headless {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(run_bridge_worker(app_state));
        return;
    }

    let worker_state = app_state.clone();
    thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(run_bridge_worker(worker_state));
    });

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_bridge_status,
            save_bridge_config,
            select_auto_folder,
            select_cucian_folder,
            clear_bridge_logs
        ])
        .setup(|app| {
            let status_item = MenuItem::with_id(app, "status", "GBA Agent Bridge Active", false, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "Show Bridge Settings", true, None::<&str>)?;
            let web_item = MenuItem::with_id(app, "web", "Open Web Hub Dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;

            let tray_menu = Menu::with_items(app, &[&status_item, &show_item, &web_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("gba_fleet_tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        let win = app.get_webview_window("gba_main").or_else(|| app.get_webview_window("main"));
                        if let Some(window) = win {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "web" => {
                        let _ = open::that("https://agent.endrisusanto.my.id");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let win = tray.app_handle().get_webview_window("gba_main").or_else(|| tray.app_handle().get_webview_window("main"));
                        if let Some(window) = win {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _ = tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Prevent close -> minimize to tray
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                println!("[Tray] Bridge window hidden to system tray. Worker continues in background.");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
