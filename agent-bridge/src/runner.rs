use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::laundry::resolve_zip_path;
use crate::scanner::{device_props, read_busy_registry, write_busy_registry};
use crate::types::{BusyDevice, RunSuitePayload};

pub static ACTIVE_RUN_PIDS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn cancel_suite_run(run_id: &str) -> bool {
    let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
    if let Some(pid) = map.remove(run_id) {
        // Kill parent process
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
        // Kill child process tree (java, tradefed, adb)
        let _ = Command::new("pkill").arg("-9").arg("-P").arg(pid.to_string()).output();
        true
    } else {
        false
    }
}

pub struct RunOutcome {
    pub exit_code: i32,
    pub elapsed_secs: u64,
    pub result_dir: String,
    pub zip_file: Option<String>,
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
    extract_root: PathBuf,
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

    let start_time = Instant::now();
    let _ = log_tx.send("[Bridge] ==================================================".to_string());
    let _ = log_tx.send(format!("[Bridge] Initializing suite run: {}", payload.test_type));
    let _ = log_tx.send(format!("[Bridge] Run ID: {}", run_id));
    let _ = log_tx.send(format!("[Bridge] User devices: [{}]", payload.user_devices.join(", ")));
    let _ = log_tx.send(format!("[Bridge] Userdebug devices: [{}]", payload.userdebug_devices.join(", ")));
    let _ = log_tx.send("[Bridge] ==================================================".to_string());

    // 1. Mark devices as busy
    let mut busy_registry = read_busy_registry(auto_root);
    for s in &serials {
        busy_registry.devices.insert(
            s.clone(),
            BusyDevice {
                serial: s.clone(),
                is_userdebug: !payload.userdebug_devices.is_empty(),
                test_type: payload.test_type.clone(),
                model: payload.target_model.clone().unwrap_or_else(|| "Android".to_string()),
                pda: "".to_string(),
                run_id: run_id.clone(),
                started_at: chrono_timestamp(),
                result_dir: None,
                current_suite: Some(payload.test_type.clone()),
            },
        );
    }
    let _ = write_busy_registry(auto_root, &busy_registry);

    let session_dir = auto_root.join("Results").join(&run_id);
    let _ = fs::create_dir_all(&session_dir);
    let log_dir = session_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);

    let model = payload.target_model.clone().unwrap_or_else(|| "UnknownModel".to_string());
    let pda = "PDA".to_string();

    let exit_code = match payload.test_type.as_str() {
        "Laundry" | "Laundry Normal" | "Laundry SKU" | "Laundry SMR" => {
            let has_sts = payload.test_type == "Laundry SMR" || payload.selected_laundry_rows.iter().any(|r| {
                let suite = r.get("suite").and_then(|v| v.as_str()).unwrap_or("");
                let testcase = r.get("testcase").and_then(|v| v.as_str()).unwrap_or("");
                suite.eq_ignore_ascii_case("sts") || testcase.to_uppercase().contains("STS")
            });

            if has_sts {
                run_laundry_smr_flow(auto_root, &session_dir, &log_dir, payload, &model, &pda, &run_id, &log_tx, &status_tx)?
            } else {
                run_laundry_normal_flow(auto_root, &session_dir, &log_dir, payload, &model, &pda, &run_id, &log_tx, &status_tx)?
            }
        }
        "Cuci SMR" | "SMR" => {
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
            )?
        }
        "SKU" => {
            run_cts_then_gts_flow(
                auto_root,
                &session_dir,
                &log_dir,
                &payload.user_devices,
                "ctssku",
                "run gts --subplan variant",
                payload.timeout_secs,
                &model,
                &pda,
                &run_id,
                &payload.test_type,
                &log_tx,
                &status_tx,
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
            )?
        }
        _ => {
            // Default generic suite runner fallback
            run_generic_suite_flow(auto_root, &session_dir, &log_dir, payload, &run_id, &log_tx, &status_tx)?
        }
    };

    let elapsed = start_time.elapsed().as_secs();

    // 2. Clear busy state
    let mut busy_registry = read_busy_registry(auto_root);
    for s in &serials {
        busy_registry.devices.remove(s);
    }
    let _ = write_busy_registry(auto_root, &busy_registry);

    let _ = log_tx.send(format!("[Bridge] Run {} finished with exit code {}", run_id, exit_code));
    let _ = status_tx.send((payload.test_type.clone(), if exit_code == 0 { "Test Done".to_string() } else { "Failed".to_string() }, elapsed));

    Ok(RunOutcome {
        exit_code,
        elapsed_secs: elapsed,
        result_dir: session_dir.to_string_lossy().to_string(),
        zip_file: None,
        total: 100,
        passed: if exit_code == 0 { 100 } else { 0 },
        failed: if exit_code == 0 { 0 } else { 1 },
    })
}

