#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod types;
mod scanner;
mod laundry;
mod runner;

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
    let default_auto_root = env::var("AUTO_ROOT").unwrap_or_else(|_| "/run/media/endri-pro/BINARY_HDD/AUTO".to_string());

    let path = config_path();
    if path.is_file() {
        if let Ok(data) = fs::read_to_string(path) {
            if let Ok(cfg) = serde_json::from_str::<BridgeConfig>(&data) {
                return cfg;
            }
        }
    }

    BridgeConfig {
        pc_id: default_pc_id,
        hub_url: default_hub_url,
        auto_root: default_auto_root,
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
        let (hub_url, pc_id, auto_root_str) = {
            let cfg = state.config.lock().unwrap();
            (cfg.hub_url.clone(), cfg.pc_id.clone(), cfg.auto_root.clone())
        };

        let auto_root = PathBuf::from(&auto_root_str);
        log_msg(&state, format!("[Bridge] Connecting to Hub: {} as PC_ID: {}", hub_url, pc_id));

        match connect_async(&hub_url).await {
            Ok((ws_stream, _)) => {
                log_msg(&state, format!("[Bridge] Successfully connected to Hub at {}", hub_url));
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = true;
                }

                let (mut write, mut read) = ws_stream.split();

                // 1. Send Node Registration
                let zips = scanner::scan_laundry_zips(&auto_root);
                let reg_msg = json!({
                    "type": "REGISTER_NODE",
                    "pcId": pc_id,
                    "os": env::consts::OS,
                    "autoRoot": auto_root_str,
                    "laundryZips": zips,
                });
                let _ = write.send(Message::Text(reg_msg.to_string())).await;

                // 2. Spawn periodic scanner loop
                let auto_root_scan = auto_root.clone();
                let pc_id_scan = pc_id.clone();
                let (scan_tx, mut scan_rx) = mpsc::unbounded_channel::<Message>();
                let scan_tx_loop = scan_tx.clone();

                let scanner_handle = tokio::spawn(async move {
                    loop {
                        let devs = scanner::scan_all_devices(&auto_root_scan);
                        let zips = scanner::scan_laundry_zips(&auto_root_scan);

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

                                                            let scan_tx_logs = scan_tx.clone();
                                                            let scan_tx_stat = scan_tx.clone();
                                                            let scan_tx_fin = scan_tx.clone();
                                                            let run_id_log = run_id.clone();
                                                            let run_id_stat = run_id.clone();
                                                            let run_id_fin = run_id.clone();
                                                            let test_type_stat = payload.test_type.clone();

                                                            // Immediately announce run start
                                                            let _ = scan_tx.send(Message::Text(json!({
                                                                "type": "SUITE_STATUS_UPDATE",
                                                                "run_id": run_id,
                                                                "test_type": payload.test_type,
                                                                "suite": payload.test_type,
                                                                "status": "Running",
                                                                "elapsed_secs": 0
                                                            }).to_string()));

                                                            tokio::spawn(async move {
                                                                while let Some(line) = log_rx.recv().await {
                                                                    let _ = scan_tx_logs.send(Message::Text(json!({
                                                                        "type": "LOG_STREAM",
                                                                        "run_id": run_id_log,
                                                                        "line": line
                                                                    }).to_string()));
                                                                }
                                                            });

                                                            tokio::spawn(async move {
                                                                while let Some((suite, status, elapsed)) = stat_rx.recv().await {
                                                                    let _ = scan_tx_stat.send(Message::Text(json!({
                                                                        "type": "SUITE_STATUS_UPDATE",
                                                                        "run_id": run_id_stat,
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
                                                                let exit_code = match &outcome {
                                                                    Ok(o) => o.exit_code,
                                                                    Err(_) => 1,
                                                                };
                                                                let _ = scan_tx_fin.send(Message::Text(json!({
                                                                    "type": "RUN_FINISHED",
                                                                    "run_id": run_id_fin,
                                                                    "exit_code": exit_code,
                                                                    "summary": null,
                                                                    "zip_file": null
                                                                }).to_string()));
                                                                log_msg(&state_clone, format!("[Bridge] Run completed: {:?}", outcome.as_ref().map(|o| o.exit_code)));
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

                                            "CMD_RESET_BUSY" => {
                                                let mut registry = scanner::read_busy_registry(&auto_root);
                                                registry.devices.clear();
                                                let _ = scanner::write_busy_registry(&auto_root, &registry);
                                                log_msg(&state, "[Bridge] Reset busy registry on node");
                                            }

                                            "CMD_ANALYZE_LAUNDRY" => {
                                                if let Some(zip_path) = val.get("zip_path").and_then(|s| s.as_str()) {
                                                    match laundry::analyze_laundry_zip(zip_path) {
                                                        Ok(rows) => {
                                                            let reply = json!({
                                                                "type": "LAUNDRY_ANALYSIS_RESULT",
                                                                "zip_path": zip_path,
                                                                "rows": rows
                                                            });
                                                            let _ = write.send(Message::Text(reply.to_string())).await;
                                                        }
                                                        Err(err) => {
                                                            let reply = json!({
                                                                "type": "LAUNDRY_ANALYSIS_RESULT",
                                                                "zip_path": zip_path,
                                                                "error": err
                                                            });
                                                            let _ = write.send(Message::Text(reply.to_string())).await;
                                                        }
                                                    }
                                                }
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

                scanner_handle.abort();
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = false;
                }
            }
            Err(err) => {
                {
                    let mut st = state.status.lock().unwrap();
                    st.is_connected = false;
                }
                log_msg(&state, format!("[Bridge] Connection failed: {}. Retrying in 3 seconds...", err));
            }
        }

        tokio::select! {
            _ = state.restart_trigger.notified() => {
                log_msg(&state, "[Bridge] Reconnect triggered by user");
            }
            _ = sleep(Duration::from_secs(3)) => {}
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
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let clean_pc = pc_id.trim().to_string();
    let clean_url = hub_url.trim().to_string();
    let clean_root = auto_root.trim().to_string();

    if clean_pc.is_empty() {
        return Err("PC ID cannot be empty".to_string());
    }
    if clean_url.is_empty() {
        return Err("Hub URL cannot be empty".to_string());
    }

    let new_cfg = BridgeConfig {
        pc_id: clean_pc,
        hub_url: clean_url,
        auto_root: clean_root,
    };

    save_config_to_disk(&new_cfg)?;

    {
        let mut cfg = state.config.lock().unwrap();
        *cfg = new_cfg;
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
fn clear_bridge_logs(state: tauri::State<AppState>) {
    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let is_headless = args.iter().any(|a| a == "--headless" || a == "-d");

    let initial_config = load_initial_config();
    let app_state = AppState {
        config: Arc::new(Mutex::new(initial_config.clone())),
        status: Arc::new(Mutex::new(BridgeLiveStatus {
            pc_id: initial_config.pc_id.clone(),
            hub_url: initial_config.hub_url.clone(),
            auto_root: initial_config.auto_root.clone(),
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
    log_msg(&app_state, format!(" PC ID:     {}", initial_config.pc_id));
    log_msg(&app_state, format!(" Hub URL:   {}", initial_config.hub_url));
    log_msg(&app_state, format!(" AUTO Root: {}", initial_config.auto_root));
    log_msg(&app_state, format!(" Mode:      {}", if is_headless { "Headless Daemon" } else { "Tauri Desktop with AppTray" }));
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
            clear_bridge_logs
        ])
        .setup(|app| {
            let status_item = MenuItem::with_id(app, "status", "GBA Agent Bridge Active", false, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "Show Bridge Settings", true, None::<&str>)?;
            let web_item = MenuItem::with_id(app, "web", "Open Web Hub Dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;

            let tray_menu = Menu::with_items(app, &[&status_item, &show_item, &web_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main_tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
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
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
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
