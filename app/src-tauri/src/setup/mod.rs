//! Ports `src/lib/setup.js`.
//! First-run setup: find or install FFmpeg and the RIFE engine, check the GPU,
//! pick the best encoder, and save the result.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
pub const PLATFORM: &str = "win32";
#[cfg(target_os = "macos")]
pub const PLATFORM: &str = "darwin";
#[cfg(target_os = "linux")]
pub const PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub const PLATFORM: &str = "unknown";

#[cfg(target_arch = "x86_64")]
pub const ARCH: &str = "x64";
#[cfg(target_arch = "aarch64")]
pub const ARCH: &str = "arm64";
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub const ARCH: &str = "unknown";

pub fn system_arch() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        {
            return "arm64";
        }
        #[cfg(target_arch = "x86_64")]
        {
            let mut translated: i32 = 0;
            let mut size = std::mem::size_of::<i32>();
            let name = b"sysctl.proc_translated\0";
            let ret = unsafe {
                libc::sysctlbyname(
                    name.as_ptr() as *const libc::c_char,
                    &mut translated as *mut _ as *mut libc::c_void,
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if ret == 0 && translated == 1 {
                return "arm64";
            }
            return "x64";
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ARCH
    }
}

pub const RIFE_TAG: &str = "20250112";

pub fn rife_zip() -> &'static str {
    match PLATFORM {
        "win32" => "windows",
        "linux" => "ubuntu",
        "darwin" => "macos",
        _ => "windows",
    }
}

pub fn rife_url() -> String {
    format!(
        "https://github.com/TNTwise/rife-ncnn-vulkan/releases/download/{}/{}.zip",
        RIFE_TAG,
        rife_zip()
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub size: f64,
    pub default: bool,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "rife-v4.26",
        name: "Smooth",
        desc: "Newest RIFE model. The best choice for most videos.",
        size: 11.4,
        default: true,
    },
    ModelInfo {
        id: "rife-v4.25-heavy",
        name: "Detail",
        desc: "Bigger model. Cleaner edges in fast motion, about 2 to 3 times slower.",
        size: 43.4,
        default: false,
    },
    ModelInfo {
        id: "rife-v4.22-lite",
        name: "Fast",
        desc: "Light model for older or integrated GPUs.",
        size: 9.8,
        default: false,
    },
];

pub const ENCODER_ORDER: &[&str] = &[
    "hevc_nvenc",
    "h264_nvenc",
    "hevc_amf",
    "h264_amf",
    "hevc_qsv",
    "h264_qsv",
    "hevc_videotoolbox",
    "h264_videotoolbox",
    "libx265",
    "libx264",
];

pub fn driver_link_for_vendor(vendor: &str) -> Option<&'static str> {
    match vendor {
        "nvidia" => Some("https://www.nvidia.com/Download/index.aspx"),
        "amd" => Some("https://www.amd.com/en/support/download/drivers.html"),
        "intel" => Some("https://www.intel.com/content/www/us/en/support/detect.html"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OsGpu {
    pub name: String,
    pub driver: Option<String>,
    pub vendor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GpuDevice {
    pub id: i32,
    pub name: String,
    pub vendor: String,
    pub integrated: bool,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupConfig {
    pub platform: String,
    pub arch: String,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    pub os_gpus: Vec<OsGpu>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffprobe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rife_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devices: Option<Vec<GpuDevice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoders: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths_exist: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProgressEvent {
    pub id: String,
    pub label: String,
    pub state: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SetupResult {
    pub ok: bool,
    pub cfg: SetupConfig,
}

#[derive(Debug, Clone)]
pub struct SetupPaths {
    pub base: PathBuf,
    pub config: PathBuf,
    pub ff_dir: PathBuf,
    pub rife_dir: PathBuf,
}

pub fn paths(base_dir: &Path) -> SetupPaths {
    let engine = base_dir.join("engine");
    SetupPaths {
        base: base_dir.to_path_buf(),
        config: base_dir.join("setup.json"),
        ff_dir: engine.join("ffmpeg"),
        rife_dir: engine.join("rife"),
    }
}

pub fn load_config(base_dir: &Path) -> Option<SetupConfig> {
    let p = paths(base_dir);
    let data = std::fs::read_to_string(&p.config).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save_config(base_dir: &Path, cfg: &SetupConfig) -> Result<(), std::io::Error> {
    let p = paths(base_dir);
    std::fs::create_dir_all(base_dir)?;
    let json = serde_json::to_string_pretty(cfg)
        .map_err(std::io::Error::other)?;
    std::fs::write(&p.config, json)?;
    Ok(())
}

pub fn rife_exe(dir: &Path) -> PathBuf {
    let exe = if PLATFORM == "win32" {
        "rife-ncnn-vulkan.exe"
    } else {
        "rife-ncnn-vulkan"
    };
    dir.join(exe)
}

pub fn installed_models(dir: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .filter(|m| {
            dir.join(m.id).join("flownet.bin").exists()
                && dir.join(m.id).join("flownet.param").exists()
        })
        .cloned()
        .collect()
}

pub fn vendor_of(name: &str) -> &'static str {
    static NVIDIA_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)nvidia|geforce|quadro|rtx|gtx").unwrap());
    static AMD_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)amd|radeon|ati ").unwrap());
    static INTEL_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)intel|arc|iris|uhd graphics").unwrap());
    static APPLE_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)apple|m\d").unwrap());

    if NVIDIA_RE.is_match(name) {
        "nvidia"
    } else if AMD_RE.is_match(name) {
        "amd"
    } else if INTEL_RE.is_match(name) {
        "intel"
    } else if APPLE_RE.is_match(name) {
        "apple"
    } else {
        "other"
    }
}

pub fn is_integrated_gpu(name: &str) -> bool {
    // Discrete Intel Arc GPUs (e.g. Arc(TM) A770, Arc A750, Arc A580, Arc A380, Arc B580, etc.)
    static DISCRETE_INTEL_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)arc(?:\(tm\))?\s+[a-z]?\d{3}").unwrap()
    });
    if DISCRETE_INTEL_RE.is_match(name) {
        return false;
    }

    static INTEGRATED_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)uhd|iris|hd graphics|vega \d|radeon\(tm\) graphics|llvmpipe|swiftshader")
            .unwrap()
    });
    static INTEL_GENERIC_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)intel(?:\(r\))?\s+(?:hd|uhd|iris|graphics)").unwrap()
    });

    INTEGRATED_RE.is_match(name) || INTEL_GENERIC_RE.is_match(name)
}

pub fn select_best_gpu(results: &[GpuDevice]) -> Option<GpuDevice> {
    let mut usable: Vec<GpuDevice> = results.iter().filter(|d| d.ok).cloned().collect();
    // Dedicated GPU first (integrated == false), then fastest (lowest ms)
    usable.sort_by(|x, y| {
        x.integrated
            .cmp(&y.integrated)
            .then_with(|| x.ms.cmp(&y.ms))
    });
    usable.first().cloned()
}

pub fn encoder_order_for_vendor(vendor: Option<&str>) -> Vec<&'static str> {
    match vendor {
        Some("amd") => vec![
            "hevc_amf",
            "h264_amf",
            "hevc_nvenc",
            "h264_nvenc",
            "hevc_qsv",
            "h264_qsv",
            "hevc_videotoolbox",
            "h264_videotoolbox",
            "libx265",
            "libx264",
        ],
        Some("intel") => vec![
            "hevc_qsv",
            "h264_qsv",
            "hevc_nvenc",
            "h264_nvenc",
            "hevc_amf",
            "h264_amf",
            "hevc_videotoolbox",
            "h264_videotoolbox",
            "libx265",
            "libx264",
        ],
        Some("nvidia") => vec![
            "hevc_nvenc",
            "h264_nvenc",
            "hevc_amf",
            "h264_amf",
            "hevc_qsv",
            "h264_qsv",
            "hevc_videotoolbox",
            "h264_videotoolbox",
            "libx265",
            "libx264",
        ],
        Some("apple") => vec![
            "hevc_videotoolbox",
            "h264_videotoolbox",
            "libx265",
            "libx264",
        ],
        _ => ENCODER_ORDER.to_vec(),
    }
}