fn chrono_timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", now.as_secs())
}

fn timestamp_compact() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", now.as_secs())
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
        // Fallback: search any android-sts under STS
        let base_sts = root.join("STS");
        for entry in WalkDir::new(base_sts).into_iter().flatten() {
            if entry.file_type().is_dir() && entry.file_name() == "android-sts" {
                return Ok(entry.into_path());
            }
        }
        Err(format!("STS tools not found under {}", root.join("STS").display()))
    }
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

fn run_suite_process(
    suite: &str,
    devices: &[String],
    executable: &Path,
    suite_command: &str,
    via_pipe: bool,
    _log_file: &Path,
    timeout_secs: u64,
    run_id: &str,
    _test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<i32, String> {
    let devices_text = devices.join(",");
    let _ = status_tx.send((suite.to_string(), "Starting".to_string(), 0));
    let _ = log_tx.send(format!("[runner] {suite}: launching tradefed for [{devices_text}]"));
    let _ = log_tx.send(format!("[{suite}] {suite_command}"));

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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {suite}: {err}"))?;
    let pid = child.id();
    {
        let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
        map.insert(run_id.to_string(), pid);
    }
    let _ = log_tx.send(format!("[{suite}] started pid={pid}"));

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
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = log_tx_err.send(format!("[stderr] {line}"));
            }
        });
    }

    let log_tx_out = log_tx.clone();
    let status_tx_clone = status_tx.clone();
    let suite_name = suite.to_string();
    let start_inst = Instant::now();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let elapsed = start_inst.elapsed().as_secs();
                let _ = status_tx_clone.send((suite_name.clone(), "Running".to_string(), elapsed));
                let _ = log_tx_out.send(line);
            }
        });
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    {
        let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
        map.remove(run_id);
    }

    let code = status.code().unwrap_or(0);
    let _ = log_tx.send(format!("[{suite}] Process exited with code {code}"));
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
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
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
        status_tx,
    )?;

    if exit_code != 0 {
        let _ = log_tx.send("[runner] Initial GTS returned non-zero; trying to collect deviceinfo anyway.".to_string());
    }

    let property_deviceinfo = latest_property_deviceinfo(&gts_workspace.join("results"))
        .ok_or_else(|| "PropertyDeviceInfo.deviceinfo.json not found after initial GTS".to_string())?;
    let client_id_deviceinfo = latest_client_id_deviceinfo(&gts_root.join("results"));

    let _ = log_tx.send(format!("[runner] Deviceinfo source: {}", property_deviceinfo.display()));
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

    let _ = log_tx.send(format!("[runner] Deviceinfo preserved: {}", stable_property.display()));
    if let Some(ref path) = stable_client_id {
        let _ = log_tx.send(format!("[runner] ClientId deviceinfo preserved: {}", path.display()));
    }

    Ok(DeviceInfoSources { property: stable_property, client_id: stable_client_id })
}

fn parse_retry_session_id(output: &str, result_dir_name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains(result_dir_name) {
            return None;
        }
        let session = trimmed.split_whitespace().next()?;
        if session.chars().all(|ch| ch.is_ascii_digit()) {
            Some(session.to_string())
        } else {
            None
        }
    })
}

fn run_tradefed_console_command(
    suite: &str,
    executable: &Path,
    console_command: &str,
    _log_file: &Path,
    _timeout_secs: u64,
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
        .args(console_command.split_whitespace())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {suite} console: {err}"))?;
    let pid = child.id();
    {
        let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
        map.insert(run_id.to_string(), pid);
    }
    let _ = log_tx.send(format!("[{suite}] console pid={pid} command={console_command}"));

    let output_str = if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = Vec::new();
        for line in reader.lines().flatten() {
            lines.push(line);
        }
        lines.join("\n")
    } else {
        String::new()
    };

    let _ = child.wait();
    {
        let mut map = ACTIVE_RUN_PIDS.lock().unwrap();
        map.remove(run_id);
    }

    Ok(output_str)
}

