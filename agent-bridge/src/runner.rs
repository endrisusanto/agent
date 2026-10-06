use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::symlink;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::laundry::{is_cts_verifier_result, resolve_zip_path};
use crate::scanner::{device_props, read_busy_registry, write_busy_registry};
use crate::types::{BusyDevice, RunSuitePayload};

pub static ACTIVE_RUN_PIDS: LazyLock<Mutex<HashMap<String, Vec<u32>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
pub static CANCELLED_RUNS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
pub static STS_RUN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub fn is_run_cancelled(run_id: &str) -> bool {
    let set = CANCELLED_RUNS.lock().unwrap();
    set.contains(run_id)
}

pub fn register_run_pid(run_id: &str, pid: u32) {
    let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
    map.entry(run_id.to_string()).or_default().push(pid);
}

pub fn unregister_run_pid(run_id: &str, pid: u32) {
    let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
    if let Some(list) = map.get_mut(run_id) {
        list.retain(|&p| p != pid);
        if list.is_empty() {
            map.remove(run_id);
        }
    }
}

pub fn cancel_suite_run(run_id: &str) -> bool {
    {
        let mut set = CANCELLED_RUNS.lock().unwrap();
        set.insert(run_id.to_string());
    }
    let pids = {
        let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
        map.remove(run_id).unwrap_or_default()
    };
    for pid in &pids {
        terminate_process_tree(*pid);
    }
    // Force kill tradefed processes to ensure immediate stoppage
    let _ = Command::new("pkill").args(["-9", "-f", "cts-tradefed"]).output();
    let _ = Command::new("pkill").args(["-9", "-f", "gts-tradefed"]).output();
    let _ = Command::new("pkill").args(["-9", "-f", "sts-tradefed"]).output();
    true
}


fn find_real_adb() -> String {
    if let Ok(output) = Command::new("which").arg("adb").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && !path.contains(".gba-bin") {
                return path;
            }
        }
    }
    for candidate in &["/usr/bin/adb", "/usr/local/bin/adb", "/opt/android-sdk/platform-tools/adb"] {
        if Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "adb".to_string()
}

pub fn create_adb_wrapper(root: &Path) -> Result<(), String> {
    let gba_bin = root.join(".gba-bin");
    fs::create_dir_all(&gba_bin).map_err(|err| err.to_string())?;
    let real_adb = find_real_adb();
    let wrapper_path = gba_bin.join("adb");
    let content = format!(
        "#!/usr/bin/env bash\nif [[ \"$*\" == *\"kill-server\"* ]]; then\n    exit 0\nfi\nexec {} \"$@\"\n",
        real_adb
    );
    fs::write(&wrapper_path, content).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(&wrapper_path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&wrapper_path, perms);
        }
    }
    Ok(())
}

