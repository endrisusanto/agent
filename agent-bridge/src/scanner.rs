use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;
use crate::types::{BusyRegistry, DeviceInfo, LaundryZipItem};

pub fn scan_all_devices(auto_root: &Path) -> Vec<DeviceInfo> {
    let output = match Command::new("adb").arg("devices").arg("-l").output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => return Vec::new(),
    };

    let busy_registry = read_busy_registry(auto_root);
    let mut devices = Vec::new();

    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() || line.starts_with('*') {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        let serial = parts[0].to_string();
        let state = parts.get(1).unwrap_or(&"offline").to_string();

        let mut model = String::new();
        for part in &parts[2..] {
            if let Some(m) = part.strip_prefix("model:") {
                model = m.to_string();
            }
        }

        let mut is_userdebug = false;
        let mut fingerprint = String::new();
        let mut security_patch = String::new();
        let mut android = String::new();
        let mut sdk = String::new();
        let mut sales_code = String::new();
        let mut pda = String::new();
        let mut cp = String::new();
        let mut csc = String::new();
        let mut ip = String::new();

        if state == "device" {
            if let Ok(props) = device_props(&serial) {
                let build_type = props.get("ro.build.type").cloned().unwrap_or_default();
                is_userdebug = build_type.eq_ignore_ascii_case("userdebug") || build_type.eq_ignore_ascii_case("eng");
                fingerprint = props.get("ro.build.fingerprint").cloned().unwrap_or_default();
                security_patch = props.get("ro.build.version.security_patch").cloned().unwrap_or_default();
                android = props.get("ro.build.version.release").cloned().unwrap_or_default();
                sdk = props.get("ro.build.version.sdk").cloned().unwrap_or_default();
                sales_code = props.get("ro.csc.sales_code").cloned().unwrap_or_default();
                pda = props.get("ro.boot.bootloader").cloned().unwrap_or_else(|| {
                    props.get("ro.build.display.id").cloned().unwrap_or_default()
                });
                cp = props.get("gsm.version.baseband").cloned().unwrap_or_default();
                csc = props.get("ro.boot.carrierid").cloned().unwrap_or_default();
                if model.is_empty() {
                    model = props.get("ro.product.model").cloned().unwrap_or_default();
                }
            }
            ip = device_ip(&serial).unwrap_or_else(|_| "USB".to_string());
        }

        let busy_info = busy_registry.devices.get(&serial);
        let busy = busy_info.is_some();
        let busy_reason = busy_info
            .map(|b| b.current_suite.clone().unwrap_or_else(|| b.test_type.clone()))
            .unwrap_or_default();
        let run_id = busy_info.map(|b| b.run_id.clone());
        let result_dir = busy_info.and_then(|b| b.result_dir.clone());

        devices.push(DeviceInfo {
            serial,
            state,
            is_userdebug,
            fingerprint,
            security_patch,
            android,
            sdk,
            sales_code,
            model,
            pda,
            cp,
            csc,
            ip,
            busy,
            busy_reason,
            run_id,
            result_dir,
        });
    }

    devices
}

fn extract_model_from_filename(filename: &str) -> Option<String> {
    let base = filename.strip_suffix(".zip").unwrap_or(filename);
    let first_token = base.split('_').next().unwrap_or(base);

    if first_token.starts_with("SM-") || first_token.starts_with("sm-") {
        return Some(first_token.to_uppercase());
    }

    let mut model_part = String::new();
    for ch in first_token.chars() {
        if ch.is_ascii_alphanumeric() {
            model_part.push(ch);
            if model_part.len() >= 5 && (model_part.ends_with('F') || model_part.ends_with('B') || model_part.ends_with('G') || model_part.ends_with('E') || model_part.ends_with('P') || model_part.ends_with('N') || model_part.ends_with('U') || model_part.ends_with('W')) {
                break;
            }
        } else {
            break;
        }
    }

    if !model_part.is_empty() && model_part.len() >= 4 {
        if model_part.starts_with('A') || model_part.starts_with('S') || model_part.starts_with('F') || model_part.starts_with('M') || model_part.starts_with('X') || model_part.starts_with('T') {
            return Some(format!("SM-{}", model_part.to_uppercase()));
        }
        return Some(model_part.to_uppercase());
    }

    None
}