fn resolve_retry_session_id(
    suite: &str,
    executable: &Path,
    result_dir_name: &str,
    log_file: &Path,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
) -> Result<String, String> {
    let _ = log_tx.send(format!("[runner] {suite}: resolving retry session for {result_dir_name}"));
    let mut last_output = String::new();
    for attempt in 1..=5 {
        let output = run_tradefed_console_command(suite, executable, "l r", log_file, 45, run_id, log_tx)?;
        if let Some(session_id) = parse_retry_session_id(&output, result_dir_name) {
            let _ = log_tx.send(format!("[runner] {suite}: matched retry session {session_id} for {result_dir_name}"));
            return Ok(session_id);
        }
        last_output = output;
        let _ = log_tx.send(format!("[runner] {suite}: retry session not visible yet for {result_dir_name} (attempt {attempt}/5)."));
        std::thread::sleep(Duration::from_secs(1));
    }
    Err(format!(
        "{suite}: cannot find retry session for result directory {result_dir_name}. Last l r output had {} bytes.",
        last_output.len()
    ))
}

fn run_laundry_retries(
    root: &Path,
    _session_dir: &Path,
    log_dir: &Path,
    suite: &str,
    devices: &[String],
    source_results: &[PathBuf],
    replacement_deviceinfos: Option<&DeviceInfoSources>,
    timeout_secs: u64,
    _model: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<Vec<i32>, String> {
    let mut codes = Vec::new();
    for (index, source) in source_results.iter().enumerate() {
        let suite_root = suite_root_for_device(root, suite, devices)?;
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

        let timestamp = format!("{}_{}", timestamp_compact(), index);
        let target = results_dir.join(&timestamp);
        let _ = log_tx.send(format!("[runner] {suite}: staging result {} -> {}", source.display(), target.display()));
        copy_dir_recursive(source, &target)
            .map_err(|err| format!("Cannot stage {} to {}: {err}", source.display(), target.display()))?;
        cleanup_deviceinfo_backups(&target);

        if let Some(replacements) = replacement_deviceinfos {
            if let Some(target_info) = property_deviceinfo_in_result(&target) {
                let _ = fs::copy(&replacements.property, &target_info);
                let _ = log_tx.send(format!("[runner] {suite}: replaced {} (PropertyDeviceInfo)", target_info.display()));
            }
            if let (Some(client_src), Some(target_info)) = (&replacements.client_id, client_id_deviceinfo_in_result(&target)) {
                let _ = fs::copy(client_src, &target_info);
                let _ = log_tx.send(format!("[runner] {suite}: replaced {} (ClientIdDeviceInfo)", target_info.display()));
            }
            cleanup_deviceinfo_backups(&target);
        }

        let result_dir_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&timestamp);

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
        let _ = log_tx.send(format!("[runner] {suite}: retry session={session_id} result={}", target.display()));
        let log_file = log_dir.join(format!("laundry_retry_{}_{}_{}devs.log", suite.to_lowercase(), index + 1, devices.len()));

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
            status_tx,
        )?;
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
        if entry.file_name() == "test_result.xml" {
            let parent = entry.path().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| entry.path().to_path_buf());
            let path_str = parent.to_string_lossy().to_lowercase();
            if path_str.contains("gts") {
                gts.push(parent);
            } else if path_str.contains("sts") {
                sts.push(parent);
            } else {
                cts.push(parent);
            }
        }
    }
    (cts, gts, sts)
}