pub fn parse_vulkan_devices(stderr: &str) -> Vec<GpuDevice> {
    static DEV_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)^\[(\d+)\s+(.+?)\]\s+queueC=").unwrap());

    let mut seen: Vec<(i32, String)> = Vec::new();
    for cap in DEV_RE.captures_iter(stderr) {
        if let (Some(id_m), Some(name_m)) = (cap.get(1), cap.get(2)) {
            if let Ok(id) = id_m.as_str().parse::<i32>() {
                let name = name_m.as_str().trim().to_string();
                if let Some(pos) = seen.iter().position(|(i, _)| *i == id) {
                    seen[pos].1 = name;
                } else {
                    seen.push((id, name));
                }
            }
        }
    }

    seen.into_iter()
        .map(|(id, name)| {
            let vendor = vendor_of(&name).to_string();
            let integrated = is_integrated_gpu(&name);
            GpuDevice {
                id,
                name,
                vendor,
                integrated,
                ok: false,
                ms: 0,
            }
        })
        .collect()
}

pub fn vulkan_loader_present() -> bool {
    #[cfg(windows)]
    {
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        Path::new(&sys_root)
            .join("System32")
            .join("vulkan-1.dll")
            .exists()
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        [
            "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
            "/usr/lib64/libvulkan.so.1",
            "/usr/lib/libvulkan.so.1",
            "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
        ]
        .iter()
        .any(|p| Path::new(p).exists())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[cfg(windows)]
pub fn free_disk_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free_bytes_available: u64 = 0;
    let mut total_number_of_bytes: u64 = 0;
    let mut total_number_of_free_bytes: u64 = 0;
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }
    let ret = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_bytes_available,
            &mut total_number_of_bytes,
            &mut total_number_of_free_bytes,
        )
    };
    if ret != 0 {
        Some(free_bytes_available)
    } else {
        None
    }
}

#[cfg(unix)]
pub fn free_disk_space(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_str = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(c_str.as_ptr(), &mut stat) };
    if ret == 0 {
        Some((stat.f_bavail as u64) * (stat.f_frsize as u64))
    } else {
        None
    }
}

#[cfg(not(any(windows, unix)))]
pub fn free_disk_space(_dir: &Path) -> Option<u64> {
    None
}

#[cfg(windows)]
pub fn total_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    extern "system" {
        fn GlobalMemoryStatusEx(lpBuffer: *mut MemoryStatusEx) -> i32;
    }
    unsafe {
        let mut status: MemoryStatusEx = std::mem::zeroed();
        status.dw_length = std::mem::size_of::<MemoryStatusEx>() as u32;
        if GlobalMemoryStatusEx(&mut status) != 0 {
            Some(status.ull_total_phys)
        } else {
            None
        }
    }
}

#[cfg(target_os = "macos")]
pub fn total_memory() -> Option<u64> {
    let mut mib = [libc::CTL_HW, libc::HW_MEMSIZE];
    let mut mem: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let ret = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            &mut mem as *mut _ as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret == 0 {
        Some(mem)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
pub fn total_memory() -> Option<u64> {
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages > 0 && page_size > 0 {
        Some((pages as u64) * (page_size as u64))
    } else {
        None
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn total_memory() -> Option<u64> {
    None
}

#[cfg(windows)]
pub async fn os_gpus() -> Vec<OsGpu> {
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = cmd.output().await;
    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let json: serde_json::Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let items = match json {
        serde_json::Value::Array(arr) => arr,
        serde_json::Value::Object(_) => vec![json],
        _ => Vec::new(),
    };

    let filter_re = regex::Regex::new(r"(?i)basic display|remote|virtual|parsec|meta").unwrap();

    let mut result = Vec::new();
    for item in items {
        if let Some(name_val) = item.get("Name").and_then(|v| v.as_str()) {
            let name = name_val.trim();
            if name.is_empty() || filter_re.is_match(name) {
                continue;
            }
            let driver = item
                .get("DriverVersion")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string());
            let vendor = vendor_of(name).to_string();
            result.push(OsGpu {
                name: name.to_string(),
                driver,
                vendor,
            });
        }
    }
    result
}

#[cfg(target_os = "macos")]
pub async fn os_gpus() -> Vec<OsGpu> {
    let output = tokio::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .await;

    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    };

    let mut result = Vec::new();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
        if let Some(displays) = json.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
            for d in displays {
                let name_opt = d
                    .get("sppci_model")
                    .or_else(|| d.get("_name"))
                    .and_then(|v| v.as_str());
                if let Some(name) = name_opt {
                    result.push(OsGpu {
                        name: name.trim().to_string(),
                        driver: None,
                        vendor: vendor_of(name).to_string(),
                    });
                }
            }
        }
    }

    if result.is_empty() {
        // Fallback 1: ioreg query for display / GPU devices
        let ioreg_out = tokio::process::Command::new("ioreg")
            .args(["-rc", "IOPCIDevice", "-k", "model"])
            .output()
            .await;
        if let Ok(o) = ioreg_out {
            let out_str = String::from_utf8_lossy(&o.stdout);
            static IOREG_MODEL_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r#""model"\s*=\s*<"([^"]+)">"#).unwrap()
            });
            for cap in IOREG_MODEL_RE.captures_iter(&out_str) {
                if let Some(m) = cap.get(1) {
                    let name = m.as_str().trim();
                    if !name.is_empty() {
                        result.push(OsGpu {
                            name: name.to_string(),
                            driver: None,
                            vendor: vendor_of(name).to_string(),
                        });
                    }
                }
            }
        }

        // Fallback 2: Apple Silicon brand name from sysctl
        if result.is_empty() {
            let sysctl_out = tokio::process::Command::new("sysctl")
                .args(["-n", "machdep.cpu.brand_string"])
                .output()
                .await;
            if let Ok(o) = sysctl_out {
                let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if name.to_lowercase().contains("apple") {
                    result.push(OsGpu {
                        name: format!("{name} GPU"),
                        driver: None,
                        vendor: "apple".to_string(),
                    });
                }
            }
        }
    }

    result
}