pub fn scan_laundry_zips(auto_root: &Path) -> Vec<LaundryZipItem> {
    let mut dirs_to_scan = Vec::new();

    // 1. Custom environment variable
    if let Ok(cucian_env) = std::env::var("CUCIAN_DIR") {
        let p = std::path::PathBuf::from(cucian_env);
        if p.is_dir() && !dirs_to_scan.contains(&p) {
            dirs_to_scan.push(p);
        }
    }

    // 2. User HOME Downloads/CUCIAN
    if let Ok(home) = std::env::var("HOME") {
        let home_cucian = std::path::PathBuf::from(home).join("Downloads").join("CUCIAN");
        if home_cucian.is_dir() && !dirs_to_scan.contains(&home_cucian) {
            dirs_to_scan.push(home_cucian);
        }
    }

    // 3. Scan all user directories in /home
    if let Ok(entries) = fs::read_dir("/home") {
        for entry in entries.flatten() {
            let u_cucian = entry.path().join("Downloads").join("CUCIAN");
            if u_cucian.is_dir() && !dirs_to_scan.contains(&u_cucian) {
                dirs_to_scan.push(u_cucian);
            }
        }
    }

    // 4. Specific known paths & root/container mounts
    for candidate in &["/home/endri-pro/Downloads/CUCIAN", "/cucian", "/tmp/CUCIAN"] {
        let p = std::path::PathBuf::from(candidate);
        if p.is_dir() && !dirs_to_scan.contains(&p) {
            dirs_to_scan.push(p);
        }
    }

    // 5. AUTO root paths
    let results_dir = auto_root.join("Results");
    if results_dir.is_dir() && !dirs_to_scan.contains(&results_dir) {
        dirs_to_scan.push(results_dir);
    }
    let auto_cucian = auto_root.join("CUCIAN");
    if auto_cucian.is_dir() && !dirs_to_scan.contains(&auto_cucian) {
        dirs_to_scan.push(auto_cucian);
    }

    let mut zips = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    for dir in dirs_to_scan {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("zip") {
                    let path_str = path.to_string_lossy().to_string();
                    if seen_paths.contains(&path_str) {
                        continue;
                    }
                    seen_paths.insert(path_str.clone());

                    let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let meta = entry.metadata().ok();
                    let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                    let modified_at = meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    let model = extract_model_from_filename(&filename);

                    zips.push(LaundryZipItem {
                        filename,
                        path: path_str,
                        size_bytes,
                        modified_at,
                        model,
                    });
                }
            }
        }
    }

    // Sort descending by modification date
    zips.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    zips
}

pub fn set_device_lamp(serial: &str, brighten: bool) -> Result<(), String> {
    if brighten {
        let _ = Command::new("adb")
            .args(["-s", serial, "shell", "input", "keyevent", "26"])
            .status();
        let _ = Command::new("adb")
            .args(["-s", serial, "shell", "settings", "put", "system", "screen_brightness", "255"])
            .status();
    } else {
        let _ = Command::new("adb")
            .args(["-s", serial, "shell", "settings", "put", "system", "screen_brightness", "50"])
            .status();
    }
    Ok(())
}

fn device_props(serial: &str) -> Result<HashMap<String, String>, String> {
    let output = Command::new("adb")
        .args(["-s", serial, "shell", "getprop"])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut props = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = parse_getprop_line(line) {
            props.insert(k, v);
        }
    }
    Ok(props)
}

fn parse_getprop_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let parts: Vec<&str> = trimmed.split("]: [").collect();
    if parts.len() == 2 {
        let key = parts[0].trim_start_matches('[').trim().to_string();
        let val = parts[1].trim_end_matches(']').trim().to_string();
        Some((key, val))
    } else {
        None
    }
}

fn device_ip(serial: &str) -> Result<String, String> {
    let output = Command::new("adb")
        .args(["-s", serial, "shell", "ip", "route"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("src ") {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if let Some(pos) = tokens.iter().position(|&t| t == "src") {
                if let Some(ip) = tokens.get(pos + 1) {
                    return Ok(ip.to_string());
                }
            }
        }
    }
    Ok("USB".to_string())
}

pub fn read_busy_registry(root: &Path) -> BusyRegistry {
    let path = root.join("busy.json");
    if let Ok(data) = fs::read_to_string(path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        BusyRegistry::default()
    }
}

pub fn write_busy_registry(root: &Path, registry: &BusyRegistry) -> Result<(), String> {
    let path = root.join("busy.json");
    let json = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