fn prepare_laundry_source(
    payload: &RunSuitePayload,
    session_dir: &Path,
    log_tx: &mpsc::UnboundedSender<String>,
) -> Result<LaundrySource, String> {
    let zip_str = payload
        .laundry_zip_path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{} requires laundry zip file", payload.test_type))?;

    let resolved = resolve_zip_path(zip_str)
        .ok_or_else(|| format!("Laundry zip file not found: {zip_str}"))?;

    let _ = log_tx.send(format!("[runner] Laundry zip selected: {}", resolved.display()));
    let temp = Arc::new(
        tempfile::Builder::new()
            .prefix("gba-laundry-")
            .tempdir_in(session_dir)
            .map_err(|err| format!("Cannot create laundry temp dir: {err}"))?,
    );

    let _ = log_tx.send(format!("[runner] Extracting zip to {}", temp.path().display()));
    let file = File::open(&resolved).map_err(|e| format!("Cannot open zip: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;
    archive.extract(temp.path()).map_err(|e| format!("Cannot extract zip: {e}"))?;

    let _ = log_tx.send("[runner] Extracting nested zip files...".to_string());
    let _ = extract_nested_zips(temp.path());

    let (mut cts_results, mut gts_results, mut sts_results) = scan_laundry_results(temp.path());
    let _ = log_tx.send(format!(
        "[runner] Scanned laundry results: CTS={} GTS={} STS={}",
        cts_results.len(),
        gts_results.len(),
        sts_results.len()
    ));

    // Filter by selected laundry results if specified
    if !payload.selected_laundry_results.is_empty() {
        let sel: HashSet<String> = payload.selected_laundry_results.iter().cloned().collect();
        let filter_fn = |p: &PathBuf| -> bool {
            let dirname = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            sel.iter().any(|s| s.contains(dirname) || dirname.contains(s))
        };
        cts_results.retain(filter_fn);
        gts_results.retain(filter_fn);
        sts_results.retain(filter_fn);
        let _ = log_tx.send(format!(
            "[runner] Filtered laundry results: CTS={} GTS={} STS={}",
            cts_results.len(),
            gts_results.len(),
            sts_results.len()
        ));
    }

    Ok(LaundrySource {
        _temp: temp.clone(),
        extract_root: temp.path().to_path_buf(),
        cts_results,
        gts_results,
        sts_results,
    })
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
    _pda: &str,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<i32, String> {
    let source = prepare_laundry_source(payload, session_dir, log_tx)?;
    let has_cts_or_gts = !source.cts_results.is_empty() || !source.gts_results.is_empty();
    let mut cts_gts_devices = payload.user_devices.clone();

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
        let _ = log_tx.send("[runner] Laundry (SMR): STS retry starts immediately on userdebug devices.".to_string());
        let root_sts = auto_root.to_path_buf();
        let session_sts = session_dir.to_path_buf();
        let log_sts = log_dir.to_path_buf();
        let devs_sts = payload.userdebug_devices.clone();
        let results_sts = source.sts_results.clone();
        let timeout_sts = payload.timeout_secs;
        let model_sts = model.to_string();
        let run_id_sts = run_id.to_string();
        let test_type_sts = payload.test_type.clone();
        let log_tx_sts = log_tx.clone();
        let stat_tx_sts = status_tx.clone();

        Some(std::thread::spawn(move || {
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
                &run_id_sts,
                &test_type_sts,
                &log_tx_sts,
                &stat_tx_sts,
            )
        }))
    } else {
        None
    };

    // 2. If CTS/GTS devices exist: Initial GTS for Property DeviceInfo -> CTS Retry -> GTS Retry
    if !cts_gts_devices.is_empty() && has_cts_or_gts {
        let _ = log_tx.send("[runner] Laundry (SMR): initial GTS gtsmr run.".to_string());
        let deviceinfo = run_laundry_initial_gts(
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
        )?;

        if !source.cts_results.is_empty() {
            let _ = log_tx.send(format!("[runner] CTS: {} result(s) queued for retry.", source.cts_results.len()));
            let cts_codes = run_laundry_retries(
                auto_root,
                session_dir,
                log_dir,
                "CTS",
                &cts_gts_devices,
                &source.cts_results,
                Some(&deviceinfo),
                payload.timeout_secs,
                model,
                run_id,
                &payload.test_type,
                log_tx,
                status_tx,
            )?;
            exit_codes.extend(cts_codes);
        }

        if !source.gts_results.is_empty() {
            let _ = log_tx.send(format!("[runner] GTS: {} result(s) queued for retry.", source.gts_results.len()));
            let gts_codes = run_laundry_retries(
                auto_root,
                session_dir,
                log_dir,
                "GTS",
                &cts_gts_devices,
                &source.gts_results,
                Some(&deviceinfo),
                payload.timeout_secs,
                model,
                run_id,
                &payload.test_type,
                log_tx,
                status_tx,
            )?;
            exit_codes.extend(gts_codes);
        }
    } else if !has_cts_or_gts {
        let _ = log_tx.send("[runner] Laundry (SMR): STS-only selected, skipping GTS property/gtsmr process.".to_string());
    }

    // 3. Await STS thread if running
    if let Some(handle) = sts_handle {
        match handle.join() {
            Ok(Ok(sts_codes)) => exit_codes.extend(sts_codes),
            Ok(Err(e)) => {
                let _ = log_tx.send(format!("[runner] STS retry error: {e}"));
                exit_codes.push(1);
            }
            Err(_) => exit_codes.push(1),
        }
    }

    Ok(if exit_codes.iter().all(|c| *c == 0) { 0 } else { 1 })
}

fn run_laundry_normal_flow(
    auto_root: &Path,
    session_dir: &Path,
    log_dir: &Path,
    payload: &RunSuitePayload,
    model: &str,
    _pda: &str,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<i32, String> {
    let mut all_devices = payload.user_devices.clone();
    for d in &payload.userdebug_devices {
        if !all_devices.contains(d) {
            all_devices.push(d.clone());
        }
    }
    let devices = if !all_devices.is_empty() { &all_devices } else { &payload.user_devices };
    let source = prepare_laundry_source(payload, session_dir, log_tx)?;

    let _ = log_tx.send("[runner] Laundry (Normal/SKU): initial GTS property run.".to_string());
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

    let mut exit_codes = Vec::new();
    if !source.cts_results.is_empty() {
        let _ = log_tx.send(format!("[runner] CTS: {} result(s) queued for retry.", source.cts_results.len()));
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
            run_id,
            &payload.test_type,
            log_tx,
            status_tx,
        )?;
        exit_codes.extend(cts_codes);
    }

    if !source.gts_results.is_empty() {
        let _ = log_tx.send(format!("[runner] GTS: {} result(s) queued for retry.", source.gts_results.len()));
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
            run_id,
            &payload.test_type,
            log_tx,
            status_tx,
        )?;
        exit_codes.extend(gts_codes);
    }

    Ok(if exit_codes.iter().all(|c| *c == 0) { 0 } else { 1 })
}