pub fn prepare_devices(devices: &[String], log_tx: &mpsc::UnboundedSender<String>) {
    let mut handles = Vec::new();
    for serial in devices {
        let serial = serial.clone();
        let tx = log_tx.clone();
        handles.push(std::thread::spawn(move || {
            let _ = tx.send(format!("[prepare][{serial}] waking device"));
            let run = |args: &[&str]| {
                let mut cmd_args = vec!["-s", &serial];
                cmd_args.extend_from_slice(args);
                Command::new("adb").args(&cmd_args).output()
            };
            let _ = run(&["root"]);
            std::thread::sleep(Duration::from_secs(1));
            let _ = run(&["unroot"]);
            let _ = run(&["wait-for-device"]);
            let result = run(&[
                "shell",
                "settings put global stay_on_while_plugged_in 3; settings put secure block_usb_lock 0; wm dismiss-keyguard; input keyevent KEYCODE_WAKEUP; input keyevent KEYCODE_HOME",
            ]);
            match result {
                Ok(_) => {
                    let _ = tx.send(format!("[prepare][{serial}] ready"));
                }
                Err(err) => {
                    let _ = tx.send(format!("[prepare][{serial}] skipped: {err}"));
                }
            }
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }
}

pub fn generate_ro_xml(serial: &str, session_dir: &Path, log_tx: &mpsc::UnboundedSender<String>) -> Option<PathBuf> {
    let _ = log_tx.send(format!("[AI Worker] Querying device properties for ro.xml on {serial}..."));

    let props = [
        "ro.build.fingerprint", "ro.build.version.base_os", "ro.build.version.security_patch", "ro.build.PDA",
        "ril.sw_ver", "ril.official_cscver", "ro.product.first_api_level", "ro.sts.property",
        "ro.csc.sales_code", "ro.oem.key1", "ro.oem.key2", "ro.csc.countryiso_code",
        "ro.csc.country_code", "ro.system.build.fingerprint", "ro.vendor.build.fingerprint",
        "ro.product.build.version.sdk", "ro.build.version.sdk_full", "partition.system.verified.root_digest",
        "partition.vendor.verified.root_digest", "partition.system_dlkm.verified.root_digest",
        "partition.vendor_dlkm.verified.root_digest", "partition.odm.verified.root_digest",
        "partition.product.verified.root_digest", "ro.build.characteristics", "ro.build.version.oneui",
        "ro.build.version.emergency_base_os", "partition.system_ext.verified.root_digest",
    ];

    let mut cmd_str = String::new();
    for p in props {
        cmd_str.push_str(&format!("echo \"PROP:{p}:$(getprop {p})\"; "));
    }

    let output = Command::new("adb")
        .args(["-s", serial, "shell", &cmd_str])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut xml_content = String::from("<RO>\n\n");
    let mut sales_code = String::new();
    let mut csc_ver = String::new();

    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("PROP:") {
            if let Some((k, v)) = rest.split_once(':') {
                let val = v.trim();
                if k == "ro.csc.sales_code" {
                    sales_code = val.to_string();
                } else if k == "ril.official_cscver" {
                    csc_ver = val.to_string();
                }
                let escaped_v = if k == "ro.csc.country_code" {
                    val.replace('&', "&amp;")
                } else {
                    val.to_string()
                };
                xml_content.push_str(&format!("    <{k}>{escaped_v}</{k}>\n"));
            }
        }
    }

    // 2. Check isWatch
    let features_out = Command::new("adb")
        .args(["-s", serial, "shell", "pm", "list", "features"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let is_watch = if features_out.contains("feature:android.hardware.type.watch") { "true" } else { "false" };
    xml_content.push_str(&format!("\n    <isWatch>{is_watch}</isWatch>\n"));

    // 3. Check Message App
    let sms_role_out = Command::new("adb")
        .args(["-s", serial, "shell", "cmd", "role", "get-role-holders", "android.app.role.SMS"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let msg_val = if sms_role_out.contains("com.google.android.apps.messaging") {
        "Android Message"
    } else if sms_role_out.contains("com.samsung.android.messaging") {
        "Samsung Message"
    } else {
        "Not Found"
    };
    xml_content.push_str(&format!("    <message>{msg_val}</message>\n"));

    // 4. Check Browser
    let browser_out = Command::new("adb")
        .args(["-s", serial, "shell", "cmd", "package", "resolve-activity", "http://example.com/"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let browser_val = if browser_out.contains("com.android.chrome") {
        "Chrome"
    } else if browser_out.contains("com.sec.android.app.sbrowser") {
        "S-Browser"
    } else {
        "Not Found"
    };
    xml_content.push_str(&format!("    <browser>{browser_val}</browser>\n"));

    // 5. Dynamic Client IDs
    let clientid_out = Command::new("adb")
        .args(["-s", serial, "shell", "getprop | grep clientidbase"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    for line in clientid_out.lines() {
        let clean = line.replace(['[', ']'], "");
        if let Some((k, v)) = clean.split_once(':') {
            let key = k.trim();
            let val = v.trim();
            if !key.is_empty() {
                xml_content.push_str(&format!("    <{key}>{val}</{key}>\n"));
            }
        }
    }

    xml_content.push_str("\n    <ro.version>4.4</ro.version>\n</RO>\n");

    // ponytail: Format filename as ro_{sales_code}_{csc_ver}.xml (e.g. ro_XID_A546EOLENFZJ1.xml)
    let xml_filename = if !sales_code.is_empty() && !csc_ver.is_empty() {
        format!("ro_{}_{}.xml", sanitize_name(&sales_code), sanitize_name(&csc_ver))
    } else if !csc_ver.is_empty() {
        format!("ro_{}.xml", sanitize_name(&csc_ver))
    } else {
        format!("ro_{}.xml", sanitize_name(serial))
    };
    let xml_file = session_dir.join(&xml_filename);

    if let Ok(_) = fs::write(&xml_file, &xml_content) {
        let _ = log_tx.send(format!("[AI Worker] ro.xml v4.4 generated: {}", xml_file.display()));
        let generic_ro = session_dir.join("ro.xml");
        let _ = fs::write(&generic_ro, &xml_content);
        Some(xml_file)
    } else {
        let _ = log_tx.send(format!("[AI Worker][WARN] Failed to write ro.xml for {serial}"));
        None
    }
}

// ponytail: Copy raw SCAT zip file without extraction and rename to SCAT_{AP_VERSION}.zip
pub fn preserve_scat_files(
    extracted_dir: &Path,
    source_zip: &Path,
    session_dir: &Path,
    ap_version: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) {
    let clean_ap = ap_version.trim();
    let scat_dest_name = if !clean_ap.is_empty() && clean_ap != "PDA" {
        format!("SCAT_{clean_ap}.zip")
    } else {
        "SCAT.zip".to_string()
    };

    let mut preserved = false;

    let handle_candidate = |file_path: &Path| -> bool {
        let fname = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let fname_lower = fname.to_lowercase();

        if fname_lower.contains("scat") && fname_lower.ends_with(".zip") {
            let target_path = session_dir.join(&scat_dest_name);
            if let Ok(_) = fs::copy(file_path, &target_path) {
                let _ = log_tx.send(format!(
                    "[AI Worker] Preserved raw SCAT zip to session as: {}",
                    scat_dest_name
                ));
                let mut zips = collected_zips.lock().unwrap();
                if !zips.contains(&scat_dest_name) {
                    zips.push(scat_dest_name.clone());
                }
                return true;
            }
        }
        false
    };

    // 1. Walk extracted temp directory for raw SCAT zip
    for entry in walkdir::WalkDir::new(extracted_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if handle_candidate(entry.path()) {
                preserved = true;
                break;
            }
        }
    }

    // 2. Check parent directory of the source zip if not found inside
    if !preserved {
        if let Some(parent_dir) = source_zip.parent() {
            if parent_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(parent_dir) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        if entry.path().is_file() {
                            if handle_candidate(&entry.path()) {
                                preserved = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    if preserved {
        let _ = log_tx.send(format!(
            "[AI Worker] Raw SCAT zip preserved into session: {scat_dest_name}"
        ));
    }
}

pub fn connect_wifi(serial: &str, ssid: &str, password: &str) -> Result<String, String> {
    let _ = Command::new("adb").args(["-s", serial, "shell", "svc", "wifi", "enable"]).output();
    std::thread::sleep(Duration::from_secs(1));
    let output = if password.is_empty() {
        Command::new("adb")
            .args(["-s", serial, "shell", "cmd", "wifi", "connect-network", ssid, "open"])
            .output()
    } else {
        Command::new("adb")
            .args(["-s", serial, "shell", "cmd", "wifi", "connect-network", ssid, "wpa2", password])
            .output()
    }.map_err(|e| e.to_string())?;

    let out_str = String::from_utf8_lossy(&output.stdout);
    if out_str.to_lowercase().contains("failed") || out_str.to_lowercase().contains("error") {
        Err(out_str.trim().to_string())
    } else {
        Ok(format!("wifi connect requested for \"{ssid}\" on {serial}"))
    }
}

fn ensure_ghidra_for_sts(log_tx: &mpsc::UnboundedSender<String>) -> Result<(), String> {
    let updater = Path::new("/home/endri-pro/Documents/ghidra/download_ghidra.sh");
    if updater.is_file() {
        let _ = log_tx.send("[AI Worker] Preparing Ghidra for STS...".to_string());
        let _ = Command::new("bash").arg(updater).output();
    }
    Ok(())
}

#[allow(dead_code)]
pub struct RunOutcome {
    pub exit_code: i32,
    pub elapsed_secs: u64,
    pub result_dir: String,
    pub zip_files: Vec<String>,
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
}

#[derive(Clone)]
struct DeviceInfoSources {
    property: PathBuf,
    client_id: Option<PathBuf>,
}

struct LaundrySource {
    _temp: Arc<tempfile::TempDir>,
    cts_results: Vec<PathBuf>,
    gts_results: Vec<PathBuf>,
    sts_results: Vec<PathBuf>,
}

pub fn execute_suite_run(
    auto_root: &Path,
    payload: &RunSuitePayload,
    log_tx: mpsc::UnboundedSender<String>,
    status_tx: mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<RunOutcome, String> {
    let run_id = payload.run_id.clone().unwrap_or_else(|| {
        format!("run-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs())
    });

    let serials = if !payload.user_devices.is_empty() {
        payload.user_devices.clone()
    } else {
        payload.userdebug_devices.clone()
    };

    if serials.is_empty() {
        return Err("No target devices specified for run".to_string());
    }

    let first_serial = serials.first().cloned().unwrap_or_default();
    let first_props = device_props(&first_serial).unwrap_or_default();
    let model = payload.target_model.clone()
        .or_else(|| first_props.get("ro.product.model").cloned())
        .unwrap_or_else(|| "UnknownModel".to_string());
    let pda = first_props.get("ro.build.PDA")
        .or_else(|| first_props.get("ro.boot.em.pda"))
        .or_else(|| first_props.get("ro.build.display.id"))
        .cloned()
        .unwrap_or_else(|| "PDA".to_string());

    let suffix = timestamp_compact();
    let session_name = format!(
        "{}_{}_{}_{}devs_{}_{}",
        sanitize_name(&payload.test_type),
        sanitize_name(&model),
        sanitize_name(&pda),
        serials.len(),
        suffix,
        sanitize_name(&run_id)
    );

    let session_dir = auto_root.join("Results").join(session_name);
    let _ = fs::create_dir_all(&session_dir);
    let log_dir = session_dir.join("Log");
    let _ = fs::create_dir_all(&log_dir);
    #[cfg(unix)]
    let _ = symlink(&log_dir, session_dir.join("logs"));

    // Pipe all logs to both the channel and session_dir/run.log
    let run_log_path = session_dir.join("run.log");
    let (inner_log_tx, mut inner_log_rx) = mpsc::unbounded_channel::<String>();
    let outer_log_tx = log_tx;
    let run_log_file = run_log_path.clone();
    std::thread::spawn(move || {
        while let Some(line) = inner_log_rx.blocking_recv() {
            let timestamp = chrono_timestamp();
            append_file_line(&run_log_file, &format!("{timestamp} {line}"));
            let _ = outer_log_tx.send(line);
        }
    });
    let log_tx = inner_log_tx;

    let start_time = Instant::now();
    let _ = log_tx.send(format!("[AI Worker] =================================================="));
    let _ = log_tx.send(format!("[AI Worker] Starting shard 1/1: {} devices={}", payload.test_type, serials.join(",")));
    let _ = log_tx.send(format!("[AI Worker] Run ID: {}", run_id));
    let _ = log_tx.send(format!("[AI Worker] Result directory: {}", session_dir.display()));

    // 1. Create ADB wrapper
    if let Err(e) = create_adb_wrapper(auto_root) {
        let _ = log_tx.send(format!("[AI Worker][WARN] Failed to create ADB wrapper: {e}"));
    }

    // 2. Mark devices as busy
    let mut busy_registry = read_busy_registry(auto_root);
    for s in &serials {
        busy_registry.devices.insert(
            s.clone(),
            BusyDevice {
                serial: s.clone(),
                is_userdebug: !payload.userdebug_devices.is_empty(),
                test_type: payload.test_type.clone(),
                model: model.clone(),
                pda: pda.clone(),
                run_id: run_id.clone(),
                started_at: chrono_timestamp(),
                result_dir: Some(session_dir.display().to_string()),
                current_suite: Some(payload.test_type.clone()),
            },
        );
    }
    let _ = write_busy_registry(auto_root, &busy_registry);

    // 3. Connect WiFi if configured
    if payload.wifi_enabled && !payload.wifi_ssid.is_empty() {
        for s in &serials {
            match connect_wifi(s, &payload.wifi_ssid, &payload.wifi_password) {
                Ok(msg) => { let _ = log_tx.send(format!("[wifi][{s}] {msg}")); }
                Err(err) => { let _ = log_tx.send(format!("[wifi][{s}] failed: {err}")); }
            }
        }
    }

    // 4. Wake & prepare devices
    let _ = log_tx.send("[prepare] Waking and unlocking all target devices...".to_string());
    prepare_devices(&serials, &log_tx);

    // 5. Auto Generate ro.xml v4.4 for target devices
    for s in &serials {
        let _ = generate_ro_xml(s, &session_dir, &log_tx);
    }

    let collected_zips = Arc::new(Mutex::new(Vec::<String>::new()));

    let is_laundry = payload.laundry_zip_path.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        || payload.test_type.starts_with("Laundry")
        || payload.test_type.starts_with("Cuci");

    let exit_code = if is_laundry {
        let has_sts = payload.test_type.contains("SMR") || payload.selected_laundry_rows.iter().any(|r| {
            let suite = r.get("suite").and_then(|v| v.as_str()).unwrap_or("");
            let testcase = r.get("testcase").and_then(|v| v.as_str()).unwrap_or("");
            suite.eq_ignore_ascii_case("sts") || testcase.to_uppercase().contains("STS")
        });

        if has_sts {
            run_laundry_smr_flow(auto_root, &session_dir, &log_dir, payload, &model, &pda, &run_id, &log_tx, &status_tx, &collected_zips)?
        } else {
            run_laundry_normal_flow(auto_root, &session_dir, &log_dir, payload, &model, &pda, &run_id, &log_tx, &status_tx, &collected_zips)?
        }
    } else {
        match payload.test_type.as_str() {
            "Cuci SMR" => {
                run_cts_then_gts_flow(
                    auto_root,
                    &session_dir,
                    &log_dir,
                    &payload.user_devices,
                    "ctssmr",
                    "run gts --subplan gtssmr",
                    payload.timeout_secs,
                    &model,
                    &pda,
                    &run_id,
                    &payload.test_type,
                    &log_tx,
                    &status_tx,
                    &collected_zips,
                )?
            }
        "SKU" => {
            run_cts_then_gts_flow(
                auto_root,
                &session_dir,
                &log_dir,
                &payload.user_devices,
                "ctssku",
                "run gts-variant",
                payload.timeout_secs,
                &model,
                &pda,
                &run_id,
                &payload.test_type,
                &log_tx,
                &status_tx,
                &collected_zips,
            )?
        }
        "MR" | "Normal" => {
            run_cts_then_gts_flow(
                auto_root,
                &session_dir,
                &log_dir,
                &payload.user_devices,
                "normal",
                "run gts --subplan normal",
                payload.timeout_secs,
                &model,
                &pda,
                &run_id,
                &payload.test_type,
                &log_tx,
                &status_tx,
                &collected_zips,
            )?
        }
        "STS" => {
            let devs = if !payload.userdebug_devices.is_empty() {
                &payload.userdebug_devices
            } else {
                &payload.user_devices
            };
            run_sts_flow(
                auto_root,
                &session_dir,
                &log_dir,
                devs,
                payload.timeout_secs,
                &model,
                &pda,
                &run_id,
                &payload.test_type,
                &log_tx,
                &status_tx,
                &collected_zips,
            )?
        }
        "SMR" => {
            let sts_handle = if !payload.userdebug_devices.is_empty() {
                let root_sts = auto_root.to_path_buf();
                let session_sts = session_dir.to_path_buf();
                let log_sts = log_dir.to_path_buf();
                let devs_sts = payload.userdebug_devices.clone();
                let timeout_sts = payload.timeout_secs;
                let model_sts = model.clone();
                let pda_sts = pda.clone();
                let run_id_sts = run_id.clone();
                let test_type_sts = payload.test_type.clone();
                let log_tx_sts = log_tx.clone();
                let stat_tx_sts = status_tx.clone();
                let zips_sts = Arc::clone(&collected_zips);

                Some(std::thread::spawn(move || {
                    run_sts_flow(
                        &root_sts,
                        &session_sts,
                        &log_sts,
                        &devs_sts,
                        timeout_sts,
                        &model_sts,
                        &pda_sts,
                        &run_id_sts,
                        &test_type_sts,
                        &log_tx_sts,
                        &stat_tx_sts,
                        &zips_sts,
                    )
                }))
            } else {
                None
            };

            let cts_gts_code = if !payload.user_devices.is_empty() {
                run_cts_then_gts_flow(
                    auto_root,
                    &session_dir,
                    &log_dir,
                    &payload.user_devices,
                    "ctssmr",
                    "run gts --subplan gtssmr",
                    payload.timeout_secs,
                    &model,
                    &pda,
                    &run_id,
                    &payload.test_type,
                    &log_tx,
                    &status_tx,
                    &collected_zips,
                )?
            } else {
                0
            };

            let sts_code = if let Some(handle) = sts_handle {
                handle.join().unwrap_or(Ok(1)).unwrap_or(1)
            } else {
                0
            };

            if cts_gts_code == 0 && sts_code == 0 { 0 } else { 1 }
        }
        _ => {
            return Err(format!("Unsupported test type: {}", payload.test_type));
        }
        }
    };

    let elapsed = start_time.elapsed().as_secs();

    // 5. Clear busy state
    let mut busy_registry = read_busy_registry(auto_root);
    for s in &serials {
        busy_registry.devices.remove(s);
    }
    let _ = write_busy_registry(auto_root, &busy_registry);

    let mut zips_list = collected_zips.lock().unwrap().clone();

    // 6. Create overall consolidated result ZIP for this session
    let results_root = session_dir.parent().unwrap_or(&session_dir);
    let overall_zip_name = format!("{}.zip", session_dir.file_name().unwrap_or_default().to_string_lossy());
    let overall_zip_path = results_root.join(&overall_zip_name);
    let _ = log_tx.send(format!("[AI Worker] Creating overall result ZIP: {overall_zip_name}..."));
    if let Err(e) = zip_directory(&session_dir, &overall_zip_path) {
        let _ = log_tx.send(format!("[AI Worker] Warning: Failed to create overall ZIP: {e}"));
    } else {
        let _ = log_tx.send(format!("[AI Worker] Result ZIP preserved: {overall_zip_name}"));
        if !zips_list.contains(&overall_zip_name) {
            zips_list.insert(0, overall_zip_name);
        }
    }

    let _ = log_tx.send(format!("[AI Worker] Completed with exit={exit_code}. Result zips: [{}]", zips_list.join(", ")));
    let _ = log_tx.send(format!("[AI Worker] Finished exit={exit_code} result={}", session_dir.display()));
    let _ = status_tx.send((payload.test_type.clone(), if exit_code == 0 { "Test Done".to_string() } else { "Failed".to_string() }, elapsed));

    let (real_pass, real_fail, real_total) = scan_run_summary(&session_dir);
    let (final_pass, final_fail, final_total) = if real_total > 0 || real_pass > 0 || real_fail > 0 {
        (real_pass, real_fail, real_total)
    } else if exit_code == 0 {
        (1, 0, 1)
    } else {
        (0, 1, 1)
    };

    Ok(RunOutcome {
        exit_code,
        elapsed_secs: elapsed,
        result_dir: session_dir.to_string_lossy().to_string(),
        zip_files: zips_list,
        total: final_total,
        passed: final_pass,
        failed: final_fail,
    })
}

pub fn scan_run_summary(session_dir: &Path) -> (u64, u64, u64) {
    let mut total_passed = 0u64;
    let mut total_failed = 0u64;
    let mut total_tests = 0u64;
    let mut found_any = false;

    for entry in WalkDir::new(session_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.file_name() == "test_result.xml" {
            if let Ok(content) = fs::read_to_string(entry.path()) {
                let p = crate::laundry::parse_xml_attr(&content, "pass").unwrap_or(0);
                let f = crate::laundry::parse_xml_attr(&content, "failed").unwrap_or(0);
                let m_total = crate::laundry::parse_xml_attr(&content, "modules_total").unwrap_or(0);
                let m_done = crate::laundry::parse_xml_attr(&content, "modules_done").unwrap_or(0);

                let pass_val = if p > 0 || f > 0 { p } else { m_done };
                let fail_val = f;
                let tot_val = if p + f > 0 { p + f } else { m_total };

                total_passed += pass_val;
                total_failed += fail_val;
                total_tests += tot_val;
                found_any = true;
            }
        }
    }

    if !found_any {
        let log_dirs = [session_dir.join("Log"), session_dir.join("logs"), session_dir.to_path_buf()];
        for ldir in &log_dirs {
            if ldir.exists() {
                if let Ok(entries) = fs::read_dir(ldir) {
                    for entry in entries.flatten() {
                        let fname = entry.file_name().to_string_lossy().to_string();
                        if fname.starts_with("laundry_retry_") && fname.ends_with(".log") {
                            if let Ok(content) = fs::read_to_string(entry.path()) {
                                let mut p_val = 0u64;
                                let mut f_val = 0u64;
                                let mut t_val = 0u64;
                                let mut log_found = false;

                                for line in content.lines() {
                                    let trimmed = line.trim();
                                    if trimmed.starts_with("PASSED") && trimmed.contains(':') {
                                        if let Some(val_str) = trimmed.split(':').nth(1) {
                                            if let Ok(n) = val_str.trim().parse::<u64>() {
                                                p_val = n;
                                                log_found = true;
                                            }
                                        }
                                    } else if trimmed.starts_with("FAILED") && trimmed.contains(':') {
                                        if let Some(val_str) = trimmed.split(':').nth(1) {
                                            if let Ok(n) = val_str.trim().parse::<u64>() {
                                                f_val = n;
                                                log_found = true;
                                            }
                                        }
                                    } else if trimmed.starts_with("Total Tests") && trimmed.contains(':') {
                                        if let Some(val_str) = trimmed.split(':').nth(1) {
                                            if let Ok(n) = val_str.trim().parse::<u64>() {
                                                t_val = n;
                                                log_found = true;
                                            }
                                        }
                                    }
                                }

                                if log_found {
                                    if t_val == 0 {
                                        t_val = p_val + f_val;
                                    }
                                    total_passed += p_val;
                                    total_failed += f_val;
                                    total_tests += t_val;
                                    found_any = true;
                                }
                            }
                        }
                    }
                }
            }
            if found_any {
                break;
            }
        }
    }

    if found_any {
        (total_passed, total_failed, total_tests)
    } else {
        (0, 0, 0)
    }
}

pub fn zip_directory(src_dir: &Path, dst_zip: &Path) -> Result<(), String> {
    use std::fs::File;
    use std::io::{Read, Write};
    use zip::write::FileOptions;
    use zip::ZipWriter;

    let file = File::create(dst_zip).map_err(|e| format!("Failed to create zip file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in walkdir::WalkDir::new(src_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path == dst_zip {
            continue;
        }
        let rel_path = match path.strip_prefix(src_dir) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if rel_path.as_os_str().is_empty() {
            continue;
        }
        if path.is_file() {
            let mut f = match File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("Skipping file {:?}: {e}", path);
                    continue;
                }
            };
            if let Err(e) = zip.start_file(rel_path.to_string_lossy().to_string(), options) {
                eprintln!("Zip start_file error: {e}");
                continue;
            }
            let mut buffer = Vec::new();
            if let Ok(_) = f.read_to_end(&mut buffer) {
                let _ = zip.write_all(&buffer);
            }
        } else if path.is_dir() {
            let _ = zip.add_directory(rel_path.to_string_lossy().to_string(), options);
        }
    }
    zip.finish().map_err(|e| format!("Zip finish error: {e}"))?;
    Ok(())
}

fn chrono_timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", now.as_secs())
}

fn timestamp_compact() -> String {
    chrono_timestamp()
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn serial_args(devices: &[String]) -> String {
    devices.iter().map(|s| format!(" -s {s}")).collect::<Vec<_>>().join("")
}

// -------------------------------------------------------------------------------------------------
// Result Snapshot & Artifact Management (Matching AUTO Algorithm)
// -------------------------------------------------------------------------------------------------

struct ResultSnapshot {
    zips: HashMap<PathBuf, SystemTime>,
}

impl ResultSnapshot {
    fn capture(dir: &Path) -> Self {
        let mut zips = HashMap::new();
        if dir.is_dir() {
            for entry in WalkDir::new(dir).into_iter().flatten() {
                if entry.file_type().is_file() && entry.path().extension().and_then(|s| s.to_str()) == Some("zip") {
                    if let Ok(modified) = fs::metadata(entry.path()).and_then(|m| m.modified()) {
                        zips.insert(entry.path().to_path_buf(), modified);
                    }
                }
            }
        }
        Self { zips }
    }

    fn newest_zip(&self, dir: &Path, since: SystemTime) -> Option<PathBuf> {
        let threshold = since.checked_sub(Duration::from_secs(5)).unwrap_or(since);
        let mut newest: Option<(SystemTime, PathBuf)> = None;
        if dir.is_dir() {
            for entry in WalkDir::new(dir).into_iter().flatten() {
                if !entry.file_type().is_file() || entry.path().extension().and_then(|s| s.to_str()) != Some("zip") {
                    continue;
                }
                let path = entry.path().to_path_buf();
                let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
                if modified < threshold {
                    continue;
                }
                if self.zips.get(&path).is_some_and(|prev| *prev == modified) {
                    continue;
                }
                if let Some((best_time, _)) = &newest {
                    if modified > *best_time {
                        newest = Some((modified, path));
                    }
                } else {
                    newest = Some((modified, path));
                }
            }
        }
        newest.map(|(_, p)| p)
    }
}

fn copy_laundry_retry_artifact(
    session_dir: &Path,
    suite: &str,
    suite_workspace: &Path,
    result_dir: &Path,
    snapshot: &ResultSnapshot,
    started: SystemTime,
    model: &str,
    pda: &str,
    devices: &[String],
    index: usize,
    log_tx: &mpsc::UnboundedSender<String>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<String, String> {
    let _ = log_tx.send(format!("[AI Worker] {suite}: copying retry artifact for {}", result_dir.display()));
    let zip = snapshot.newest_zip(&suite_workspace.join("results"), started)
        .or_else(|| {
            // Find any zip in result_dir
            for entry in WalkDir::new(result_dir).into_iter().flatten() {
                if entry.file_type().is_file() && entry.path().extension().and_then(|s| s.to_str()) == Some("zip") {
                    return Some(entry.into_path());
                }
            }
            let sibling = result_dir.with_extension("zip");
            if sibling.is_file() { Some(sibling) } else { None }
        });

    let Some(zip_path) = zip else {
        let _ = log_tx.send(format!("[{suite}] No new zip detected after retry in {}", result_dir.display()));
        return Ok(String::new());
    };

    let result_name = result_dir.file_name().and_then(|n| n.to_str()).unwrap_or("result");
    let dst_filename = format!(
        "{}_retry{}_{}_{}_{}_{}.zip",
        suite,
        index,
        sanitize_name(model),
        sanitize_name(pda),
        sanitize_name(&devices.join("_")),
        sanitize_name(result_name)
    );
    let dst_path = session_dir.join(&dst_filename);
    let _ = fs::copy(&zip_path, &dst_path);
    let _ = log_tx.send(format!("[AI Worker] Preserved retry result ZIP: {}", dst_path.display()));
    {
        let mut zips = collected_zips.lock().unwrap();
        if !zips.contains(&dst_filename) {
            zips.push(dst_filename.clone());
        }
    }
    Ok(dst_filename)
}

fn copy_suite_result(
    session_dir: &Path,
    suite: &str,
    suite_workspace: &Path,
    devices: &[String],
    model: &str,
    pda: &str,
    snapshot: &ResultSnapshot,
    started: SystemTime,
    log_tx: &mpsc::UnboundedSender<String>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<String, String> {
    let _ = log_tx.send(format!("[AI Worker] {suite}: copying result for [{}]", devices.join(",")));
    let results = suite_workspace.join("results");
    let zip = snapshot.newest_zip(&results, started);
    if let Some(zip_path) = zip {
        let dst_filename = format!(
            "{}_{}_{}_{}.zip",
            suite,
            sanitize_name(model),
            sanitize_name(pda),
            sanitize_name(&devices.join("_"))
        );
        let dst_path = session_dir.join(&dst_filename);
        let _ = fs::copy(&zip_path, &dst_path);
        let _ = log_tx.send(format!("[AI Worker] Result ZIP preserved: {}", dst_path.display()));
        {
            let mut zips = collected_zips.lock().unwrap();
            if !zips.contains(&dst_filename) {
                zips.push(dst_filename.clone());
            }
        }
        return Ok(dst_filename);
    }
    Ok(String::new())
}

// -------------------------------------------------------------------------------------------------
// Suite Resolution Functions (Matching AUTO Algorithm)
// -------------------------------------------------------------------------------------------------

fn android_major(release: &str) -> String {
    let clean = release.trim();
    clean.split('.').next().unwrap_or("14").to_string()
}

fn security_patch_month(spl: &str) -> String {
    let clean = spl.trim();
    if clean.len() >= 7 {
        clean[5..7].to_string()
    } else {
        "08".to_string()
    }
}

fn suite_version_rank(version: &str) -> (u32, u32, u32) {
    let (base, revision) = version.split_once("_r").unwrap_or((version, "0"));
    let mut base_parts = base.split('.');
    let major = base_parts.next().and_then(|part| part.parse::<u32>().ok()).unwrap_or(0);
    let minor = base_parts.next().and_then(|part| part.parse::<u32>().ok()).unwrap_or(0);
    let rev = revision.parse::<u32>().unwrap_or(0);
    (major, minor, rev)
}

fn suite_version_matches_hint(version: &str, hint: &str) -> bool {
    if version == hint {
        return true;
    }
    if hint.contains("_r") {
        return false;
    }
    version.strip_prefix(hint).is_some_and(|rest| rest.starts_with("_r"))
}

fn available_suite_versions(root: &Path, suite: &str, suite_dir: &str) -> Vec<String> {
    let base = root.join(suite);
    let mut versions = fs::read_dir(base)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| {
            let path = entry.path();
            if path.join(suite_dir).is_dir() {
                entry.file_name().to_str().map(|value| value.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    versions.sort_by_key(|version| suite_version_rank(version));
    versions
}

fn resolve_versioned_suite_root(root: &Path, suite: &str, suite_dir: &str, version_hint: &str) -> Result<PathBuf, String> {
    let hint = version_hint.trim();
    let base = root.join(suite);

    if !hint.is_empty() {
        let exact = base.join(hint).join(suite_dir);
        if exact.is_dir() {
            return Ok(exact);
        }
    }

    let candidates = available_suite_versions(root, suite, suite_dir)
        .into_iter()
        .filter(|version| hint.is_empty() || suite_version_matches_hint(version, hint))
        .collect::<Vec<_>>();
    if let Some(best) = candidates.into_iter().min_by_key(|version| suite_version_rank(version)) {
        let path = base.join(&best).join(suite_dir);
        if path.is_dir() {
            return Ok(path);
        }
    }

    Err(format!(
        "{suite} tools for version {} not found under {}",
        if hint.is_empty() { "<default>" } else { hint },
        base.display()
    ))
}

fn resolve_cts_root(root: &Path, version_hint: &str) -> Result<PathBuf, String> {
    resolve_versioned_suite_root(root, "CTS", "android-cts", version_hint)
}

fn resolve_gts_root(root: &Path, version_hint: &str) -> Result<PathBuf, String> {
    resolve_versioned_suite_root(root, "GTS", "android-gts", version_hint)
}

fn resolve_sts_root(root: &Path, month: &str, android: &str) -> Result<PathBuf, String> {
    let path = root.join("STS").join(month).join(android).join("android-sts");
    if path.is_dir() {
        Ok(path)
    } else {
        let base_sts = root.join("STS");
        for entry in WalkDir::new(base_sts).into_iter().flatten() {
            if entry.file_type().is_dir() && entry.file_name() == "android-sts" {
                return Ok(entry.into_path());
            }
        }
        Err(format!("STS tools not found under {}", root.join("STS").display()))
    }
}

fn parse_xml_attribute(line: &str, attr: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pattern = format!("{}={}", attr, quote);
        if let Some(start_idx) = line.find(&pattern) {
            let val_start = start_idx + pattern.len();
            if let Some(end_idx) = line[val_start..].find(quote) {
                return Some(line[val_start..val_start + end_idx].to_string());
            }
        }
    }
    None
}

fn get_suite_info_from_xml(xml_path: &Path) -> Option<(String, String, String)> {
    let file = fs::File::open(xml_path).ok()?;
    let reader = BufReader::new(file);
    for line_result in reader.lines().take(50) {
        let line = line_result.ok()?;
        if line.contains("<Result ") {
            let name = parse_xml_attribute(&line, "suite_name").unwrap_or_default();
            let version = parse_xml_attribute(&line, "suite_version").unwrap_or_default();
            let build = parse_xml_attribute(&line, "suite_build_number").unwrap_or_default();
            return Some((name, version, build));
        }
    }
    None
}

fn classify_suite_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower.contains("verifier") || lower.contains("ctsv") {
        None
    } else if lower.contains("cts") || lower.contains("compatibility") {
        Some("CTS".to_string())
    } else if lower.contains("gts") || lower.contains("google") {
        Some("GTS".to_string())
    } else if lower.contains("sts") || lower.contains("security") {
        Some("STS".to_string())
    } else {
        None
    }
}

fn suite_version_from_result(result_dir: &Path) -> Option<String> {
    let (_, version, _) = get_suite_info_from_xml(&result_dir.join("test_result.xml"))?;
    suite_version_from_result_version(&version)
}

fn suite_version_from_result_version(version: &str) -> Option<String> {
    let clean = version.trim();
    if clean.is_empty() {
        return None;
    }
    let prefix = clean.split_whitespace().next().unwrap_or(clean);
    let normalized = prefix
        .trim_start_matches(|ch: char| !ch.is_ascii_digit())
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '_' || *ch == 'r' || *ch == 'R')
        .collect::<String>()
        .replace("_R", "_r");
    if normalized.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        Some(normalized)
    } else {
        None
    }
}

fn suite_root_for_laundry_result(root: &Path, suite: &str, devices: &[String], result_dir: &Path) -> Result<PathBuf, String> {
    if suite == "CTS" || suite == "GTS" {
        if let Some(version) = suite_version_from_result(result_dir) {
            return if suite == "CTS" {
                resolve_cts_root(root, &version)
            } else {
                resolve_gts_root(root, &version)
            };
        }
    }
    suite_root_for_device(root, suite, devices)
}

fn suite_root_for_device(root: &Path, suite: &str, devices: &[String]) -> Result<PathBuf, String> {
    let first = devices.first().ok_or_else(|| "No device connected for suite resolution".to_string())?;
    let props = device_props(first).unwrap_or_default();
    let oneui = props.get("ro.build.version.oneui").map(|s| s.as_str()).unwrap_or("");
    let release = props.get("ro.build.version.release").map(|s| s.as_str()).unwrap_or("14");
    let android = if oneui == "80500" {
        "16.1".to_string()
    } else {
        android_major(release)
    };

    match suite {
        "CTS" => resolve_cts_root(root, &android),
        "GTS" => resolve_gts_root(root, ""),
        "STS" => {
            let spl = props.get("ro.build.version.security_patch").map(|s| s.as_str()).unwrap_or("2026-08-01");
            let month = security_patch_month(spl);
            resolve_sts_root(root, &month, &android)
        }
        _ => Err(format!("Unknown suite: {suite}")),
    }
}

// -------------------------------------------------------------------------------------------------
// Suite Workspace Isolation (Matching AUTO Algorithm)
// -------------------------------------------------------------------------------------------------

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|err| format!("Cannot create dir {}: {err}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|err| format!("Cannot read {}: {err}", src.display()))?.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            let _ = fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

fn suite_workspace(root: &Path, suite_root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    suite_root.hash(&mut hasher);
    let workspace = root.join(".gba-workspaces").join(sanitize_name(run_id)).join(format!("suite_{:x}", hasher.finish()));
    let install = workspace.join(suite_root.file_name().unwrap_or_default());
    if install.exists() {
        return Ok(install);
    }
    fs::create_dir_all(&install).map_err(|err| format!("Cannot create workspace {}: {err}", install.display()))?;
    for entry in fs::read_dir(suite_root).map_err(|err| format!("Cannot read suite root {}: {err}", suite_root.display()))?.flatten() {
        let name = entry.file_name();
        if name == "results" || name == "logs" {
            let _ = fs::create_dir(install.join(&name));
            continue;
        }
        let target = install.join(&name);
        if name == "subplans" && entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &target)
                .map_err(|err| format!("Cannot copy subplans: {err}"))?;
        } else if name == "tools" && entry.path().is_dir() {
            let _ = fs::create_dir(&target);
            for tool in fs::read_dir(entry.path()).map_err(|err| err.to_string())?.flatten() {
                let tool_target = target.join(tool.file_name());
                if matches!(tool.file_name().to_str(), Some("cts-tradefed" | "gts-tradefed" | "sts-tradefed" | "test-utils-script")) {
                    let _ = fs::copy(tool.path(), &tool_target);
                } else {
                    let _ = symlink(tool.path(), &tool_target);
                }
            }
        } else {
            let _ = symlink(entry.path(), &target);
        }
    }
    Ok(install)
}

// -------------------------------------------------------------------------------------------------
// Tradefed Execution and Stdin/Stdout Stream
// -------------------------------------------------------------------------------------------------

fn append_file_line(path: &Path, line: &str) {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn terminate_process_tree(pid: u32) {
    let group = format!("-{pid}");
    let _ = Command::new("kill").args(["-TERM", &group]).status();
    std::thread::sleep(Duration::from_millis(800));
    let _ = Command::new("kill").args(["-KILL", &group]).status();
}

fn suite_log_has_completion_marker(log_file: &Path) -> bool {
    let content = fs::read_to_string(log_file).unwrap_or_default();
    content
        .lines()
        .rev()
        .take(120)
        .any(|line| line.contains("Result/Log Location") || line.contains("=============== Summary ==============="))
}

pub fn update_device_busy_suite(auto_root: &Path, devices: &[String], suite_name: &str) {
    let mut busy_registry = read_busy_registry(auto_root);
    for s in devices {
        if let Some(dev) = busy_registry.devices.get_mut(s) {
            dev.current_suite = Some(format!("RUNNING {}", suite_name.to_uppercase()));
        }
    }
    let _ = write_busy_registry(auto_root, &busy_registry);
}

fn run_suite_process(
    suite: &str,
    devices: &[String],
    executable: &Path,
    suite_command: &str,
    via_pipe: bool,
    log_file: &Path,
    timeout_secs: u64,
    run_id: &str,
    _test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: Option<&mpsc::UnboundedSender<(String, String, u64)>>,
) -> Result<i32, String> {
    let devices_text = devices.join(",");
    if let Some(stx) = status_tx {
        let _ = stx.send((suite.to_string(), "Starting".to_string(), 0));
    }
    let _ = log_tx.send(format!("[AI Worker] {suite}: launching tradefed for [{devices_text}]"));
    let _ = log_tx.send(format!("[{suite}] {suite_command}"));

    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid executable path: {}", executable.display()))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| format!("Invalid executable parent: {}", executable.display()))?;

    let parent_auto = executable_dir.parent().and_then(|p| p.parent()).unwrap_or(executable_dir);
    update_device_busy_suite(parent_auto, devices, suite);

    let mut command = Command::new(format!("./{executable_name}"));
    command
        .current_dir(executable_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command.process_group(0);

    if let Ok(current_path) = std::env::var("PATH") {
        let parent_auto = executable_dir.parent().and_then(|p| p.parent()).unwrap_or(executable_dir);
        let gba_bin = parent_auto.join(".gba-bin");
        command.env("PATH", format!("{}:{current_path}", gba_bin.display()));
    }

    if via_pipe {
        command.stdin(Stdio::piped());
    } else {
        command.args(suite_command.split_whitespace());
    }

    if is_run_cancelled(run_id) {
        return Ok(130);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {suite}: {err}"))?;
    let pid = child.id();
    register_run_pid(run_id, pid);
    let _ = log_tx.send(format!("[AI Worker] {suite}: started pid={pid}"));

    if via_pipe {
        if let Some(mut stdin) = child.stdin.take() {
            let cmd = suite_command.to_string();
            std::thread::spawn(move || {
                let _ = writeln!(stdin, "{cmd}");
                std::thread::sleep(Duration::from_secs(timeout_secs));
            });
        }
    }

    let log_tx_err = log_tx.clone();
    let log_file_err = log_file.to_path_buf();
    let suite_err_tag = suite.to_string();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                append_file_line(&log_file_err, &line);
                let _ = log_tx_err.send(format!("[{suite_err_tag}] [stderr] {line}"));
            }
        });
    }

    let log_tx_out = log_tx.clone();
    let log_file_out = log_file.to_path_buf();
    let status_tx_clone = status_tx.cloned();
    let suite_name = suite.to_string();
    let start_inst = Instant::now();
    if let Some(stdout) = child.stdout.take() {
        let suite_out_tag = suite_name.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                append_file_line(&log_file_out, &line);
                let elapsed = start_inst.elapsed().as_secs();
                if let Some(ref stx) = status_tx_clone {
                    let _ = stx.send((suite_name.clone(), "Running".to_string(), elapsed));
                }
                let _ = log_tx_out.send(format!("[{suite_out_tag}] {line}"));
            }
        });
    }

    let code;
    let started = Instant::now();
    loop {
        if is_run_cancelled(run_id) {
            let _ = log_tx.send(format!("[AI Worker] {suite}: run cancelled, terminating pid={pid}"));
            terminate_process_tree(pid);
            let _ = child.wait();
            code = 130;
            break;
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(0);
                break;
            }
            Ok(None) => {}
            Err(err) => {
                let _ = log_tx.send(format!("[AI Worker] {suite}: wait failed: {err}"));
                code = 1;
                break;
            }
        }

        if suite_log_has_completion_marker(log_file) {
            let _ = log_tx.send(format!("[AI Worker] {suite}: completion marker detected; closing tradefed console."));
            terminate_process_tree(pid);
            let _ = child.wait();
            code = 0;
            break;
        }

        if started.elapsed().as_secs() > timeout_secs {
            let _ = log_tx.send(format!("[AI Worker] {suite}: timeout reached ({timeout_secs}s); terminating tradefed."));
            terminate_process_tree(pid);
            let _ = child.wait();
            code = 124;
            break;
        }

        std::thread::sleep(Duration::from_millis(500));
    }

    unregister_run_pid(run_id, pid);

    let _ = log_tx.send(format!("[AI Worker] {suite}: tradefed finished with code {code}"));
    Ok(code)
}

// -------------------------------------------------------------------------------------------------
// DeviceInfo Handling & Staging (Matching AUTO Algorithm)
// -------------------------------------------------------------------------------------------------

fn latest_deviceinfo(results_dir: &Path, filename: &str) -> Option<PathBuf> {
    WalkDir::new(results_dir)
        .into_iter()
        .flatten()
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == filename)
        .filter_map(|entry| {
            let path = entry.path().to_path_buf();
            let modified = fs::metadata(&path).and_then(|metadata| metadata.modified()).ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn latest_property_deviceinfo(results_dir: &Path) -> Option<PathBuf> {
    latest_deviceinfo(results_dir, "PropertyDeviceInfo.deviceinfo.json")
}

fn latest_client_id_deviceinfo(results_dir: &Path) -> Option<PathBuf> {
    latest_deviceinfo(results_dir, "ClientIdDeviceInfo.deviceinfo.json")
}

fn property_deviceinfo_in_result(result_dir: &Path) -> Option<PathBuf> {
    latest_property_deviceinfo(result_dir)
}

fn client_id_deviceinfo_in_result(result_dir: &Path) -> Option<PathBuf> {
    latest_client_id_deviceinfo(result_dir)
}

fn cleanup_deviceinfo_backups(result_dir: &Path) {
    for entry in WalkDir::new(result_dir).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with("PropertyDeviceInfo_") || name.starts_with("ClientIdDeviceInfo_") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn run_laundry_initial_gts(
    root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    devices: &[String],
    gts_command: &str,
    timeout_secs: u64,
    model: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    _status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<DeviceInfoSources, String> {
    let gts_root = resolve_gts_root(root, "")?;
    let gts_workspace = suite_workspace(root, &gts_root, run_id)?;
    let gts_exe = gts_workspace.join("tools/gts-tradefed");
    if !gts_exe.is_file() {
        return Err(format!("gts-tradefed not found: {}", gts_exe.display()));
    }

    let cmd = format!(
        "{gts_command} --shard-count {}{}",
        devices.len(),
        serial_args(devices)
    );
    let log_file = log_dir.join(format!("laundry_initial_gts_{}_{}devs.log", sanitize_name(model), devices.len()));
    let exit_code = run_suite_process(
        "GTS",
        devices,
        &gts_exe,
        &cmd,
        true,
        &log_file,
        timeout_secs,
        run_id,
        test_type,
        log_tx,
        None,
    )?;

    if exit_code != 0 {
        let _ = log_tx.send("[AI Worker] Initial GTS returned non-zero; trying to collect deviceinfo anyway.".to_string());
    }

    let property_deviceinfo = latest_property_deviceinfo(&gts_workspace.join("results"))
        .ok_or_else(|| "PropertyDeviceInfo.deviceinfo.json not found after initial GTS".to_string())?;
    let client_id_deviceinfo = latest_client_id_deviceinfo(&gts_root.join("results"));

    let _ = log_tx.send(format!("[AI Worker] Deviceinfo source: {}", property_deviceinfo.display()));
    let stable_property = session_dir.join(format!(
        "PropertyDeviceInfo_{}_{}.deviceinfo.json",
        sanitize_name(&devices.join("_")),
        timestamp_compact()
    ));
    fs::copy(&property_deviceinfo, &stable_property)
        .map_err(|err| format!("Cannot preserve deviceinfo {}: {err}", property_deviceinfo.display()))?;

    let stable_client_id = client_id_deviceinfo.and_then(|source| {
        let target = session_dir.join(format!(
            "ClientIdDeviceInfo_{}_{}.deviceinfo.json",
            sanitize_name(&devices.join("_")),
            timestamp_compact()
        ));
        fs::copy(&source, &target).ok().map(|_| target)
    });

    let _ = log_tx.send(format!("[AI Worker] Deviceinfo preserved: {}", stable_property.display()));
    if let Some(ref path) = stable_client_id {
        let _ = log_tx.send(format!("[AI Worker] ClientId deviceinfo preserved: {}", path.display()));
    }

    Ok(DeviceInfoSources { property: stable_property, client_id: stable_client_id })
}

fn parse_retry_session_id(output: &str, result_dir_name: &str) -> Option<String> {
    // 1. Check exact or partial match with result_dir_name
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains(result_dir_name) {
            if let Some(session) = trimmed.split_whitespace().next() {
                if session.chars().all(|ch| ch.is_ascii_digit()) {
                    return Some(session.to_string());
                }
            }
        }
    }
    // 2. If result_dir_name has date format (e.g., 2026.10.02_13.23.30...), match date prefix
    let date_prefix = result_dir_name.split('_').take(2).collect::<Vec<_>>().join("_");
    if !date_prefix.is_empty() && date_prefix != result_dir_name {
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.contains(&date_prefix) {
                if let Some(session) = trimmed.split_whitespace().next() {
                    if session.chars().all(|ch| ch.is_ascii_digit()) {
                        return Some(session.to_string());
                    }
                }
            }
        }
    }
    // 3. Match any valid session numeric row from 'l r'
    for line in output.lines() {
        let trimmed = line.trim();
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 4 && parts[0].chars().all(|ch| ch.is_ascii_digit()) {
            if parts[1].chars().all(|ch| ch.is_ascii_digit()) {
                return Some(parts[0].to_string());
            }
        }
    }
    None
}

fn run_tradefed_console_command(
    suite: &str,
    executable: &Path,
    console_command: &str,
    log_file: &Path,
    timeout_secs: u64,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
) -> Result<String, String> {
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid executable path: {}", executable.display()))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| format!("Invalid executable parent: {}", executable.display()))?;

    let mut command = Command::new(format!("./{executable_name}"));
    command
        .current_dir(executable_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command.process_group(0);

    if let Ok(current_path) = std::env::var("PATH") {
        let parent_auto = executable_dir.parent().and_then(|p| p.parent()).unwrap_or(executable_dir);
        let gba_bin = parent_auto.join(".gba-bin");
        command.env("PATH", format!("{}:{current_path}", gba_bin.display()));
    }

    if is_run_cancelled(run_id) {
        return Ok(String::new());
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {suite} console: {err}"))?;
    let pid = child.id();
    register_run_pid(run_id, pid);
    let _ = log_tx.send(format!("[AI Worker] {suite}: console pid={pid} command={console_command}"));

    // Write command and exit to stdin to prevent tradefed from hanging in interactive loop
    if let Some(mut stdin) = child.stdin.take() {
        let cmd = format!("{console_command}\nexit\n");
        std::thread::spawn(move || {
            let _ = std::io::Write::write_all(&mut stdin, cmd.as_bytes());
            let _ = std::io::Write::flush(&mut stdin);
        });
    }

    let output = Arc::new(Mutex::new(String::new()));
    let output_ready = Arc::new(AtomicBool::new(false));

    if let Some(stdout) = child.stdout.take() {
        let out_buf = Arc::clone(&output);
        let ready_flag = Arc::clone(&output_ready);
        let log_file_clone = log_file.to_path_buf();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                append_file_line(&log_file_clone, &line);
                if let Ok(mut text) = out_buf.lock() {
                    text.push_str(&line);
                    text.push('\n');
                }
                if line.contains("Pass") || line.contains("Session") || line.contains("cts-tf >") || line.contains("gts-tf >") || line.contains("console >") {
                    ready_flag.store(true, Ordering::SeqCst);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let out_buf = Arc::clone(&output);
        let log_file_clone = log_file.to_path_buf();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                append_file_line(&log_file_clone, &line);
                if let Ok(mut text) = out_buf.lock() {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
        });
    }

    let started = Instant::now();
    loop {
        if is_run_cancelled(run_id) {
            terminate_process_tree(pid);
            let _ = child.wait();
            break;
        }

        if let Ok(Some(_)) = child.try_wait() {
            break;
        }

        if output_ready.load(Ordering::SeqCst) && started.elapsed().as_millis() > 2500 {
            std::thread::sleep(Duration::from_millis(500));
            terminate_process_tree(pid);
            let _ = child.wait();
            break;
        }

        if started.elapsed().as_secs() > timeout_secs {
            terminate_process_tree(pid);
            let _ = child.wait();
            break;
        }

        std::thread::sleep(Duration::from_millis(200));
    }

    unregister_run_pid(run_id, pid);

    let result_str = output.lock().map(|t| t.clone()).unwrap_or_default();
    Ok(result_str)
}

fn resolve_retry_session_id(
    suite: &str,
    executable: &Path,
    result_dir_name: &str,
    log_file: &Path,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
) -> Result<String, String> {
    let _ = log_tx.send(format!("[AI Worker] {suite}: resolving retry session for {result_dir_name}"));
    for attempt in 1..=2 {
        if is_run_cancelled(run_id) {
            return Err("Run cancelled".to_string());
        }
        if let Ok(output) = run_tradefed_console_command(suite, executable, "l r", log_file, 15, run_id, log_tx) {
            if let Some(session_id) = parse_retry_session_id(&output, result_dir_name) {
                let _ = log_tx.send(format!("[AI Worker] {suite}: matched retry session {session_id} for {result_dir_name}"));
                return Ok(session_id);
            }
        }
        let _ = log_tx.send(format!("[AI Worker] {suite}: retry session resolution check ({attempt}/2)..."));
        std::thread::sleep(Duration::from_millis(800));
    }
    let _ = log_tx.send(format!("[AI Worker] {suite}: auto-selecting default session 0 for staged result {result_dir_name}"));
    Ok("0".to_string())
}

fn run_laundry_retries(
    root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    suite: &str,
    devices: &[String],
    source_results: &[PathBuf],
    replacement_deviceinfos: Option<&DeviceInfoSources>,
    timeout_secs: u64,
    model: &str,
    pda: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<Vec<i32>, String> {
    let mut codes = Vec::new();
    for (index, source) in source_results.iter().enumerate() {
        if is_run_cancelled(run_id) {
            let _ = log_tx.send(format!("[AI Worker] {suite}: run cancelled, aborting remaining retries."));
            break;
        }
        let suite_root = suite_root_for_laundry_result(root, suite, devices, source)?;
        let suite_workspace = suite_workspace(root, &suite_root, run_id)?;
        let tradefed_name = match suite {
            "CTS" => "cts-tradefed",
            "GTS" => "gts-tradefed",
            "STS" => "sts-tradefed",
            _ => "cts-tradefed",
        };
        let executable = suite_workspace.join("tools").join(tradefed_name);
        if !executable.is_file() {
            return Err(format!("{suite} tradefed not found: {}", executable.display()));
        }

        let results_dir = suite_workspace.join("results");
        fs::create_dir_all(&results_dir).map_err(|err| format!("Cannot create {}: {err}", results_dir.display()))?;

        let source_folder_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("result");
        let target = if !results_dir.join(source_folder_name).exists() {
            results_dir.join(source_folder_name)
        } else {
            results_dir.join(format!("{source_folder_name}_{index}"))
        };
        let _ = log_tx.send(format!("[AI Worker] {suite}: staging result {} -> {}", source.display(), target.display()));
        copy_dir_recursive(source, &target)
            .map_err(|err| format!("Cannot stage {} to {}: {err}", source.display(), target.display()))?;
        cleanup_deviceinfo_backups(&target);

        if let Some(replacements) = replacement_deviceinfos {
            if let Some(target_info) = property_deviceinfo_in_result(&target) {
                let _ = fs::copy(&replacements.property, &target_info);
                let _ = log_tx.send(format!("[AI Worker] {suite}: replaced {} (PropertyDeviceInfo)", target_info.display()));
            }
            if let (Some(client_src), Some(target_info)) = (&replacements.client_id, client_id_deviceinfo_in_result(&target)) {
                let _ = fs::copy(client_src, &target_info);
                let _ = log_tx.send(format!("[AI Worker] {suite}: replaced {} (ClientIdDeviceInfo)", target_info.display()));
            }
            cleanup_deviceinfo_backups(&target);
        }

        let result_dir_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(source_folder_name);

        let session_id = resolve_retry_session_id(
            suite,
            &executable,
            result_dir_name,
            &log_dir.join(format!("laundry_list_{}_{}_{}devs.log", suite.to_lowercase(), index + 1, devices.len())),
            run_id,
            log_tx,
        )?;

        let cmd = format!(
            "run retry --retry {session_id} --retry-type NOT_EXECUTED --shard-count {}{}",
            devices.len(),
            serial_args(devices)
        );
        let _ = log_tx.send(format!("[AI Worker] {suite}: retry session={session_id} result={}", target.display()));
        let log_file = log_dir.join(format!("laundry_retry_{}_{}_{}devs.log", suite.to_lowercase(), index + 1, devices.len()));

        let snapshot = ResultSnapshot::capture(&results_dir);
        let started = SystemTime::now();

        let code = run_suite_process(
            suite,
            devices,
            &executable,
            &cmd,
            suite != "STS",
            &log_file,
            timeout_secs,
            run_id,
            test_type,
            log_tx,
            Some(status_tx),
        )?;

        // Copy retry artifact zip
        let _ = copy_laundry_retry_artifact(
            session_dir,
            suite,
            &suite_workspace,
            &target,
            &snapshot,
            started,
            model,
            pda,
            devices,
            index + 1,
            log_tx,
            collected_zips,
        );

        codes.push(code);
    }
    Ok(codes)
}

// -------------------------------------------------------------------------------------------------
// Prepare Laundry Source from Zip
// -------------------------------------------------------------------------------------------------

fn extract_nested_zips(dir: &Path) -> Result<(), String> {
    loop {
        let mut zip_files = Vec::new();
        for entry in WalkDir::new(dir).into_iter().flatten() {
            if entry.file_type().is_file() {
                let path = entry.path().to_path_buf();
                if let Some(ext) = path.extension() {
                    if ext.to_string_lossy().to_lowercase() == "zip" {
                        let fname_lower = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                        // Do not extract nested SCAT zip files! They must be preserved raw.
                        if fname_lower.contains("scat") {
                            continue;
                        }
                        zip_files.push(path);
                    }
                }
            }
        }
        if zip_files.is_empty() {
            break;
        }
        for zip_path in zip_files {
            let mut dest_dir = zip_path.clone();
            dest_dir.set_extension("");
            let _ = fs::create_dir_all(&dest_dir);
            if let Ok(f) = File::open(&zip_path) {
                if let Ok(mut archive) = ZipArchive::new(BufReader::new(f)) {
                    let _ = archive.extract(&dest_dir);
                }
            }
            let _ = fs::remove_file(&zip_path);
        }
    }
    Ok(())
}

fn scan_laundry_results(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>, Vec<PathBuf>) {
    let mut cts = Vec::new();
    let mut gts = Vec::new();
    let mut sts = Vec::new();

    for entry in WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() || entry.file_name() != "test_result.xml" {
            continue;
        }
        let Some(parent) = entry.path().parent().map(|p| p.to_path_buf()) else {
            continue;
        };

        if is_cts_verifier_result(&entry.path(), &parent) {
            continue;
        }

        let mut suite_type = None;
        if let Some((name, _, _)) = get_suite_info_from_xml(&entry.path()) {
            suite_type = classify_suite_name(&name);
        }

        if suite_type.is_none() {
            let path_str = parent.to_string_lossy().to_lowercase();
            if path_str.contains("gts") {
                suite_type = Some("GTS".to_string());
            } else if path_str.contains("sts") {
                suite_type = Some("STS".to_string());
            } else if path_str.contains("cts") {
                suite_type = Some("CTS".to_string());
            }
        }

        match suite_type.as_deref() {
            Some("CTS") => {
                if !cts.contains(&parent) {
                    cts.push(parent);
                }
            }
            Some("GTS") => {
                if !gts.contains(&parent) {
                    gts.push(parent);
                }
            }
            Some("STS") => {
                if !sts.contains(&parent) {
                    sts.push(parent);
                }
            }
            _ => {
                // Unknown suite: skipped, do NOT fallback to CTS
            }
        }
    }
    (cts, gts, sts)
}

fn verify_laundry_suite_tools(
    root: &Path,
    devices: &[String],
    source: &LaundrySource,
    suites: &[&str],
    log_tx: &mpsc::UnboundedSender<String>,
) -> Result<(), String> {
    for suite in suites {
        let needed = match *suite {
            "CTS" => !source.cts_results.is_empty(),
            "GTS" => !source.cts_results.is_empty() || !source.gts_results.is_empty(),
            "STS" => !source.sts_results.is_empty(),
            _ => false,
        };
        if !needed {
            let _ = log_tx.send(format!("[preflight] {suite}: skipped; not found in laundry zip."));
            continue;
        }
        let result_dirs = match *suite {
            "CTS" => &source.cts_results,
            "GTS" => &source.gts_results,
            "STS" => &source.sts_results,
            _ => continue,
        };

        if result_dirs.is_empty() {
            let suite_root = suite_root_for_device(root, suite, devices)?;
            let tool_name = match *suite {
                "CTS" => "cts-tradefed",
                "GTS" => "gts-tradefed",
                "STS" => "sts-tradefed",
                _ => "tradefed",
            };
            let tool = suite_root.join("tools").join(tool_name);
            if !tool.is_file() {
                return Err(format!("{suite} tool required but not found: {}", tool.display()));
            }
            let _ = log_tx.send(format!("[preflight] {suite}: tool ready {}", tool.display()));
            continue;
        }

        for dir in result_dirs {
            let suite_root = suite_root_for_laundry_result(root, suite, devices, dir)?;
            let tool_name = match *suite {
                "CTS" => "cts-tradefed",
                "GTS" => "gts-tradefed",
                "STS" => "sts-tradefed",
                _ => "tradefed",
            };
            let tool = suite_root.join("tools").join(tool_name);
            if !tool.is_file() {
                return Err(format!("{suite} tool required by laundry zip but not found: {}", tool.display()));
            }
            let _ = log_tx.send(format!("[preflight] {suite}: tool ready {}", tool.display()));

            let version_txt = suite_root.join("tools/version.txt");
            let local_version = if version_txt.is_file() {
                fs::read_to_string(&version_txt)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };

            let xml_path = dir.join("test_result.xml");
            if xml_path.is_file() {
                if let Some((name, version, build)) = get_suite_info_from_xml(&xml_path) {
                    if !local_version.is_empty() && !build.is_empty() && build != local_version {
                        let _ = log_tx.send(format!(
                            "[preflight][WARN] {suite}: version mismatch (laundry: {name} {version} / {build}, local tool: {local_version}). Proceeding with available tools."
                        ));
                    } else {
                        let _ = log_tx.send(format!(
                            "[preflight] {suite}: version checked and matched (laundry: {name} {version} / {build}, local tool: {local_version})"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn prepare_laundry_source(
    auto_root: &Path,
    devices: &[String],
    payload: &RunSuitePayload,
    session_dir: &Path,
    pda: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<LaundrySource, String> {
    let zip_str = payload
        .laundry_zip_path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{} requires laundry zip file", payload.test_type))?;

    let resolved = resolve_zip_path(zip_str)
        .ok_or_else(|| format!("Laundry zip file not found: {zip_str}"))?;

    let _ = log_tx.send(format!("[AI Worker] Laundry zip selected: {}", resolved.display()));
    let temp = Arc::new(
        tempfile::Builder::new()
            .prefix("gba-laundry-")
            .tempdir_in(session_dir)
            .map_err(|err| format!("Cannot create laundry temp dir: {err}"))?,
    );

    let _ = log_tx.send(format!("[AI Worker] Extracting zip to {}", temp.path().display()));
    let file = File::open(&resolved).map_err(|e| format!("Cannot open zip: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;
    archive.extract(temp.path()).map_err(|e| format!("Cannot extract zip: {e}"))?;

    let _ = log_tx.send("[AI Worker] Checking and extracting any nested zip files...".to_string());
    let _ = extract_nested_zips(temp.path());

    // Auto Copy & Preserve SCAT files as raw zip into the session directory and collected zips
    preserve_scat_files(temp.path(), &resolved, session_dir, pda, log_tx, collected_zips);

    let (mut cts_results, mut gts_results, mut sts_results) = scan_laundry_results(temp.path());
    let _ = log_tx.send(format!(
        "[AI Worker] Scanned laundry results: CTS={} GTS={} STS={}",
        cts_results.len(),
        gts_results.len(),
        sts_results.len()
    ));

    // Filter by selected laundry results if specified
    if !payload.selected_laundry_results.is_empty() {
        let sel: HashSet<String> = payload.selected_laundry_results.iter().cloned().collect();
        let selected_dirs: HashSet<String> = payload.selected_laundry_rows.iter().filter_map(|r| {
            r.get("result_dir").and_then(|v| v.as_str()).map(|s| s.to_string())
        }).collect();

        let filter_fn = |p: &PathBuf| -> bool {
            let dirname = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            sel.iter().any(|s| s.contains(dirname) || dirname.contains(s)) ||
            selected_dirs.iter().any(|d| d.contains(dirname) || dirname.contains(d))
        };

        cts_results = cts_results.into_iter().filter(|p| filter_fn(p)).collect();
        gts_results = gts_results.into_iter().filter(|p| filter_fn(p)).collect();
        sts_results = sts_results.into_iter().filter(|p| filter_fn(p)).collect();

        let _ = log_tx.send(format!(
            "[AI Worker] Custom laundry selection applied: CTS={} GTS={} STS={}",
            cts_results.len(),
            gts_results.len(),
            sts_results.len()
        ));
    }

    let source = LaundrySource {
        _temp: temp.clone(),
        cts_results,
        gts_results,
        sts_results,
    };

    let _ = verify_laundry_suite_tools(auto_root, devices, &source, &["CTS", "GTS", "STS"], log_tx);

    Ok(source)
}

// -------------------------------------------------------------------------------------------------
// High-Level Workflow Runners (Matching AUTO Algorithm)
// -------------------------------------------------------------------------------------------------

fn run_laundry_smr_flow(
    auto_root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    payload: &RunSuitePayload,
    model: &str,
    pda: &str,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<i32, String> {
    if payload.user_devices.is_empty() || payload.userdebug_devices.is_empty() {
        let err = "[AI Worker][ERROR] Laundry SMR membutuhkan minimal 1 perangkat build type USER (untuk CTS/GTS) dan minimal 1 perangkat build type USERDEBUG (untuk STS).";
        let _ = log_tx.send(err.to_string());
        return Err(err.to_string());
    }
    let mut cts_gts_devices = payload.user_devices.clone();

    let source = prepare_laundry_source(auto_root, &cts_gts_devices, payload, session_dir, pda, log_tx, collected_zips)?;
    let has_cts_or_gts = !source.cts_results.is_empty() || !source.gts_results.is_empty();

    if source.sts_results.is_empty() {
        for d in &payload.userdebug_devices {
            if !cts_gts_devices.contains(d) {
                cts_gts_devices.push(d.clone());
            }
        }
    } else if cts_gts_devices.is_empty() {
        cts_gts_devices = payload.userdebug_devices.clone();
    }

    let mut exit_codes = Vec::new();

    // 1. If STS results & userdebug devices exist: spawn STS retry thread immediately!
    let sts_handle = if !payload.userdebug_devices.is_empty() && !source.sts_results.is_empty() {
        let _ = log_tx.send("[AI Worker] Laundry (SMR): STS retry starts immediately on userdebug devices.".to_string());
        let root_sts = auto_root.to_path_buf();
        let session_sts = session_dir.to_path_buf();
        let log_sts = log_dir.to_path_buf();
        let devs_sts = payload.userdebug_devices.clone();
        let results_sts = source.sts_results.clone();
        let timeout_sts = payload.timeout_secs;
        let model_sts = model.to_string();
        let pda_sts = pda.to_string();
        let run_id_sts = run_id.to_string();
        let test_type_sts = payload.test_type.clone();
        let log_tx_sts = log_tx.clone();
        let stat_tx_sts = status_tx.clone();
        let zips_sts = Arc::clone(collected_zips);

        Some(std::thread::spawn(move || {
            let _sts_guard = STS_RUN_LOCK.lock().unwrap();
            let _ = ensure_ghidra_for_sts(&log_tx_sts);
            run_laundry_retries(
                &root_sts,
                &session_sts,
                &log_sts,
                "STS",
                &devs_sts,
                &results_sts,
                None,
                timeout_sts,
                &model_sts,
                &pda_sts,
                &run_id_sts,
                &test_type_sts,
                &log_tx_sts,
                &stat_tx_sts,
                &zips_sts,
            )
        }))
    } else {
        None
    };

    // 2. If CTS/GTS devices exist: Initial GTS for Property DeviceInfo -> CTS Retry -> GTS Retry
    if !cts_gts_devices.is_empty() && has_cts_or_gts {
        if is_run_cancelled(run_id) {
            return Ok(130);
        }
        let _ = log_tx.send("[AI Worker] Laundry (SMR): initial GTS gtsmr run for DeviceInfo extraction.".to_string());
        let deviceinfo = match run_laundry_initial_gts(
            auto_root,
            session_dir,
            log_dir,
            &cts_gts_devices,
            "run gts --subplan gtsmr",
            payload.timeout_secs,
            model,
            run_id,
            &payload.test_type,
            log_tx,
            status_tx,
        ) {
            Ok(info) => Some(info),
            Err(err) => {
                let _ = log_tx.send(format!("[AI Worker] Note on initial GTS: {err} (proceeding to CTS/GTS retries)"));
                None
            }
        };

        if is_run_cancelled(run_id) {
            return Ok(130);
        }

        if !source.cts_results.is_empty() {
            let _ = log_tx.send(format!("[AI Worker] CTS: {} result(s) queued for retry; 1 with PropertyDeviceInfo will be replaced.", source.cts_results.len()));
            match run_laundry_retries(
                auto_root,
                session_dir,
                log_dir,
                "CTS",
                &cts_gts_devices,
                &source.cts_results,
                deviceinfo.as_ref(),
                payload.timeout_secs,
                model,
                pda,
                run_id,
                &payload.test_type,
                log_tx,
                status_tx,
                collected_zips,
            ) {
                Ok(cts_codes) => exit_codes.extend(cts_codes),
                Err(err) => {
                    let _ = log_tx.send(format!("[AI Worker] CTS retry failed: {err}"));
                    exit_codes.push(1);
                }
            }
        }

        if is_run_cancelled(run_id) {
            return Ok(130);
        }

        if !source.gts_results.is_empty() {
            let _ = log_tx.send(format!("[AI Worker] GTS: {} result(s) queued for retry; 1 with PropertyDeviceInfo will be replaced.", source.gts_results.len()));
            match run_laundry_retries(
                auto_root,
                session_dir,
                log_dir,
                "GTS",
                &cts_gts_devices,
                &source.gts_results,
                deviceinfo.as_ref(),
                payload.timeout_secs,
                model,
                pda,
                run_id,
                &payload.test_type,
                log_tx,
                status_tx,
                collected_zips,
            ) {
                Ok(gts_codes) => exit_codes.extend(gts_codes),
                Err(err) => {
                    let _ = log_tx.send(format!("[AI Worker] GTS retry failed: {err}"));
                    exit_codes.push(1);
                }
            }
        }
    } else if !has_cts_or_gts {
        let _ = log_tx.send("[AI Worker] Laundry (SMR): STS-only selected, skipping GTS property/gtsmr process.".to_string());
    }

    // 3. Await STS thread if running
    if let Some(handle) = sts_handle {
        match handle.join() {
            Ok(Ok(sts_codes)) => exit_codes.extend(sts_codes),
            Ok(Err(e)) => {
                let _ = log_tx.send(format!("[AI Worker] STS retry note: {e}"));
                exit_codes.push(0);
            }
            Err(_) => exit_codes.push(0),
        }
    }

    Ok(0)
}

fn run_laundry_normal_flow(
    auto_root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    payload: &RunSuitePayload,
    model: &str,
    pda: &str,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<i32, String> {
    let mut all_devices = payload.user_devices.clone();
    for d in &payload.userdebug_devices {
        if !all_devices.contains(d) {
            all_devices.push(d.clone());
        }
    }
    let devices = if !all_devices.is_empty() { &all_devices } else { &payload.user_devices };
    let source = prepare_laundry_source(auto_root, devices, payload, session_dir, pda, log_tx, collected_zips)?;

    if is_run_cancelled(run_id) {
        return Ok(130);
    }

    let _ = log_tx.send("[AI Worker] Laundry (Normal/SKU): initial GTS property run.".to_string());
    let deviceinfo = run_laundry_initial_gts(
        auto_root,
        session_dir,
        log_dir,
        devices,
        "run gts --subplan property",
        payload.timeout_secs,
        model,
        run_id,
        &payload.test_type,
        log_tx,
        status_tx,
    )?;

    if is_run_cancelled(run_id) {
        return Ok(130);
    }

    let mut exit_codes = Vec::new();
    if !source.cts_results.is_empty() {
        let _ = log_tx.send(format!("[AI Worker] CTS: {} result(s) queued for retry; 1 with PropertyDeviceInfo will be replaced.", source.cts_results.len()));
        let cts_codes = run_laundry_retries(
            auto_root,
            session_dir,
            log_dir,
            "CTS",
            devices,
            &source.cts_results,
            Some(&deviceinfo),
            payload.timeout_secs,
            model,
            pda,
            run_id,
            &payload.test_type,
            log_tx,
            status_tx,
            collected_zips,
        )?;
        exit_codes.extend(cts_codes);
    }

    if is_run_cancelled(run_id) {
        return Ok(130);
    }

    if !source.gts_results.is_empty() {
        let _ = log_tx.send(format!("[AI Worker] GTS: {} result(s) queued for retry; 1 with PropertyDeviceInfo will be replaced.", source.gts_results.len()));
        let gts_codes = run_laundry_retries(
            auto_root,
            session_dir,
            log_dir,
            "GTS",
            devices,
            &source.gts_results,
            Some(&deviceinfo),
            payload.timeout_secs,
            model,
            pda,
            run_id,
            &payload.test_type,
            log_tx,
            status_tx,
            collected_zips,
        )?;
        exit_codes.extend(gts_codes);
    }

    Ok(0)
}

fn run_cts_then_gts_flow(
    auto_root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    devices: &[String],
    cts_subplan: &str,
    gts_command: &str,
    timeout_secs: u64,
    model: &str,
    pda: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<i32, String> {
    let cts_root = suite_root_for_device(auto_root, "CTS", devices)?;
    let cts_workspace = suite_workspace(auto_root, &cts_root, run_id)?;
    let cts_exe = cts_workspace.join("tools/cts-tradefed");
    if !cts_exe.is_file() {
        return Err(format!("cts-tradefed not found: {}", cts_exe.display()));
    }

    let cts_cmd = format!(
        "run cts --subplan {cts_subplan} --shard-count {}{}",
        devices.len(),
        serial_args(devices)
    );
    let cts_log = log_dir.join(format!("cts_{}_{}devs.log", sanitize_name(model), devices.len()));
    let _ = log_tx.send(format!("[AI Worker] CTS: starting subplan {cts_subplan} on [{}]", devices.join(",")));

    let cts_snapshot = ResultSnapshot::capture(&cts_workspace.join("results"));
    let cts_started = SystemTime::now();

    let cts_code = run_suite_process(
        "CTS",
        devices,
        &cts_exe,
        &cts_cmd,
        true,
        &cts_log,
        timeout_secs,
        run_id,
        test_type,
        log_tx,
        Some(status_tx),
    )?;

    let _ = copy_suite_result(
        session_dir,
        "CTS",
        &cts_workspace,
        devices,
        model,
        pda,
        &cts_snapshot,
        cts_started,
        log_tx,
        collected_zips,
    );

    if cts_code != 0 {
        let _ = log_tx.send("[AI Worker] CTS returned non-zero; GTS will still be attempted.".to_string());
    }

    if is_run_cancelled(run_id) {
        return Ok(130);
    }

    let gts_root = suite_root_for_device(auto_root, "GTS", devices)?;
    let gts_workspace = suite_workspace(auto_root, &gts_root, run_id)?;
    let gts_exe = gts_workspace.join("tools/gts-tradefed");
    if !gts_exe.is_file() {
        return Err(format!("gts-tradefed not found: {}", gts_exe.display()));
    }

    let gts_cmd = format!(
        "{gts_command} --shard-count {}{}",
        devices.len(),
        serial_args(devices)
    );
    let gts_log = log_dir.join(format!("gts_{}_{}devs.log", sanitize_name(model), devices.len()));
    let _ = log_tx.send(format!("[AI Worker] GTS: starting command '{gts_command}' on [{}]", devices.join(",")));

    let gts_snapshot = ResultSnapshot::capture(&gts_workspace.join("results"));
    let gts_started = SystemTime::now();

    let gts_code = run_suite_process(
        "GTS",
        devices,
        &gts_exe,
        &gts_cmd,
        true,
        &gts_log,
        timeout_secs,
        run_id,
        test_type,
        log_tx,
        Some(status_tx),
    )?;

    let _ = copy_suite_result(
        session_dir,
        "GTS",
        &gts_workspace,
        devices,
        model,
        pda,
        &gts_snapshot,
        gts_started,
        log_tx,
        collected_zips,
    );

    Ok(if cts_code == 0 && gts_code == 0 { 0 } else { 1 })
}

fn run_sts_flow(
    auto_root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    devices: &[String],
    timeout_secs: u64,
    model: &str,
    pda: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
    collected_zips: &Arc<Mutex<Vec<String>>>,
) -> Result<i32, String> {
    let _sts_guard = STS_RUN_LOCK.lock().unwrap();
    let _ = ensure_ghidra_for_sts(log_tx);

    let sts_root = suite_root_for_device(auto_root, "STS", devices)?;
    let sts_workspace = suite_workspace(auto_root, &sts_root, run_id)?;
    let sts_exe = sts_workspace.join("tools/sts-tradefed");
    if !sts_exe.is_file() {
        return Err(format!("sts-tradefed not found: {}", sts_exe.display()));
    }

    let (sts_plan, shard_arg) = if devices.len() > 1 {
        ("sts", format!(" --shard-count {}", devices.len()))
    } else {
        ("sts-dynamic-incremental", String::new())
    };

    let sts_cmd = format!(
        "run {} --test-arg com.android.compatibility.common.tradefed.testtype.JarHostTest:set-option:android.security.sts.KernelLtsTest:acknowledge_kernel_update_requirement_warning_failure:true{}{}",
        sts_plan,
        shard_arg,
        serial_args(devices)
    );
    let sts_log = log_dir.join(format!("sts_{}_{}devs.log", sanitize_name(model), devices.len()));
    let _ = log_tx.send(format!("[AI Worker] STS: starting {} on [{}]", sts_plan, devices.join(",")));

    let sts_snapshot = ResultSnapshot::capture(&sts_workspace.join("results"));
    let sts_started = SystemTime::now();

    let code = run_suite_process(
        "STS",
        devices,
        &sts_exe,
        &sts_cmd,
        false,
        &sts_log,
        timeout_secs,
        run_id,
        test_type,
        log_tx,
        Some(status_tx),
    )?;

    let _ = copy_suite_result(
        session_dir,
        "STS",
        &sts_workspace,
        devices,
        model,
        pda,
        &sts_snapshot,
        sts_started,
        log_tx,
        collected_zips,
    );

    Ok(code)
}
