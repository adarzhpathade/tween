use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub gpu_usage: Option<f64>,
    pub gpu_memory_used: Option<u64>,
    pub gpu_memory_total: Option<u64>,
    pub gpu_temperature: Option<f64>,
    pub cpu_usage: Option<f64>,
    pub cpu_threads: Option<usize>,
    pub ram_used: Option<u64>,
    pub ram_total: Option<u64>,
}

pub struct SystemMonitorState(pub Arc<Mutex<sysinfo::System>>);

impl Default for SystemMonitorState {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemMonitorState {
    pub fn new() -> Self {
        let mut sys = sysinfo::System::new_all().expect("failed to init sysinfo");
        sys.refresh_cpu_all();
        sys.refresh_memory();
        Self(Arc::new(Mutex::new(sys)))
    }

    pub async fn sample(&self) -> SystemStats {
        let (cpu_usage, cpu_threads, ram_used, ram_total) = {
            let mut sys = self.0.lock().await;
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let cpu = sys.global_cpu_usage() as f64;
            let threads = sys.cpus().len();
            let used = sys.used_memory();
            let total = sys.total_memory();
            (Some(cpu), Some(threads), Some(used), Some(total))
        };

        let (gpu_usage, gpu_mem_used, gpu_mem_total, gpu_temp) = sample_gpu().await;

        SystemStats {
            gpu_usage,
            gpu_memory_used: gpu_mem_used,
            gpu_memory_total: gpu_mem_total,
            gpu_temperature: gpu_temp,
            cpu_usage,
            cpu_threads,
            ram_used,
            ram_total,
        }
    }
}

async fn sample_gpu() -> (Option<f64>, Option<u64>, Option<u64>, Option<f64>) {
    // 1. Try nvidia-smi
    if let Some((u, mu, mt, t)) = sample_nvidia_smi().await {
        return (Some(u), Some(mu), Some(mt), Some(t));
    }

    // 2. Fallback on Windows via PowerShell Get-Counter
    #[cfg(windows)]
    if let Some(u) = sample_windows_counter().await {
        return (Some(u), None, None, None);
    }

    (None, None, None, None)
}

async fn sample_nvidia_smi() -> Option<(f64, u64, u64, f64)> {
    tokio::task::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("nvidia-smi");
        cmd.args([
            "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let first_line = text.lines().next()?;
        let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 4 {
            return None;
        }
        let util = parts[0].parse::<f64>().ok()?;
        let mem_used_mb = parts[1].parse::<f64>().ok()?;
        let mem_total_mb = parts[2].parse::<f64>().ok()?;
        let temp = parts[3].parse::<f64>().ok()?;
        let mem_used_bytes = (mem_used_mb * 1024.0 * 1024.0) as u64;
        let mem_total_bytes = (mem_total_mb * 1024.0 * 1024.0) as u64;
        Some((util, mem_used_bytes, mem_total_bytes, temp))
    })
    .await
    .ok()?
}

#[cfg(windows)]
async fn sample_windows_counter() -> Option<f64> {
    tokio::task::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"(Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object CookedValue -gt 0 | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"#,
        ]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let val = trimmed.parse::<f64>().ok()?;
        Some(val.min(100.0))
    })
    .await
    .ok()?
}

#[tauri::command]
pub async fn sample_system_stats(
    state: tauri::State<'_, SystemMonitorState>,
) -> Result<SystemStats, String> {
    Ok(state.sample().await)
}

#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_file() {
            cmd.arg(format!("/select,{}", p.display()));
        } else if p.is_dir() {
            cmd.arg(p.display().to_string());
        } else if let Some(parent) = p.parent() {
            if parent.exists() {
                cmd.arg(parent.display().to_string());
            } else {
                cmd.arg(&path);
            }
        } else {
            cmd.arg(&path);
        }
        cmd.creation_flags(0x08000000);
        let _ = cmd.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if p.is_file() {
            cmd.args(["-R", &p.display().to_string()]);
        } else if p.is_dir() {
            cmd.arg(p.display().to_string());
        } else if let Some(parent) = p.parent() {
            cmd.arg(parent.display().to_string());
        } else {
            cmd.arg(&path);
        }
        let _ = cmd.spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        if p.is_file() {
            cmd.arg(p.parent().unwrap_or(p).display().to_string());
        } else {
            cmd.arg(p.display().to_string());
        }
        let _ = cmd.spawn();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_system_stats_sampling() {
        let monitor = SystemMonitorState::new();
        let stats = monitor.sample().await;
        // CPU threads should be positive
        assert!(stats.cpu_threads.unwrap_or(0) > 0);
        // Total RAM should be positive
        assert!(stats.ram_total.unwrap_or(0) > 0);
        // Stats can serialize to JSON
        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("ramTotal"));
    }
}