#[cfg(target_os = "linux")]
pub async fn os_gpus() -> Vec<OsGpu> {
    let output = tokio::process::Command::new("sh")
        .args(["-c", "lspci 2>/dev/null | grep -Ei \"vga|3d|display\""])
        .output()
        .await;

    let mut result = Vec::new();
    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let name = if let Some(idx) = trimmed.find(": ") {
                &trimmed[idx + 2..]
            } else {
                trimmed
            };
            result.push(OsGpu {
                name: name.to_string(),
                driver: None,
                vendor: vendor_of(name).to_string(),
            });
        }
    }

    if result.is_empty() {
        // Fallback 1: check NVIDIA driver info in /proc/driver/nvidia/gpus
        if let Ok(entries) = std::fs::read_dir("/proc/driver/nvidia/gpus") {
            for entry in entries.flatten() {
                let info_file = entry.path().join("information");
                if let Ok(content) = std::fs::read_to_string(info_file) {
                    for line in content.lines() {
                        if line.starts_with("Model:") {
                            let model = line.trim_start_matches("Model:").trim();
                            if !model.is_empty() {
                                result.push(OsGpu {
                                    name: model.to_string(),
                                    driver: Some("nvidia".to_string()),
                                    vendor: "nvidia".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }

        // Fallback 2: /sys/bus/pci/devices checking PCI class 0x03xxxx (Display controllers)
        if result.is_empty() {
            if let Ok(entries) = std::fs::read_dir("/sys/bus/pci/devices") {
                for entry in entries.flatten() {
                    let dev_path = entry.path();
                    let class_str = std::fs::read_to_string(dev_path.join("class")).unwrap_or_default();
                    let class_trimmed = class_str.trim();
                    // Class 0x03xxxx: 0300=VGA, 0301=XGA, 0302=3D controller, 0380=Other display
                    if class_trimmed.starts_with("0x03") {
                        let vendor_id = std::fs::read_to_string(dev_path.join("vendor")).unwrap_or_default();
                        let vendor_trimmed = vendor_id.trim().to_lowercase();
                        let vendor = match vendor_trimmed.as_str() {
                            "0x10de" => "nvidia",
                            "0x1002" => "amd",
                            "0x8086" => "intel",
                            _ => "other",
                        };
                        let name = match vendor {
                            "nvidia" => "NVIDIA Display Controller",
                            "amd" => "AMD Radeon Display Controller",
                            "intel" => "Intel Display Controller",
                            _ => "Display Controller",
                        };
                        let driver_link = std::fs::read_link(dev_path.join("driver")).ok();
                        let driver = driver_link
                            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
                        result.push(OsGpu {
                            name: name.to_string(),
                            driver,
                            vendor: vendor.to_string(),
                        });
                    }
                }
            }
        }
    }

    result
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub async fn os_gpus() -> Vec<OsGpu> {
    Vec::new()
}

enum FfmpegSource {
    Zip {
        url: String,
        files: Vec<String>,
    },
    Zips {
        urls: Vec<String>,
        files: Vec<String>,
    },
    TarXz {
        url: String,
        files: Vec<String>,
    },
}

fn ffmpeg_source() -> FfmpegSource {
    let arch = system_arch();
    let b = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
    if PLATFORM == "win32" {
        let file_name = if arch == "arm64" {
            "ffmpeg-master-latest-winarm64-gpl.zip"
        } else {
            "ffmpeg-master-latest-win64-gpl.zip"
        };
        FfmpegSource::Zip {
            url: format!("{b}{file_name}"),
            files: vec!["bin/ffmpeg.exe".to_string(), "bin/ffprobe.exe".to_string()],
        }
    } else if PLATFORM == "linux" {
        let file_name = if arch == "arm64" {
            "ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
        } else {
            "ffmpeg-master-latest-linux64-gpl.tar.xz"
        };
        FfmpegSource::TarXz {
            url: format!("{b}{file_name}"),
            files: vec!["bin/ffmpeg".to_string(), "bin/ffprobe".to_string()],
        }
    } else {
        let a = if arch == "arm64" { "arm64" } else { "amd64" };
        let urls = vec![
            format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{a}/release/ffmpeg.zip"),
            format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{a}/release/ffprobe.zip"),
        ];
        FfmpegSource::Zips {
            urls,
            files: vec!["ffmpeg".to_string(), "ffprobe".to_string()],
        }
    }
}

pub async fn install_ffmpeg<F>(p: &SetupPaths, mut on_bytes: F) -> Result<(), String>
where
    F: FnMut(u64, u64),
{
    let s = ffmpeg_source();
    tokio::fs::create_dir_all(&p.ff_dir)
        .await
        .map_err(|e| format!("Failed to create ff_dir: {e}"))?;

    match s {
        FfmpegSource::Zip { url, files } => {
            let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
            crate::remotezip::fetch_from_zip(&url, &file_refs, &p.ff_dir, on_bytes).await?;
        }
        FfmpegSource::Zips { urls, files } => {
            for (i, url) in urls.iter().enumerate() {
                let file_ref = [files[i].as_str()];
                crate::remotezip::fetch_from_zip(
                    url,
                    &file_ref,
                    &p.ff_dir,
                    |g, t| on_bytes(g + (i as u64) * t, t * 2),
                )
                .await?;
            }
        }
        FfmpegSource::TarXz { url, files } => {
            let tarball = p.ff_dir.join("ffmpeg.tar.xz");
            crate::remotezip::download_file(&url, &tarball, on_bytes).await?;
            let mut cmd = tokio::process::Command::new("tar");
            let mut args = vec![
                "-xJf".to_string(),
                tarball.to_string_lossy().to_string(),
                "-C".to_string(),
                p.ff_dir.to_string_lossy().to_string(),
                "--strip-components=2".to_string(),
                "--wildcards".to_string(),
            ];
            for f in files {
                args.push(format!("*/{f}"));
            }
            cmd.args(&args);
            let output = cmd.output().await.map_err(|e| format!("Failed to run tar: {e}"))?;
            let _ = tokio::fs::remove_file(&tarball).await;
            if !output.status.success() {
                return Err(format!(
                    "Could not unpack FFmpeg: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for f in &["ffmpeg", "ffprobe"] {
            let target = p.ff_dir.join(f);
            if target.exists() {
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("xattr")
            .args(["-dr", "com.apple.quarantine", p.ff_dir.to_str().unwrap_or(".")])
            .output()
            .await;
    }

    Ok(())
}

pub async fn install_rife<F>(
    p: &SetupPaths,
    model_ids: &[String],
    on_bytes: F,
) -> Result<(), String>
where
    F: FnMut(u64, u64),
{
    let mut want: Vec<String> = vec![
        if PLATFORM == "win32" {
            "rife-ncnn-vulkan.exe".to_string()
        } else {
            "rife-ncnn-vulkan".to_string()
        },
    ];
    if PLATFORM == "win32" {
        want.push("vcomp140.dll".to_string());
    }
    want.push("LICENSE".to_string());
    for m in model_ids {
        want.push(format!("{m}/"));
    }

    let want_refs: Vec<&str> = want.iter().map(|s| s.as_str()).collect();
    crate::remotezip::fetch_from_zip(&rife_url(), &want_refs, &p.rife_dir, on_bytes).await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let exe = rife_exe(&p.rife_dir);
        if exe.exists() {
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("xattr")
            .args(["-dr", "com.apple.quarantine", p.rife_dir.to_str().unwrap_or(".")])
            .output()
            .await;
    }

    Ok(())
}

#[derive(Debug, Clone)]
pub struct FfmpegInfo {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub version: String,
    pub bundled: bool,
}

pub async fn find_ffmpeg(p: &SetupPaths) -> Option<FfmpegInfo> {
    let exe_suffix = if PLATFORM == "win32" { ".exe" } else { "" };
    let own_ffmpeg = p.ff_dir.join(format!("ffmpeg{exe_suffix}"));
    let own_ffprobe = p.ff_dir.join(format!("ffprobe{exe_suffix}"));

    let candidates = [
        (
            own_ffmpeg.to_string_lossy().to_string(),
            own_ffprobe.to_string_lossy().to_string(),
            true,
        ),
        ("ffmpeg".to_string(), "ffprobe".to_string(), false),
    ];

    let version_re = regex::Regex::new(r"ffmpeg version (\S+)").ok()?;
    let scdet_re = regex::Regex::new(r"\bscdet\b").ok()?;

    for (ffmpeg, ffprobe, bundled) in candidates {
        if bundled
            && (!Path::new(&ffmpeg).exists() || !Path::new(&ffprobe).exists())
        {
            continue;
        }

        let run_cmd = |prog: &str, args: &[&str]| {
            let mut cmd = tokio::process::Command::new(prog);
            cmd.args(args);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            async move {
                tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await
            }
        };

        let a = match run_cmd(&ffmpeg, &["-hide_banner", "-version"]).await {
            Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => continue,
        };
        let b = match run_cmd(&ffprobe, &["-hide_banner", "-version"]).await {
            Ok(Ok(o)) if o.status.success() => o.status.success(),
            _ => continue,
        };
        if !b {
            continue;
        }

        let f = match run_cmd(&ffmpeg, &["-hide_banner", "-filters"]).await {
            Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => continue,
        };

        if !scdet_re.is_match(&f) {
            continue;
        }

        let version = version_re
            .captures(&a)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        return Some(FfmpegInfo {
            ffmpeg,
            ffprobe,
            version,
            bundled,
        });
    }

    None
}

#[derive(Debug, Clone)]
pub struct SelfTestResult {
    pub mode: String,
    pub gpu: Option<GpuDevice>,
    pub devices: Vec<GpuDevice>,
    pub error: Option<String>,
}

async fn make_test_frames(
    ff: &str,
    dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create dir: {e}"))?;
    let a = dir.join("a.png");
    let b = dir.join("b.png");

    let r1 = {
        let mut cmd = tokio::process::Command::new(ff);
        cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=256x144:rate=1",
            "-frames:v",
            "1",
        ]);
        cmd.arg(&a);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await
    };
    match r1 {
        Ok(Ok(o)) if o.status.success() => {}
        _ => return Err("Failed to generate test frame a.png".to_string()),
    }

    let r2 = {
        let mut cmd = tokio::process::Command::new(ff);
        cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=256x144:rate=1",
            "-vf",
            "scroll=h=0.05",
            "-frames:v",
            "1",
        ]);
        cmd.arg(&b);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await
    };
    match r2 {
        Ok(Ok(o)) if o.status.success() => {}
        _ => return Err("Failed to generate test frame b.png".to_string()),
    }

    Ok((a, b))
}

pub async fn self_test(
    rife_dir: &Path,
    ff: &str,
    model_id: &str,
    tmp: &Path,
) -> SelfTestResult {
    let exe = rife_exe(rife_dir);
    let (a, b) = match make_test_frames(ff, tmp).await {
        Ok(paths) => paths,
        Err(e) => {
            return SelfTestResult {
                mode: "none".to_string(),
                gpu: None,
                devices: Vec::new(),
                error: Some(e),
            }
        }
    };
    let out = tmp.join("c.png");

    struct TryDevResult {
        ok: bool,
        ms: u64,
        stderr: String,
    }

    let try_dev = |g: i32| {
        let exe = exe.clone();
        let a = a.clone();
        let b = b.clone();
        let out = out.clone();
        let rife_dir = rife_dir.to_path_buf();
        let model_path = rife_dir.join(model_id);
        async move {
            let _ = tokio::fs::remove_file(&out).await;
            let start = std::time::Instant::now();
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.arg("-0")
                .arg(&a)
                .arg("-1")
                .arg(&b)
                .arg("-o")
                .arg(&out)
                .arg("-m")
                .arg(&model_path)
                .arg("-g")
                .arg(g.to_string());
            cmd.current_dir(&rife_dir);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);

            let res = tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output()).await;
            let elapsed = start.elapsed().as_millis() as u64;

            match res {
                Ok(Ok(output)) => {
                    let out_exists = out.exists();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    TryDevResult {
                        ok: output.status.success() && out_exists,
                        ms: elapsed,
                        stderr,
                    }
                }
                Ok(Err(e)) => TryDevResult {
                    ok: false,
                    ms: elapsed,
                    stderr: e.to_string(),
                },
                Err(_) => TryDevResult {
                    ok: false,
                    ms: elapsed,
                    stderr: "Timed out".to_string(),
                },
            }
        }
    };

    let first = try_dev(0).await;
    let devices = parse_vulkan_devices(&first.stderr);
    let mut results = Vec::new();

    if !devices.is_empty() {
        let mut d0 = devices[0].clone();
        d0.ok = first.ok;
        d0.ms = first.ms;
        results.push(d0);

        for d in &devices[1..] {
            let r = try_dev(d.id).await;
            let mut dev = d.clone();
            dev.ok = r.ok;
            dev.ms = r.ms;
            results.push(dev);
        }
    }

    if let Some(best) = select_best_gpu(&results) {
        return SelfTestResult {
            mode: "gpu".to_string(),
            gpu: Some(best),
            devices: results,
            error: None,
        };
    }

    let cpu = try_dev(-1).await;
    if cpu.ok {
        SelfTestResult {
            mode: "cpu".to_string(),
            gpu: None,
            devices: results,
            error: None,
        }
    } else {
        let err_src = if !first.stderr.trim().is_empty() {
            &first.stderr
        } else {
            &cpu.stderr
        };
        let lines: Vec<&str> = err_src.trim().lines().collect();
        let last_lines = if lines.len() > 4 {
            &lines[lines.len() - 4..]
        } else {
            &lines[..]
        };
        let error_msg = last_lines.join("\n");

        SelfTestResult {
            mode: "none".to_string(),
            gpu: None,
            devices: results,
            error: Some(if error_msg.is_empty() {
                "The engine could not run".to_string()
            } else {
                error_msg
            }),
        }
    }
}

pub async fn probe_encoders_with_order(ff: &str, order: &[&str]) -> Vec<String> {
    let mut cmd = tokio::process::Command::new(ff);
    cmd.args(["-hide_banner", "-encoders"]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let output = match tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let mut working = Vec::new();
    for &id in order {
        let pattern = format!(r"\b{}\b", regex::escape(id));
        let re = match regex::Regex::new(&pattern) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !re.is_match(&output) {
            continue;
        }

        let mut test_cmd = tokio::process::Command::new(ff);
        test_cmd.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=256x256:d=0.2",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            id,
            "-f",
            "null",
            "-",
        ]);
        #[cfg(windows)]
        test_cmd.creation_flags(0x08000000);

        let res = tokio::time::timeout(std::time::Duration::from_secs(30), test_cmd.output()).await;
        if let Ok(Ok(o)) = res {
            if o.status.success() {
                working.push(id.to_string());
            }
        }
    }

    working
}

pub async fn probe_encoders_for_vendor(ff: &str, vendor: Option<&str>) -> Vec<String> {
    let order = encoder_order_for_vendor(vendor);
    probe_encoders_with_order(ff, &order).await
}

pub async fn probe_encoders(ff: &str) -> Vec<String> {
    probe_encoders_with_order(ff, ENCODER_ORDER).await
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let minutes = (rem_secs % 3600) / 60;
    let seconds = rem_secs % 60;

    let z = days as i64 + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

#[derive(Debug, Clone)]
pub struct SetupOptions {
    pub base_dir: PathBuf,
    pub dev_engine_dir: Option<PathBuf>,
    pub install: bool,
    pub models: Option<Vec<String>>,
    pub self_test: bool,
}

pub async fn run_checks<F>(opts: SetupOptions, mut emit: F) -> SetupResult
where
    F: FnMut(ProgressEvent),
{
    let p = paths(&opts.base_dir);
    let mut cfg = SetupConfig {
        platform: PLATFORM.to_string(),
        arch: system_arch().to_string(),
        checked_at: now_iso(),
        ..Default::default()
    };

    // 1. System and disk
    emit(ProgressEvent {
        id: "system".to_string(),
        label: "System".to_string(),
        state: "checking".to_string(),
        detail: String::new(),
        progress: None,
        link: None,
    });

    let free = free_disk_space(&std::env::temp_dir());
    cfg.free_bytes = free;

    let platform_display = match PLATFORM {
        "win32" => "Windows",
        "darwin" => "macOS",
        "linux" => "Linux",
        _ => PLATFORM,
    };
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let ram_gb = total_memory()
        .map(|b| format!(" · {:.0} GB RAM", (b as f64) / ((1u64 << 30) as f64)))
        .unwrap_or_default();
    let free_gb = free
        .map(|b| format!(" · {:.0} GB free", (b as f64) / 1e9))
        .unwrap_or_default();
    let arch = system_arch();
    let detail = format!("{platform_display} {arch} · {cpus} threads{ram_gb}{free_gb}");
    let state = if free.map(|f| f < 4_000_000_000).unwrap_or(false) {
        "warn"
    } else {
        "ok"
    };

    emit(ProgressEvent {
        id: "system".to_string(),
        label: "System".to_string(),
        state: state.to_string(),
        detail,
        progress: None,
        link: None,
    });

    // 2. Graphics hardware and drivers
    emit(ProgressEvent {
        id: "gpu".to_string(),
        label: "Graphics".to_string(),
        state: "checking".to_string(),
        detail: String::new(),
        progress: None,
        link: None,
    });

    let gpus = os_gpus().await;
    cfg.os_gpus = gpus.clone();
    let vk = vulkan_loader_present();

    if !vk {
        let v = gpus.iter().find(|g| driver_link_for_vendor(&g.vendor).is_some());
        let link = v.and_then(|g| driver_link_for_vendor(&g.vendor)).map(|s| s.to_string());
        let gpu_name_str = v.map(|g| format!(" ({})", g.name)).unwrap_or_default();
        let detail = format!("No Vulkan driver found. Update your graphics driver{gpu_name_str}. Tween will use the CPU until then.");
        emit(ProgressEvent {
            id: "gpu".to_string(),
            label: "Graphics".to_string(),
            state: "warn".to_string(),
            detail,
            progress: None,
            link,
        });
    } else {
        let detail = if !gpus.is_empty() {
            gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" + ")
        } else {
            "Vulkan driver present".to_string()
        };
        emit(ProgressEvent {
            id: "gpu".to_string(),
            label: "Graphics".to_string(),
            state: "ok".to_string(),
            detail,
            progress: None,
            link: None,
        });
    }

    // 3. FFmpeg
    emit(ProgressEvent {
        id: "ffmpeg".to_string(),
        label: "FFmpeg".to_string(),
        state: "checking".to_string(),
        detail: String::new(),
        progress: None,
        link: None,
    });

    let mut ff = find_ffmpeg(&p).await;
    if ff.is_none() && opts.install {
        emit(ProgressEvent {
            id: "ffmpeg".to_string(),
            label: "FFmpeg".to_string(),
            state: "installing".to_string(),
            detail: "Downloading".to_string(),
            progress: Some(0.0),
            link: None,
        });

        let mut throttler = crate::remotezip::ProgressThrottler::new(
            |g: u64, t: u64| {
                let progress = if t > 0 { Some(g as f64 / t as f64) } else { None };
                emit(ProgressEvent {
                    id: "ffmpeg".to_string(),
                    label: "FFmpeg".to_string(),
                    state: "installing".to_string(),
                    detail: "Downloading".to_string(),
                    progress,
                    link: None,
                });
            },
            150,
        );

        match install_ffmpeg(&p, |g, t| throttler.emit(g, t)).await {
            Ok(()) => {
                ff = find_ffmpeg(&p).await;
            }
            Err(e) => {
                emit(ProgressEvent {
                    id: "ffmpeg".to_string(),
                    label: "FFmpeg".to_string(),
                    state: "error".to_string(),
                    detail: e,
                    progress: None,
                    link: None,
                });
            }
        }
    }

    let ff = match ff {
        Some(f) => f,
        None => {
            emit(ProgressEvent {
                id: "ffmpeg".to_string(),
                label: "FFmpeg".to_string(),
                state: if opts.install { "error".to_string() } else { "missing".to_string() },
                detail: "Needed to read and write video".to_string(),
                progress: None,
                link: None,
            });
            return SetupResult { ok: false, cfg };
        }
    };

    cfg.ffmpeg = Some(ff.ffmpeg.clone());
    cfg.ffprobe = Some(ff.ffprobe.clone());
    emit(ProgressEvent {
        id: "ffmpeg".to_string(),
        label: "FFmpeg".to_string(),
        state: "ok".to_string(),
        detail: format!("{}{}", ff.version, if ff.bundled { "" } else { " (system)" }),
        progress: None,
        link: None,
    });

    // 4. Engine and models
    emit(ProgressEvent {
        id: "engine".to_string(),
        label: "Interpolation engine".to_string(),
        state: "checking".to_string(),
        detail: String::new(),
        progress: None,
        link: None,
    });

    let wanted = opts.models.clone().unwrap_or_else(|| {
        MODELS.iter().map(|m| m.id.to_string()).collect()
    });

    let mut dir = p.rife_dir.clone();
    let dev_ok = match &opts.dev_engine_dir {
        Some(dev) => rife_exe(dev).exists() && !installed_models(dev).is_empty(),
        None => false,
    };
    if dev_ok && !rife_exe(&p.rife_dir).exists() {
        if let Some(dev) = &opts.dev_engine_dir {
            dir = dev.clone();
        }
    }

    let missing: Vec<String> = wanted
        .iter()
        .filter(|id| !installed_models(&dir).iter().any(|m| &m.id == id))
        .cloned()
        .collect();

    if (!rife_exe(&dir).exists() || !missing.is_empty()) && opts.install {
        dir = p.rife_dir.clone();
        emit(ProgressEvent {
            id: "engine".to_string(),
            label: "Interpolation engine".to_string(),
            state: "installing".to_string(),
            detail: "Downloading RIFE and models".to_string(),
            progress: Some(0.0),
            link: None,
        });

        let mut throttler = crate::remotezip::ProgressThrottler::new(
            |g: u64, t: u64| {
                let progress = if t > 0 { Some(g as f64 / t as f64) } else { None };
                emit(ProgressEvent {
                    id: "engine".to_string(),
                    label: "Interpolation engine".to_string(),
                    state: "installing".to_string(),
                    detail: "Downloading RIFE and models".to_string(),
                    progress,
                    link: None,
                });
            },
            150,
        );

        let needed_to_install: Vec<String> = wanted
            .iter()
            .filter(|id| !installed_models(&dir).iter().any(|m| &m.id == id))
            .cloned()
            .collect();

        if let Err(e) = install_rife(&p, &needed_to_install, |g, t| throttler.emit(g, t)).await {
            emit(ProgressEvent {
                id: "engine".to_string(),
                label: "Interpolation engine".to_string(),
                state: "error".to_string(),
                detail: e,
                progress: None,
                link: None,
            });
            return SetupResult { ok: false, cfg };
        }
    }

    let models = installed_models(&dir);
    if !rife_exe(&dir).exists() || models.is_empty() {
        emit(ProgressEvent {
            id: "engine".to_string(),
            label: "Interpolation engine".to_string(),
            state: "missing".to_string(),
            detail: "RIFE engine not installed".to_string(),
            progress: None,
            link: None,
        });
        return SetupResult { ok: false, cfg };
    }

    cfg.rife_dir = Some(dir.to_string_lossy().to_string());
    cfg.models = Some(models.iter().map(|m| m.id.to_string()).collect());
    emit(ProgressEvent {
        id: "engine".to_string(),
        label: "Interpolation engine".to_string(),
        state: "ok".to_string(),
        detail: format!("RIFE · {}", models.iter().map(|m| m.name).collect::<Vec<_>>().join(", ")),
        progress: None,
        link: None,
    });

    // 5. GPU self-test through the engine
    emit(ProgressEvent {
        id: "accel".to_string(),
        label: "GPU acceleration".to_string(),
        state: "checking".to_string(),
        detail: "Running a test frame".to_string(),
        progress: None,
        link: None,
    });

    let default_model_id = models
        .iter()
        .find(|m| m.default)
        .or_else(|| models.first())
        .map(|m| m.id)
        .unwrap_or("rife-v4.26");

    let st = if !opts.self_test {
        SelfTestResult {
            mode: "untested".to_string(),
            gpu: None,
            devices: Vec::new(),
            error: None,
        }
    } else {
        self_test(
            &dir,
            &ff.ffmpeg,
            default_model_id,
            &std::env::temp_dir().join("tween-selftest"),
        )
        .await
    };

    cfg.mode = Some(st.mode.clone());
    cfg.gpu = st.gpu.clone();
    cfg.devices = Some(st.devices.clone());

    if st.mode == "gpu" {
        let name = st.gpu.as_ref().map(|g| g.name.as_str()).unwrap_or("Unknown");
        emit(ProgressEvent {
            id: "accel".to_string(),
            label: "GPU acceleration".to_string(),
            state: "ok".to_string(),
            detail: format!("{name} (Vulkan)"),
            progress: None,
            link: None,
        });
    } else if st.mode == "untested" {
        emit(ProgressEvent {
            id: "accel".to_string(),
            label: "GPU acceleration".to_string(),
            state: "warn".to_string(),
            detail: "Skipped".to_string(),
            progress: None,
            link: None,
        });
    } else if st.mode == "cpu" {
        emit(ProgressEvent {
            id: "accel".to_string(),
            label: "GPU acceleration".to_string(),
            state: "warn".to_string(),
            detail: "No working GPU found. Tween will run on the CPU, which is much slower.".to_string(),
            progress: None,
            link: None,
        });
    } else {
        emit(ProgressEvent {
            id: "accel".to_string(),
            label: "GPU acceleration".to_string(),
            state: "error".to_string(),
            detail: st.error.unwrap_or_else(|| "The engine could not run".to_string()),
            progress: None,
            link: None,
        });
        return SetupResult { ok: false, cfg };
    }

    // 6. Encoders
    emit(ProgressEvent {
        id: "encoder".to_string(),
        label: "Video encoder".to_string(),
        state: "checking".to_string(),
        detail: String::new(),
        progress: None,
        link: None,
    });

    let encoders = probe_encoders_for_vendor(&ff.ffmpeg, st.gpu.as_ref().map(|g| g.vendor.as_str())).await;
    cfg.encoders = Some(encoders.clone());
    let hw: Vec<&str> = encoders.iter().filter(|e| !e.starts_with("lib")).map(|s| s.as_str()).collect();
    let detail = if !hw.is_empty() {
        format!("Hardware: {}", hw.join(", "))
    } else {
        "CPU (x264 / x265)".to_string()
    };

    emit(ProgressEvent {
        id: "encoder".to_string(),
        label: "Video encoder".to_string(),
        state: "ok".to_string(),
        detail,
        progress: None,
        link: None,
    });

    let _ = save_config(&opts.base_dir, &cfg);
    SetupResult { ok: true, cfg }
}

#[tauri::command]
pub async fn setup_run(
    app: tauri::AppHandle,
    install: bool,
    models: Option<Vec<String>>,
) -> Result<SetupResult, String> {
    use tauri::Manager;
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {e}"))?;

    let opts = SetupOptions {
        base_dir,
        dev_engine_dir: None,
        install,
        models,
        self_test: true,
    };

    let app_handle = app.clone();
    let res = run_checks(opts, move |item| {
        use tauri::Emitter;
        let _ = app_handle.emit("setup-progress", &item);
    })
    .await;

    Ok(res)
}

#[tauri::command]
pub fn setup_config(app: tauri::AppHandle) -> Result<Option<SetupConfig>, String> {
    use tauri::Manager;
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {e}"))?;

    let mut cfg = match load_config(&base_dir) {
        Some(c) => c,
        None => return Ok(None),
    };
    let ffmpeg_ok = cfg.ffmpeg.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false);
    let rife_ok = cfg.rife_dir.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false);
    cfg.paths_exist = Some(ffmpeg_ok && rife_ok);
    Ok(Some(cfg))
}

pub fn is_allowed_driver_url(url: &str) -> bool {
    if !url.starts_with("https://") {
        return false;
    }
    let after_scheme = &url["https://".len()..];
    let host = match after_scheme.find('/') {
        Some(idx) => &after_scheme[..idx],
        None => after_scheme,
    };
    if host.is_empty()
        || host.contains('@')
        || host.contains(':')
        || host.contains(' ')
        || host.contains('?')
        || host.contains('#')
        || host.contains('\\')
    {
        return false;
    }
    let host_lower = host.to_ascii_lowercase();
    host_lower == "nvidia.com"
        || host_lower == "www.nvidia.com"
        || host_lower.ends_with(".nvidia.com")
        || host_lower == "amd.com"
        || host_lower == "www.amd.com"
        || host_lower.ends_with(".amd.com")
        || host_lower == "intel.com"
        || host_lower == "www.intel.com"
        || host_lower.ends_with(".intel.com")
        || host_lower == "adarzh.tech"
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !is_allowed_driver_url(&url) {
        return Err("URL not allowed: must be an HTTPS link to an official graphics driver page (nvidia.com, amd.com, intel.com)".to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("rundll32.exe");
        cmd.args(["url.dll,FileProtocolHandler", &url]);
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|e| format!("Failed to open browser: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        return Err("Unsupported platform for opening browser".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_temp_dir(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "tween-test-setup-{}-{}-{}-{}",
            name,
            std::process::id(),
            count,
            nanos
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn test_is_allowed_driver_url() {
        assert!(is_allowed_driver_url("https://www.nvidia.com/Download/index.aspx"));
        assert!(is_allowed_driver_url("https://www.amd.com/en/support/download/drivers.html"));
        assert!(is_allowed_driver_url("https://www.intel.com/content/www/us/en/support/detect.html"));
        assert!(is_allowed_driver_url("https://nvidia.com/drivers"));
        assert!(is_allowed_driver_url("https://downloadcenter.intel.com/"));
        assert!(is_allowed_driver_url("https://adarzh.tech"));
        assert!(is_allowed_driver_url("https://adarzh.tech/"));

        assert!(!is_allowed_driver_url("http://www.nvidia.com/Download/index.aspx"));
        assert!(!is_allowed_driver_url("http://adarzh.tech"));
        assert!(!is_allowed_driver_url("https://sub.adarzh.tech"));
        assert!(!is_allowed_driver_url("https://adarzh.tech.attacker.com"));
        assert!(!is_allowed_driver_url("https://evil.com/www.nvidia.com"));
        assert!(!is_allowed_driver_url("https://evil.com/https://adarzh.tech"));
        assert!(!is_allowed_driver_url("https://nvidia.com.attacker.com/"));
        assert!(!is_allowed_driver_url("https://user:pass@www.nvidia.com/"));
        assert!(!is_allowed_driver_url("https://www.nvidia.com:8080/"));
        assert!(!is_allowed_driver_url("https://evil.com?https://nvidia.com"));
        assert!(!is_allowed_driver_url("cmd /c start https://www.nvidia.com"));
        assert!(!is_allowed_driver_url("file:///C:/Windows/System32/cmd.exe"));
    }

    #[test]
    fn test_parse_vulkan_devices() {
        let err = "[0 NVIDIA GeForce RTX 4050 Laptop GPU]  queueC=2[8]  queueG=0[16]  queueT=1[2]\n[0 NVIDIA GeForce RTX 4050 Laptop GPU]  bugsbn1=0\n[1 Intel(R) UHD Graphics]  queueC=1[1]\n";
        let d = parse_vulkan_devices(err);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].id, 0);
        assert_eq!(d[0].vendor, "nvidia");
        assert!(!d[0].integrated);
        assert_eq!(d[1].id, 1);
        assert_eq!(d[1].vendor, "intel");
        assert!(d[1].integrated);
        assert_eq!(vendor_of("AMD Radeon RX 7800 XT"), "amd");
    }

    #[test]
    fn test_vendor_of() {
        assert_eq!(vendor_of("NVIDIA GeForce RTX 4090"), "nvidia");
        assert_eq!(vendor_of("Quadro RTX 5000"), "nvidia");
        assert_eq!(vendor_of("GeForce GTX 1080"), "nvidia");
        assert_eq!(vendor_of("AMD Radeon RX 6700 XT"), "amd");
        assert_eq!(vendor_of("ATI Radeon HD 5870"), "amd");
        assert_eq!(vendor_of("Intel(R) Arc(TM) A770 Graphics"), "intel");
        assert_eq!(vendor_of("Intel(R) Iris(R) Xe Graphics"), "intel");
        assert_eq!(vendor_of("Intel(R) UHD Graphics 630"), "intel");
        assert_eq!(vendor_of("Apple M1"), "apple");
        assert_eq!(vendor_of("Apple M2 Max"), "apple");
        assert_eq!(vendor_of("M3 Pro"), "apple");
        assert_eq!(vendor_of("Microsoft Basic Render Driver"), "other");
    }

    #[test]
    fn test_config_save_load() {
        let tmp = test_temp_dir("cfg");

        let cfg = SetupConfig {
            platform: "win32".to_string(),
            arch: "x64".to_string(),
            checked_at: "2026-11-15T10:00:00.000Z".to_string(),
            free_bytes: Some(10_000_000_000),
            os_gpus: vec![OsGpu {
                name: "RTX 4090".to_string(),
                driver: Some("551.23".to_string()),
                vendor: "nvidia".to_string(),
            }],
            ffmpeg: Some("C:\\ffmpeg\\bin\\ffmpeg.exe".to_string()),
            ffprobe: Some("C:\\ffmpeg\\bin\\ffprobe.exe".to_string()),
            rife_dir: Some("C:\\rife".to_string()),
            models: Some(vec!["rife-v4.26".to_string()]),
            mode: Some("gpu".to_string()),
            gpu: Some(GpuDevice {
                id: 0,
                name: "RTX 4090".to_string(),
                vendor: "nvidia".to_string(),
                integrated: false,
                ok: true,
                ms: 45,
            }),
            devices: Some(vec![]),
            encoders: Some(vec!["hevc_nvenc".to_string()]),
            engine_mode: None,
            paths_exist: None,
        };

        save_config(&tmp, &cfg).expect("save_config should succeed");
        let loaded = load_config(&tmp).expect("load_config should succeed");
        assert_eq!(loaded, cfg);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Builds a minimal valid zip file in memory.
    fn make_test_zip(with_zip64: bool) -> Vec<u8> {
        use std::io::Write;

        struct EntrySpec {
            name: String,
            data: Vec<u8>,
            method: u16, // 0 = stored, 8 = deflate
        }

        // Raw deflate helper
        let deflate = |input: &[u8]| -> Vec<u8> {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(input).unwrap();
            encoder.finish().unwrap()
        };

        let entries = vec![
            EntrySpec {
                name: "rife-ncnn-vulkan-refs/heads/master-windows/bin/ffmpeg.exe".to_string(),
                data: b"fake ffmpeg binary content".to_vec(),
                method: 0,
            },
            EntrySpec {
                name: "rife-ncnn-vulkan-refs/heads/master-windows/rife-v4.26/flownet.bin".to_string(),
                data: b"weights 1234567890".to_vec(),
                method: 8,
            },
            EntrySpec {
                name: "rife-ncnn-vulkan-refs/heads/master-windows/LICENSE".to_string(),
                data: b"MIT License".to_vec(),
                method: 0,
            },
        ];

        let mut out = Vec::new();
        struct CdRecord {
            name: String,
            method: u16,
            csize: u64,
            size: u64,
            offset: u64,
        }

        let mut cd_records = Vec::new();

        for e in entries {
            let offset = out.len() as u64;
            let (cdata, csize) = if e.method == 8 {
                let comp = deflate(&e.data);
                let len = comp.len() as u64;
                (comp, len)
            } else {
                (e.data.clone(), e.data.len() as u64)
            };
            let size = e.data.len() as u64;

            // Local file header: 30 bytes + name
            out.extend_from_slice(&0x04034b50u32.to_le_bytes()); // signature
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&e.method.to_le_bytes()); // method
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&0u32.to_le_bytes()); // crc32
            out.extend_from_slice(&(csize as u32).to_le_bytes());
            out.extend_from_slice(&(size as u32).to_le_bytes());
            out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra len
            out.extend_from_slice(e.name.as_bytes());
            out.extend_from_slice(&cdata);

            cd_records.push(CdRecord {
                name: e.name,
                method: e.method,
                csize,
                size,
                offset,
            });
        }

        let cd_offset = out.len() as u64;
        let mut cd_data = Vec::new();

        for cdr in &cd_records {
            let mut extra = Vec::new();
            let (rec_size, rec_csize, rec_offset) = if with_zip64 {
                // zip64 extra field (tag 0x0001)
                extra.extend_from_slice(&0x0001u16.to_le_bytes());
                extra.extend_from_slice(&24u16.to_le_bytes()); // len 24
                extra.extend_from_slice(&cdr.size.to_le_bytes());
                extra.extend_from_slice(&cdr.csize.to_le_bytes());
                extra.extend_from_slice(&cdr.offset.to_le_bytes());
                (0xffff_ffffu32, 0xffff_ffffu32, 0xffff_ffffu32)
            } else {
                (cdr.size as u32, cdr.csize as u32, cdr.offset as u32)
            };

            cd_data.extend_from_slice(b"PK\x01\x02");
            cd_data.extend_from_slice(&20u16.to_le_bytes()); // version made by
            cd_data.extend_from_slice(&20u16.to_le_bytes()); // version needed
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // flags
            cd_data.extend_from_slice(&cdr.method.to_le_bytes());
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // mod time
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // mod date
            cd_data.extend_from_slice(&0u32.to_le_bytes()); // crc32
            cd_data.extend_from_slice(&rec_csize.to_le_bytes());
            cd_data.extend_from_slice(&rec_size.to_le_bytes());
            cd_data.extend_from_slice(&(cdr.name.len() as u16).to_le_bytes());
            cd_data.extend_from_slice(&(extra.len() as u16).to_le_bytes());
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // comment len
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // disk nr
            cd_data.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            cd_data.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            cd_data.extend_from_slice(&rec_offset.to_le_bytes());
            cd_data.extend_from_slice(cdr.name.as_bytes());
            cd_data.extend_from_slice(&extra);
        }

        let cd_size = cd_data.len() as u64;
        out.extend_from_slice(&cd_data);

        if with_zip64 {
            let zip64_eocd_offset = out.len() as u64;
            // Zip64 End of Central Directory record
            out.extend_from_slice(b"PK\x06\x06"); // signature
            out.extend_from_slice(&44u64.to_le_bytes()); // size of record following
            out.extend_from_slice(&45u16.to_le_bytes()); // version made by
            out.extend_from_slice(&45u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u32.to_le_bytes()); // disk number
            out.extend_from_slice(&0u32.to_le_bytes()); // disk number of CD
            out.extend_from_slice(&(cd_records.len() as u64).to_le_bytes()); // entries this disk
            out.extend_from_slice(&(cd_records.len() as u64).to_le_bytes()); // total entries
            out.extend_from_slice(&cd_size.to_le_bytes());
            out.extend_from_slice(&cd_offset.to_le_bytes());

            // Zip64 End of Central Directory locator
            out.extend_from_slice(b"PK\x06\x07"); // signature
            out.extend_from_slice(&0u32.to_le_bytes()); // disk with zip64 eocd
            out.extend_from_slice(&zip64_eocd_offset.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes()); // total disks

            // Standard EOCD with 0xffff / 0xffffffff sentinels
            out.extend_from_slice(b"PK\x05\x06");
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0xffffu16.to_le_bytes());
            out.extend_from_slice(&0xffffu16.to_le_bytes());
            out.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
            out.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // comment len
        } else {
            // Standard EOCD
            out.extend_from_slice(b"PK\x05\x06");
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&(cd_records.len() as u16).to_le_bytes());
            out.extend_from_slice(&(cd_records.len() as u16).to_le_bytes());
            out.extend_from_slice(&(cd_size as u32).to_le_bytes());
            out.extend_from_slice(&(cd_offset as u32).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // comment len
        }

        out
    }

    /// Spawns a local mock HTTP server that supports HTTP Range requests.
    async fn spawn_range_server(
        data: Vec<u8>,
        fail_first_range: bool,
    ) -> (String, tokio::sync::oneshot::Sender<()>) {
        unsafe {
            std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
            std::env::set_var("no_proxy", "127.0.0.1,localhost");
        }
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            let data = std::sync::Arc::new(data);
            let first_range_failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    conn = listener.accept() => {
                        let (mut socket, _) = match conn {
                            Ok(c) => c,
                            Err(_) => break,
                        };
                        let data = data.clone();
                        let first_failed = first_range_failed.clone();

                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            let n = match socket.read(&mut buf).await {
                                Ok(n) if n > 0 => n,
                                _ => return,
                            };
                            let req = String::from_utf8_lossy(&buf[..n]);

                            // Find Range: bytes=X-Y
                            let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                            let total = data.len();

                            if let Some(rh) = range_header {
                                if let Some(spec) = rh.split('=').nth(1) {
                                    let parts: Vec<&str> = spec.trim().split('-').collect();
                                    if parts.len() == 2 {
                                        let start: usize = parts[0].parse().unwrap_or(0);
                                        let end: usize = parts[1].parse().unwrap_or(total - 1);

                                        // Test retry: return 403 on first multi-byte range request
                                        if fail_first_range && (start > 0 || end > 0) && !first_failed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                                            let resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                            let _ = socket.write_all(resp.as_bytes()).await;
                                            return;
                                        }

                                        let end = end.min(total.saturating_sub(1));
                                        if start <= end && start < total {
                                            let slice = &data[start..=end];
                                            let resp = format!(
                                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                                slice.len()
                                            );
                                            let _ = socket.write_all(resp.as_bytes()).await;
                                            let _ = socket.write_all(slice).await;
                                            return;
                                        }
                                    }
                                }
                            }

                            // Full response fallback
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        });
                    }
                }
            }
        });

        (format!("http://127.0.0.1:{port}/archive.zip"), shutdown_tx)
    }

    #[tokio::test]
    async fn test_remotezip_extraction_and_prefix() {
        let zip_bytes = make_test_zip(false);
        let (url, shutdown) = spawn_range_server(zip_bytes, false).await;

        let tmp = test_temp_dir("zip-extract");

        let want = ["bin/ffmpeg.exe", "LICENSE", "rife-v4.26/"];
        let mut progress_calls = 0;

        crate::remotezip::fetch_from_zip(&url, &want, &tmp, |_got, _total| {
            progress_calls += 1;
        })
        .await
        .expect("fetch_from_zip should succeed");

        assert!(progress_calls > 0);
        // Verify bin/ffmpeg.exe was stripped to ffmpeg.exe
        assert!(tmp.join("ffmpeg.exe").exists());
        let ff_content = std::fs::read_to_string(tmp.join("ffmpeg.exe")).unwrap();
        assert_eq!(ff_content, "fake ffmpeg binary content");

        // Verify rife-v4.26/flownet.bin decompressed with flate2 deflate
        assert!(tmp.join("rife-v4.26").join("flownet.bin").exists());
        let fn_content = std::fs::read(tmp.join("rife-v4.26").join("flownet.bin")).unwrap();
        assert_eq!(fn_content, b"weights 1234567890");

        // Verify LICENSE
        assert!(tmp.join("LICENSE").exists());
        let lic_content = std::fs::read_to_string(tmp.join("LICENSE")).unwrap();
        assert_eq!(lic_content, "MIT License");

        let _ = shutdown.send(());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn test_remotezip_zip64() {
        let zip_bytes = make_test_zip(true);
        let (url, shutdown) = spawn_range_server(zip_bytes, false).await;

        let rz = crate::remotezip::RemoteZip::open(&url)
            .await
            .expect("open should succeed")
            .expect("server should support ranges");

        assert_eq!(rz.entries.len(), 3);
        assert!(rz.entries.iter().any(|e| e.name.ends_with("ffmpeg.exe")));
        assert!(rz.entries.iter().any(|e| e.name.ends_with("flownet.bin")));
        assert!(rz.entries.iter().any(|e| e.name.ends_with("LICENSE")));

        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn test_remotezip_retry_on_expired_url() {
        let zip_bytes = make_test_zip(false);
        let (url, shutdown) = spawn_range_server(zip_bytes, true).await;

        let tmp = test_temp_dir("retry");

        let want = ["LICENSE"];
        crate::remotezip::fetch_from_zip(&url, &want, &tmp, |_g, _t| {})
            .await
            .expect("fetch_from_zip should retry on 403 and succeed");

        assert!(tmp.join("LICENSE").exists());

        let _ = shutdown.send(());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[ignore = "runs setup installer against real download URLs"]
    async fn test_real_setup_downloads() {
        let tmp = test_temp_dir("real-download");
        let p = paths(&tmp);

        // 1. Test real FFmpeg download & extraction
        install_ffmpeg(&p, |_got, _total| {})
            .await
            .expect("install_ffmpeg should succeed with real download URLs");

        let exe_suffix = if PLATFORM == "win32" { ".exe" } else { "" };
        let ffmpeg_bin = p.ff_dir.join(format!("ffmpeg{exe_suffix}"));
        let ffprobe_bin = p.ff_dir.join(format!("ffprobe{exe_suffix}"));

        assert!(ffmpeg_bin.exists(), "ffmpeg binary should exist at {:?}", ffmpeg_bin);
        assert!(ffprobe_bin.exists(), "ffprobe binary should exist at {:?}", ffprobe_bin);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta_ff = std::fs::metadata(&ffmpeg_bin).expect("metadata ffmpeg");
            let meta_probe = std::fs::metadata(&ffprobe_bin).expect("metadata ffprobe");
            assert_ne!(
                meta_ff.permissions().mode() & 0o111,
                0,
                "ffmpeg should be executable"
            );
            assert_ne!(
                meta_probe.permissions().mode() & 0o111,
                0,
                "ffprobe should be executable"
            );
        }

        // Run `ffmpeg -version`
        let mut cmd = std::process::Command::new(&ffmpeg_bin);
        cmd.arg("-version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd.output().expect("ffmpeg -version should execute");
        assert!(output.status.success(), "ffmpeg -version should exit successfully: {:?}", output);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("ffmpeg version"),
            "ffmpeg -version stdout should contain version string: {}",
            stdout
        );

        // 2. Test real RIFE download & extraction
        install_rife(&p, &["rife-v4.26".to_string()], |_got, _total| {})
            .await
            .expect("install_rife should succeed with real download URLs");

        let rife_binary = rife_exe(&p.rife_dir);
        assert!(rife_binary.exists(), "rife binary should exist at {:?}", rife_binary);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta_rife = std::fs::metadata(&rife_binary).expect("metadata rife");
            assert_ne!(
                meta_rife.permissions().mode() & 0o111,
                0,
                "rife binary should be executable"
            );
        }

        assert!(p.rife_dir.join("LICENSE").exists(), "RIFE LICENSE should exist");
        let model_dir = p.rife_dir.join("rife-v4.26");
        assert!(
            model_dir.join("flownet.bin").exists(),
            "flownet.bin should exist in rife-v4.26"
        );
        assert!(
            model_dir.join("flownet.param").exists(),
            "flownet.param should exist in rife-v4.26"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_amd_and_intel_vulkan_device_parsing() {
        let stderr = r#"
[0 AMD Radeon RX 6600]  queueC=0[1] queueG=0[1] queueT=0[1]
[1 AMD Radeon(TM) Graphics]  queueC=0[1] queueG=0[1] queueT=0[1]
[2 Intel(R) Arc(TM) A770 Graphics]  queueC=0[1] queueG=0[1] queueT=0[1]
[3 Intel(R) UHD Graphics 770]  queueC=0[1] queueG=0[1] queueT=0[1]
"#;
        let devs = parse_vulkan_devices(stderr);
        assert_eq!(devs.len(), 4);

        // 0: AMD Radeon RX 6600 (discrete AMD)
        assert_eq!(devs[0].id, 0);
        assert_eq!(devs[0].name, "AMD Radeon RX 6600");
        assert_eq!(devs[0].vendor, "amd");
        assert!(!devs[0].integrated, "RX 6600 should be discrete");

        // 1: AMD Radeon(TM) Graphics (integrated AMD)
        assert_eq!(devs[1].id, 1);
        assert_eq!(devs[1].name, "AMD Radeon(TM) Graphics");
        assert_eq!(devs[1].vendor, "amd");
        assert!(devs[1].integrated, "Radeon(TM) Graphics should be integrated");

        // 2: Intel Arc A770 (discrete Intel)
        assert_eq!(devs[2].id, 2);
        assert_eq!(devs[2].name, "Intel(R) Arc(TM) A770 Graphics");
        assert_eq!(devs[2].vendor, "intel");
        assert!(!devs[2].integrated, "Intel Arc A770 should be discrete");

        // 3: Intel UHD 770 (integrated Intel)
        assert_eq!(devs[3].id, 3);
        assert_eq!(devs[3].name, "Intel(R) UHD Graphics 770");
        assert_eq!(devs[3].vendor, "intel");
        assert!(devs[3].integrated, "Intel UHD 770 should be integrated");
    }

    #[test]
    fn test_two_gpu_laptop_discrete_wins() {
        // AMD laptop: iGPU + discrete GPU
        let amd_igpu = GpuDevice {
            id: 0,
            name: "AMD Radeon(TM) Graphics".into(),
            vendor: "amd".into(),
            integrated: true,
            ok: true,
            ms: 35,
        };
        let amd_dgpu = GpuDevice {
            id: 1,
            name: "AMD Radeon RX 6600M".into(),
            vendor: "amd".into(),
            integrated: false,
            ok: true,
            ms: 55,
        };
        let best_amd = select_best_gpu(&[amd_igpu.clone(), amd_dgpu.clone()]);
        assert_eq!(best_amd.as_ref().map(|g| g.id), Some(1), "Discrete AMD GPU should win over faster iGPU");

        // Intel laptop: Intel UHD iGPU + Intel Arc discrete GPU
        let intel_igpu = GpuDevice {
            id: 0,
            name: "Intel(R) UHD Graphics 770".into(),
            vendor: "intel".into(),
            integrated: true,
            ok: true,
            ms: 30,
        };
        let intel_dgpu = GpuDevice {
            id: 1,
            name: "Intel(R) Arc(TM) A770 Graphics".into(),
            vendor: "intel".into(),
            integrated: false,
            ok: true,
            ms: 60,
        };
        let best_intel = select_best_gpu(&[intel_igpu.clone(), intel_dgpu.clone()]);
        assert_eq!(best_intel.as_ref().map(|g| g.id), Some(1), "Discrete Intel Arc GPU should win over faster UHD iGPU");

        // When discrete GPU fails self-test, integrated GPU should win
        let failed_dgpu = GpuDevice {
            id: 1,
            name: "Intel(R) Arc(TM) A770 Graphics".into(),
            vendor: "intel".into(),
            integrated: false,
            ok: false,
            ms: 60,
        };
        let best_fallback = select_best_gpu(&[intel_igpu.clone(), failed_dgpu]);
        assert_eq!(best_fallback.as_ref().map(|g| g.id), Some(0), "Working integrated GPU should win when discrete fails");

        // When all GPUs fail self-test, select_best_gpu returns None (triggering CPU mode)
        let failed_igpu = GpuDevice {
            id: 0,
            name: "Intel(R) UHD Graphics 770".into(),
            vendor: "intel".into(),
            integrated: true,
            ok: false,
            ms: 30,
        };
        assert_eq!(select_best_gpu(&[failed_igpu]), None);
        assert_eq!(select_best_gpu(&[]), None);
    }

    #[test]
    fn test_encoder_probe_order_vendor_preference() {
        let amd_order = encoder_order_for_vendor(Some("amd"));
        let amf_pos = amd_order.iter().position(|e| *e == "hevc_amf").unwrap();
        let qsv_pos_in_amd = amd_order.iter().position(|e| *e == "hevc_qsv").unwrap();
        assert!(amf_pos < qsv_pos_in_amd, "AMF should be prioritized before QSV on AMD");

        let intel_order = encoder_order_for_vendor(Some("intel"));
        let qsv_pos = intel_order.iter().position(|e| *e == "hevc_qsv").unwrap();
        let amf_pos_in_intel = intel_order.iter().position(|e| *e == "hevc_amf").unwrap();
        assert!(qsv_pos < amf_pos_in_intel, "QSV should be prioritized before AMF on Intel");

        // Simulated probe filtering:
        // On an AMD system where only AMF and software encoders are functional:
        let available_on_amd = ["hevc_amf", "h264_amf", "libx265", "libx264"];
        let chosen_amd: Vec<&str> = amd_order.into_iter().filter(|e| available_on_amd.contains(e)).collect();
        assert_eq!(chosen_amd[0], "hevc_amf");
        assert_eq!(chosen_amd[1], "h264_amf");

        // On an Intel system where only QSV and software encoders are functional:
        let available_on_intel = ["hevc_qsv", "h264_qsv", "libx265", "libx264"];
        let chosen_intel: Vec<&str> = intel_order.into_iter().filter(|e| available_on_intel.contains(e)).collect();
        assert_eq!(chosen_intel[0], "hevc_qsv");
        assert_eq!(chosen_intel[1], "h264_qsv");
    }

    #[test]
    #[ignore = "requires real GPU and installed RIFE engine to run"]
    fn test_real_gpu_self_test() {
        // Run with: cargo test -- --ignored test_real_gpu_self_test
    }
}