fn run_cts_then_gts_flow(
    auto_root: &Path,
    _session_dir: &Path,
    log_dir: &Path,
    devices: &[String],
    cts_subplan: &str,
    gts_command: &str,
    timeout_secs: u64,
    model: &str,
    _pda: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
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
    let _ = log_tx.send(format!("[runner] CTS: starting subplan {cts_subplan} on [{}]", devices.join(",")));

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
        status_tx,
    )?;

    if cts_code != 0 {
        let _ = log_tx.send("[gts] CTS returned non-zero; GTS will still be attempted.".to_string());
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
    let _ = log_tx.send(format!("[runner] GTS: starting command '{gts_command}' on [{}]", devices.join(",")));

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
        status_tx,
    )?;

    Ok(if cts_code == 0 && gts_code == 0 { 0 } else { 1 })
}

fn run_sts_flow(
    auto_root: &Path,
    _session_dir: &Path,
    log_dir: &Path,
    devices: &[String],
    timeout_secs: u64,
    model: &str,
    _pda: &str,
    run_id: &str,
    test_type: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<i32, String> {
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
    let _ = log_tx.send(format!("[runner] STS: starting {} on [{}]", sts_plan, devices.join(",")));

    run_suite_process(
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
        status_tx,
    )
}

fn run_generic_suite_flow(
    auto_root: &Path,
    _session_dir: &Path,
    log_dir: &Path,
    payload: &RunSuitePayload,
    run_id: &str,
    log_tx: &mpsc::UnboundedSender<String>,
    status_tx: &mpsc::UnboundedSender<(String, String, u64)>,
) -> Result<i32, String> {
    let serials = if !payload.user_devices.is_empty() {
        &payload.user_devices
    } else {
        &payload.userdebug_devices
    };

    let is_sts = payload.test_type.to_uppercase().contains("STS");
    let is_gts = payload.test_type.to_uppercase().contains("GTS");
    let suite_sub = if is_sts { "STS" } else if is_gts { "GTS" } else { "CTS" };

    let suite_root = suite_root_for_device(auto_root, suite_sub, serials)?;
    let suite_ws = suite_workspace(auto_root, &suite_root, run_id)?;
    let tradefed_name = if is_sts { "sts-tradefed" } else if is_gts { "gts-tradefed" } else { "cts-tradefed" };
    let exe = suite_ws.join("tools").join(tradefed_name);

    if !exe.is_file() {
        return Err(format!("Tradefed executable not found: {}", exe.display()));
    }

    let cmd = format!(
        "run {} --shard-count {}{}",
        suite_sub.to_lowercase(),
        serials.len(),
        serial_args(serials)
    );
    let log_file = log_dir.join(format!("{}_{}devs.log", suite_sub.to_lowercase(), serials.len()));

    run_suite_process(
        suite_sub,
        serials,
        &exe,
        &cmd,
        true,
        &log_file,
        payload.timeout_secs,
        run_id,
        &payload.test_type,
        log_tx,
        status_tx,
    )
}
