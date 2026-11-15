use super::clean::dir_size;
use super::encoders::get_encoder;
use super::models::{rife_exe, rife_stream_exe, MODELS};
use super::plan::{
    build_frame_times, chunk_size_with_disk, cut_fixes, plan_chunks, ratio, rife_threads,
    serialize_frame_times,
};
use super::probe::colour_of;
use super::splitter::PngSplitter;
use super::ssim::calculate_ssim;
use super::types::{
    ColourInput, JobFinished, JobProgressEvent, JobRequest, PipelineConfig, StageTimes,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

static FPS_MODE_SUPPORT: LazyLock<StdMutex<HashMap<String, bool>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

pub fn parse_ffmpeg_version(output: &str) -> Option<(u32, u32)> {
    static VER_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)ffmpeg\s+version\s+n?(\d+)(?:[.-](\d+))?").unwrap()
    });
    if let Some(caps) = VER_RE.captures(output) {
        let major: u32 = caps.get(1)?.as_str().parse().ok()?;
        let minor: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        return Some((major, minor));
    }
    None
}

pub fn version_supports_fps_mode(version_output: &str) -> bool {
    if let Some((major, minor)) = parse_ffmpeg_version(version_output) {
        if major > 5 {
            return true;
        }
        if major == 5 {
            return minor >= 1;
        }
        return false;
    }
    // Handle N-112345 git master builds
    static N_GIT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)ffmpeg\s+version\s+N-(\d+)").unwrap()
    });
    if let Some(caps) = N_GIT_RE.captures(version_output) {
        if let Some(num_str) = caps.get(1) {
            if let Ok(build_num) = num_str.as_str().parse::<u32>() {
                return build_num >= 107000;
            }
        }
        return true;
    }
    // Direct token check if help or docs mentioned fps_mode
    if version_output.contains("fps_mode") {
        return true;
    }
    // Fallback: if it explicitly indicates 4.x or earlier, false; otherwise default to true
    !version_output.contains("version 4.")
        && !version_output.contains("version 3.")
        && !version_output.contains("version 2.")
}

pub fn fps_mode_args_for_support(supports_fps_mode: bool, mode: &str) -> (&'static str, &'static str) {
    if supports_fps_mode {
        ("-fps_mode", match mode {
            "cfr" => "cfr",
            "vfr" => "vfr",
            _ => "passthrough",
        })
    } else {
        ("-vsync", match mode {
            "cfr" => "cfr",
            "vfr" => "vfr",
            _ => "passthrough",
        })
    }
}

pub fn probe_ffmpeg_fps_mode_support(ffmpeg_bin: &str) -> bool {
    let mut cmd = std::process::Command::new(ffmpeg_bin);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            return version_supports_fps_mode(&s);
        }
    }

    // Fallback: probe `ffmpeg -h`
    let mut h_cmd = std::process::Command::new(ffmpeg_bin);
    h_cmd.arg("-h");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        h_cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = h_cmd.output() {
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if text.contains("-fps_mode") || text.contains("fps_mode") {
            return true;
        }
    }

    // Default to true for modern systems if binary wasn't found or couldn't run
    true
}

pub fn ffmpeg_supports_fps_mode(ffmpeg_bin: &str) -> bool {
    let mut map = FPS_MODE_SUPPORT.lock().unwrap();
    if let Some(&supported) = map.get(ffmpeg_bin) {
        return supported;
    }
    let supported = probe_ffmpeg_fps_mode_support(ffmpeg_bin);
    map.insert(ffmpeg_bin.to_string(), supported);
    supported
}

pub fn fps_mode_args(ffmpeg_bin: &str, mode: &str) -> (&'static str, &'static str) {
    let supported = ffmpeg_supports_fps_mode(ffmpeg_bin);
    fps_mode_args_for_support(supported, mode)
}

pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

pub struct ActiveProcesses {
    pids: Mutex<HashSet<u32>>,
}

impl Default for ActiveProcesses {
    fn default() -> Self {
        Self::new()
    }
}

impl ActiveProcesses {
    pub fn new() -> Self {
        Self {
            pids: Mutex::new(HashSet::new()),
        }
    }

    pub async fn add(&self, pid: u32) {
        if pid != 0 {
            self.pids.lock().await.insert(pid);
        }
    }

    pub async fn remove(&self, pid: u32) {
        if pid != 0 {
            self.pids.lock().await.remove(&pid);
        }
    }

    pub async fn kill_all(&self) {
        let pids = {
            let mut lock = self.pids.lock().await;
            let pids: Vec<u32> = lock.iter().copied().collect();
            lock.clear();
            pids
        };
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut handles = Vec::new();
            for pid in pids {
                if pid == 0 {
                    continue;
                }
                let mut cmd = tokio::process::Command::new("taskkill");
                cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                if let Ok(child) = cmd.spawn() {
                    handles.push(child);
                }
            }
            for mut h in handles {
                let _ = h.wait().await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            for pid in pids {
                kill_tree(pid);
            }
        }
    }
}

pub fn resolve_temp_root(custom_temp: Option<&str>, output_path: &str) -> PathBuf {
    if let Some(r) = custom_temp {
        let trimmed = r.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let sys_temp = std::env::temp_dir();
    let out_p = Path::new(output_path);
    let out_dir = if let Some(parent) = out_p.parent() {
        if parent.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            parent.to_path_buf()
        }
    } else {
        PathBuf::from(".")
    };

    let mut check_dir = out_dir.clone();
    while !check_dir.exists() {
        if let Some(parent) = check_dir.parent() {
            if parent == check_dir {
                break;
            }
            check_dir = parent.to_path_buf();
        } else {
            break;
        }
    }

    let sys_free = crate::setup::free_disk_space(&sys_temp).unwrap_or(0);
    let out_free = crate::setup::free_disk_space(&check_dir).unwrap_or(0);

    if out_free > sys_free {
        out_dir.join(".tween-temp")
    } else {
        sys_temp
    }
}

pub struct ExtractorHandle {
    pub child: tokio::process::Child,
    pub pid: u32,
    pub task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
pub struct ExtractorSync {
    pub pool: PathBuf,
    pub written: Arc<AtomicUsize>,
    pub released: Arc<AtomicUsize>,
    pub max_ahead: usize,
    pub notify_waiters: Arc<tokio::sync::Notify>,
    pub notify_capacity: Arc<tokio::sync::Notify>,
    pub cancel: Arc<AtomicBool>,
    pub ended: Arc<AtomicBool>,
    pub failed: Arc<Mutex<Option<String>>>,
}

pub fn spawn_streaming_extractor(
    ffmpeg: &str,
    file: &str,
    trim_args: &[String],
    scale_in: &str,
    use_hwaccel: bool,
    sync: ExtractorSync,
) -> Result<ExtractorHandle, String> {
    let mut ext_cmd = tokio::process::Command::new(ffmpeg);
    ext_cmd.args(["-v", "error"]);
    if use_hwaccel {
        ext_cmd.args(["-hwaccel", "auto"]);
    }
    ext_cmd.args(trim_args);
    let (fps_flag, fps_val) = fps_mode_args(ffmpeg, "passthrough");
    ext_cmd.args([
        "-i",
        file,
        "-map",
        "0:v:0",
        fps_flag,
        fps_val,
        "-an",
        "-sn",
        "-vf",
        scale_in,
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-compression_level",
        "0",
        "-",
    ]);
    ext_cmd.stdout(std::process::Stdio::piped());
    ext_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        ext_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut ext_child = ext_cmd
        .spawn()
        .map_err(|e| format!("Failed to start extractor: {}", e))?;
    let ext_pid = ext_child.id().unwrap_or(0);
    let mut ext_stdout = ext_child
        .stdout
        .take()
        .ok_or("Failed to open extractor stdout")?;

    let task = tokio::spawn(async move {
        let mut splitter = PngSplitter::new();
        let mut buf = vec![0u8; 262_144];

        loop {
            if sync.cancel.load(Ordering::SeqCst) {
                break;
            }
            while sync.written.load(Ordering::SeqCst).saturating_sub(sync.released.load(Ordering::SeqCst)) > sync.max_ahead {
                if sync.cancel.load(Ordering::SeqCst) {
                    break;
                }
                tokio::select! {
                    _ = sync.notify_capacity.notified() => {},
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(50)) => {}
                }
            }

            match ext_stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    splitter.push(&buf[..n], |img| {
                        let idx = sync.written.fetch_add(1, Ordering::SeqCst);
                        let file_name = format!("{:08}.png", idx + 1);
                        let _ = std::fs::write(sync.pool.join(file_name), &img);
                        sync.notify_waiters.notify_waiters();
                    });
                }
                Err(e) => {
                    let mut lock = sync.failed.lock().await;
                    *lock = Some(format!("Extractor read error: {}", e));
                    break;
                }
            }
        }
        sync.ended.store(true, Ordering::SeqCst);
        sync.notify_waiters.notify_waiters();
    });

    Ok(ExtractorHandle {
        child: ext_child,
        pid: ext_pid,
        task,
    })
}

pub async fn check_hwaccel_support(ffmpeg: &str, file: &str, scale_in: &str, tmp: &Path) -> bool {
    let sw_path = tmp.join("test-sw.png");
    let hw_path = tmp.join("test-hw.png");

    let mut sw_cmd = tokio::process::Command::new(ffmpeg);
    sw_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-ss",
        "0",
        "-i",
        file,
        "-vframes",
        "1",
        "-vf",
        scale_in,
        "-c:v",
        "png",
        "-compression_level",
        "0",
    ]);
    sw_cmd.arg(&sw_path);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        sw_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let sw_ok = match sw_cmd.status().await {
        Ok(s) => s.success() && sw_path.exists(),
        Err(_) => false,
    };
    if !sw_ok {
        let _ = std::fs::remove_file(&sw_path);
        return false;
    }

    let mut hw_cmd = tokio::process::Command::new(ffmpeg);
    hw_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-hwaccel",
        "auto",
        "-ss",
        "0",
        "-i",
        file,
        "-vframes",
        "1",
        "-vf",
        scale_in,
        "-c:v",
        "png",
        "-compression_level",
        "0",
    ]);
    hw_cmd.arg(&hw_path);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        hw_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let hw_ok = match hw_cmd.status().await {
        Ok(s) => s.success() && hw_path.exists(),
        Err(_) => false,
    };
    if !hw_ok {
        let _ = std::fs::remove_file(&sw_path);
        let _ = std::fs::remove_file(&hw_path);
        return false;
    }

    let mut ssim_cmd = tokio::process::Command::new(ffmpeg);
    ssim_cmd.args([
        "-v",
        "error",
        "-i",
        &hw_path.to_string_lossy(),
        "-i",
        &sw_path.to_string_lossy(),
        "-filter_complex",
        "[0:v][1:v]ssim=stats_file=-",
        "-f",
        "null",
        "-",
    ]);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        ssim_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let ssim_res = ssim_cmd.output().await;
    let _ = std::fs::remove_file(&sw_path);
    let _ = std::fs::remove_file(&hw_path);

    if let Ok(out) = ssim_res {
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(pos) = s.find("All:") {
            let rest = &s[pos + 4..];
            let val_str = rest.split_whitespace().next().unwrap_or("0");
            let ssim_val = val_str.parse::<f64>().unwrap_or(0.0);
            return ssim_val > 0.999;
        }
    }
    false
}

pub async fn run_pipeline<F>(
    cfg: PipelineConfig,
    job: JobRequest,
    emit: F,
    cancel: Arc<AtomicBool>,
) -> JobFinished
where
    F: Fn(JobProgressEvent) + Send + Sync + 'static,
{
    let t0 = Instant::now();
    let procs = Arc::new(ActiveProcesses::new());

    let temp_root = resolve_temp_root(job.temp_root.as_deref(), &job.output);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir_name = format!("tween-{}-{}", std::process::id(), timestamp);
    let tmp = temp_root.join(dir_name);
    if let Err(e) = std::fs::create_dir_all(&tmp) {
        return JobFinished {
            ok: false,
            error: Some(format!("Failed to create temp directory: {}", e)),
            ..Default::default()
        };
    }

    let emit = Arc::new(emit);
    let cancel_watchdog = cancel.clone();
    let procs_watchdog = procs.clone();
    let watchdog = tokio::spawn(async move {
        while !cancel_watchdog.load(Ordering::SeqCst) {
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }
        procs_watchdog.kill_all().await;
    });

    let result = run_internal(
        &cfg,
        &job,
        &tmp,
        emit.clone(),
        cancel.clone(),
        procs.clone(),
        t0,
    )
    .await;

    watchdog.abort();
    procs.kill_all().await;

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&job.output);
        for _ in 0..50 {
            if std::fs::remove_dir_all(&tmp).is_ok() || !tmp.exists() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
        return JobFinished {
            ok: false,
            cancelled: Some(true),
            ..Default::default()
        };
    }

    let tmp_cleanup = tmp.clone();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        let _ = std::fs::remove_dir_all(&tmp_cleanup);
        if let Some(parent) = tmp_cleanup.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some(".tween-temp") {
                let _ = std::fs::remove_dir(parent);
            }
        }
    });

    match result {
        Ok(finished) => finished,
        Err(e) => JobFinished {
            ok: false,
            error: Some(e),
            ..Default::default()
        },
    }
}

static STREAM_SELF_TEST_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub async fn check_stream_engine_supported(cfg: &PipelineConfig) -> bool {
    let cache_key = format!("{:?}_{:?}", cfg.rife_dir, cfg.rife_stream_cmd);
    if let Ok(lock) = STREAM_SELF_TEST_CACHE.lock() {
        if let Some(&res) = lock.get(&cache_key) {
            return res;
        }
    }

    let has_stream = if let Some(cmd) = &cfg.rife_stream_cmd {
        !cmd.is_empty()
    } else {
        let stream_exe = rife_stream_exe(Path::new(&cfg.rife_dir));
        stream_exe.exists()
    };

    if !has_stream {
        if let Ok(mut lock) = STREAM_SELF_TEST_CACHE.lock() {
            lock.insert(cache_key, false);
        }
        return false;
    }

    let passed = run_stream_self_test_internal(cfg).await;
    if let Ok(mut lock) = STREAM_SELF_TEST_CACHE.lock() {
        lock.insert(cache_key, passed);
    }
    passed
}

async fn run_stream_self_test_internal(cfg: &PipelineConfig) -> bool {
    let tmp = std::env::temp_dir().join(format!("tween-stream-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    if std::fs::create_dir_all(&tmp).is_err() {
        return false;
    }

    let res = run_stream_self_test_work(cfg, &tmp).await;
    let _ = std::fs::remove_dir_all(&tmp);
    res
}

async fn run_stream_self_test_work(cfg: &PipelineConfig, tmp: &Path) -> bool {
    let w = 64usize;
    let h = 64usize;
    let frame_bytes = w * h * 3;
    let mut input_bytes = Vec::with_capacity(5 * frame_bytes);

    for f in 0..5 {
        let mut frame = vec![0u8; frame_bytes];
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) * 3;
                frame[idx] = ((x * 4 + f * 50) % 256) as u8;
                frame[idx + 1] = ((y * 4 + f * 35) % 256) as u8;
                frame[idx + 2] = (((x + y) * 2 + f * 45) % 256) as u8;
            }
        }
        input_bytes.extend_from_slice(&frame);
    }

    let times = build_frame_times(5, 10, &HashSet::new());
    let times_path = tmp.join("selftest_times.dat");
    if tokio::fs::write(&times_path, serialize_frame_times(&times)).await.is_err() {
        return false;
    }

    let rife_dir_path = PathBuf::from(&cfg.rife_dir);
    let model_path = rife_dir_path.join("rife-v4.26");
    let (stream_bin, stream_pre) = if let Some(rc) = &cfg.rife_stream_cmd {
        if !rc.is_empty() {
            (rc[0].clone(), rc[1..].to_vec())
        } else {
            (rife_stream_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
        }
    } else {
        (rife_stream_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
    };

    let mut stream_cmd = tokio::process::Command::new(&stream_bin);
    stream_cmd.args(&stream_pre);
    stream_cmd.args([
        "--stream",
        times_path.to_str().unwrap(),
        "-w",
        "64",
        "-h",
        "64",
        "-m",
        model_path.to_str().unwrap(),
        "-g",
        "0",
        "-j",
        "1:1:1",
    ]);
    if rife_dir_path.exists() {
        stream_cmd.current_dir(&rife_dir_path);
    }
    stream_cmd.stdin(std::process::Stdio::piped());
    stream_cmd.stdout(std::process::Stdio::piped());
    stream_cmd.stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        stream_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut stream_child = match stream_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };

    if let Some(mut stdin) = stream_child.stdin.take() {
        let input_copy = input_bytes.clone();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input_copy).await;
            let _ = stdin.flush().await;
        });
    }

    let mut stream_out_bytes = Vec::new();
    if let Some(mut stdout) = stream_child.stdout.take() {
        if stdout.read_to_end(&mut stream_out_bytes).await.is_err() {
            return false;
        }
    }

    let stream_status = match stream_child.wait().await {
        Ok(s) => s,
        Err(_) => return false,
    };
    if !stream_status.success() || stream_out_bytes.len() != 10 * frame_bytes {
        return false;
    }

    let in_dir = tmp.join("in");
    let out_dir = tmp.join("out");
    if std::fs::create_dir_all(&in_dir).is_err() || std::fs::create_dir_all(&out_dir).is_err() {
        return false;
    }

    let mut ff_png_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    ff_png_cmd.args([
        "-y",
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        "64x64",
        "-i",
        "-",
        in_dir.join("%08d.png").to_str().unwrap(),
    ]);
    ff_png_cmd.stdin(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        ff_png_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut ff_png_child = match ff_png_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let Some(mut stdin) = ff_png_child.stdin.take() {
        let input_copy = input_bytes.clone();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input_copy).await;
            let _ = stdin.flush().await;
        });
    }
    let png_status = match ff_png_child.wait().await {
        Ok(s) => s,
        Err(_) => return false,
    };
    if !png_status.success() {
        return false;
    }

    let (file_bin, file_pre) = if let Some(rc) = &cfg.rife_cmd {
        if !rc.is_empty() {
            (rc[0].clone(), rc[1..].to_vec())
        } else {
            (rife_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
        }
    } else {
        (rife_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
    };

    let mut file_cmd = tokio::process::Command::new(&file_bin);
    file_cmd.args(&file_pre);
    file_cmd.args([
        "-i",
        in_dir.to_str().unwrap(),
        "-o",
        out_dir.to_str().unwrap(),
        "-m",
        model_path.to_str().unwrap(),
        "-n",
        "10",
        "-g",
        "0",
        "-j",
        "1:1:1",
    ]);
    if rife_dir_path.exists() {
        file_cmd.current_dir(&rife_dir_path);
    }
    file_cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        file_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut file_child = match file_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let f_status = match file_child.wait().await {
        Ok(s) => s,
        Err(_) => return false,
    };
    if !f_status.success() {
        return false;
    }

    let mut ff_read_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    ff_read_cmd.args([
        "-v",
        "error",
        "-i",
        out_dir.join("%08d.png").to_str().unwrap(),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]);
    ff_read_cmd.stdout(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        ff_read_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut ff_read_child = match ff_read_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut file_out_bytes = Vec::new();
    if let Some(mut stdout) = ff_read_child.stdout.take() {
        if stdout.read_to_end(&mut file_out_bytes).await.is_err() {
            return false;
        }
    }
    let r_status = match ff_read_child.wait().await {
        Ok(s) => s,
        Err(_) => return false,
    };
    if !r_status.success() || file_out_bytes.len() != 10 * frame_bytes {
        return false;
    }

    for i in 0..10 {
        let stream_frame = &stream_out_bytes[i * frame_bytes..(i + 1) * frame_bytes];
        let file_frame = &file_out_bytes[i * frame_bytes..(i + 1) * frame_bytes];

        if i % 2 == 0 {
            if stream_frame != file_frame {
                return false;
            }
        } else {
            let ssim = calculate_ssim(stream_frame, file_frame, w, h);
            if ssim < 0.995 {
                return false;
            }
        }
    }

    true
}

async fn run_stream_pipeline<F>(
    cfg: &PipelineConfig,
    job: &JobRequest,
    tmp: &Path,
    emit: Arc<F>,
    cancel: Arc<AtomicBool>,
    procs: Arc<ActiveProcesses>,
    t0: Instant,
) -> Result<JobFinished, String>
where
    F: Fn(JobProgressEvent) + Send + Sync + 'static,
{
    let info = &job.info;
    let r = ratio(info, &job.target);

    let model_id = if !job.model.is_empty() && (cfg.models.is_empty() || cfg.models.contains(&job.model)) {
        &job.model
    } else if let Some(first_cfg) = cfg.models.first() {
        first_cfg
    } else {
        MODELS[0].id
    };

    let enc_id = if !job.encoder.is_empty() && (cfg.encoders.is_empty() || cfg.encoders.contains(&job.encoder)) {
        &job.encoder
    } else if let Some(first_enc) = cfg.encoders.first() {
        first_enc
    } else {
        "libx264"
    };
    let enc = get_encoder(enc_id);

    let col = if !info.colour.matrix.is_empty() {
        info.colour.clone()
    } else {
        colour_of(&ColourInput {
            height: info.height,
            ..Default::default()
        })
    };

    let trim_args: Vec<String> = if let Some(trim) = &job.trim {
        vec![
            "-ss".to_string(),
            trim.start.to_string(),
            "-to".to_string(),
            trim.end.to_string(),
        ]
    } else {
        Vec::new()
    };

    let scale_in = format!(
        "scale=in_color_matrix={}:in_range={}:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24",
        col.matrix, col.range
    );

    let t_analyse = Instant::now();
    emit(JobProgressEvent {
        stage: "analyse".into(),
        pct: Some(0.0),
        done: None,
        total: None,
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    let scenes_file = "scenes.txt";
    let thr = job.scene_threshold.unwrap_or(10.0);
    let vf = if job.scene_detect == Some(false) {
        "scale=-2:144".to_string()
    } else {
        format!(
            "scale=-2:270,scdet=threshold={},metadata=mode=print:key=lavfi.scd.time:file={}",
            thr, scenes_file
        )
    };

    let mut an_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    an_cmd.args(["-v", "error"]);
    an_cmd.args(&trim_args);
    an_cmd.args([
        "-i",
        &info.file,
        "-vf",
        &vf,
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "null",
        "-",
    ]);
    an_cmd.current_dir(tmp);
    an_cmd.stdout(std::process::Stdio::piped());
    an_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        an_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut an_child = an_cmd
        .spawn()
        .map_err(|e| format!("Failed to start analysis: {}", e))?;
    let an_pid = an_child.id().unwrap_or(0);
    procs.add(an_pid).await;

    let mut count = 0usize;
    if let Some(mut stdout) = an_child.stdout.take() {
        let emit_clone = emit.clone();
        let info_frames = info.frames;
        let mut buf = [0u8; 4096];
        let mut text = String::new();
        while let Ok(n) = stdout.read(&mut buf).await {
            if n == 0 {
                break;
            }
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(pos) = text.find('\n') {
                let line = text[..pos].trim();
                if let Some(stripped) = line.strip_prefix("frame=") {
                    if let Ok(c) = stripped.trim().parse::<usize>() {
                        count = c;
                        let pct = (c as f64) / (info_frames.max(1) as f64);
                        emit_clone(JobProgressEvent {
                            stage: "analyse".into(),
                            pct: Some(pct.min(1.0)),
                            done: None,
                            total: None,
                            speed: None,
                            eta: None,
                            preview: None,
                            note: None,
                        });
                    }
                }
                text.drain(..pos + 1);
            }
        }
    }

    let an_status = an_child
        .wait()
        .await
        .map_err(|e| format!("Analysis process error: {}", e))?;
    procs.remove(an_pid).await;

    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }

    if !an_status.success() {
        let mut err_str = String::new();
        if let Some(mut stderr) = an_child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Analysis failed (exit {}).\n{}", an_status, err_str));
    }

    let mut cuts = HashSet::new();
    let scenes_path = tmp.join(scenes_file);
    if let Ok(scenes_content) = std::fs::read_to_string(&scenes_path) {
        for line in scenes_content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("frame:") {
                let frame_str = rest.split_whitespace().next().unwrap_or("");
                if let Ok(f) = frame_str.parse::<usize>() {
                    cuts.insert(f);
                }
            }
        }
    }

    if count < 2 {
        return Err("The video has fewer than two frames.".into());
    }

    let analyse_elapsed_ms = t_analyse.elapsed().as_millis() as u64;
    let total = ((count as f64) * (r.p as f64) / (r.q as f64)).round() as usize;

    let times = build_frame_times(count, total, &cuts);
    let times_path = tmp.join("times.dat");
    tokio::fs::write(&times_path, serialize_frame_times(&times))
        .await
        .map_err(|e| format!("Failed to write times file: {}", e))?;

    let mut dec_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    dec_cmd.args(["-y", "-v", "error"]);
    dec_cmd.args(&trim_args);
    dec_cmd.args(["-i", &info.file]);
    dec_cmd.args(["-an", "-sn"]);
    dec_cmd.args(["-vf", &scale_in]);
    dec_cmd.args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    dec_cmd.stdout(std::process::Stdio::piped());
    dec_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        dec_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut dec_child = dec_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn decoder: {}", e))?;
    let dec_pid = dec_child.id().unwrap_or(0);
    procs.add(dec_pid).await;
    let mut dec_stdout = dec_child.stdout.take().ok_or("Failed to open decoder stdout")?;

    let gpu = match (&cfg.mode[..], &cfg.gpu) {
        ("gpu", Some(g)) => g.id.to_string(),
        _ => "-1".to_string(),
    };
    let cpu_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let is_gpu = cfg.mode == "gpu";
    let is_integrated = cfg
        .gpu
        .as_ref()
        .map(|g| g.integrated)
        .unwrap_or(true);
    let initial_jobs = rife_threads(cpu_threads, is_gpu, is_integrated);

    let rife_dir_path = PathBuf::from(&cfg.rife_dir);
    let model_path = rife_dir_path.join(model_id);
    let (rife_bin, pre_args) = if let Some(rc) = &cfg.rife_stream_cmd {
        if !rc.is_empty() {
            (rc[0].clone(), rc[1..].to_vec())
        } else {
            (rife_stream_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
        }
    } else {
        (rife_stream_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
    };

    let mut rife_cmd = tokio::process::Command::new(&rife_bin);
    rife_cmd.args(&pre_args);
    rife_cmd.args([
        "--stream",
        times_path.to_str().unwrap(),
        "-w",
        &info.width.to_string(),
        "-h",
        &info.height.to_string(),
        "-m",
        model_path.to_str().unwrap(),
        "-g",
        &gpu,
        "-j",
        &initial_jobs,
    ]);
    if info.width * info.height > 2560 * 1440 {
        rife_cmd.arg("-u");
    }
    if job.tta.unwrap_or(false) {
        rife_cmd.arg("-x");
    }
    if rife_dir_path.exists() {
        rife_cmd.current_dir(&rife_dir_path);
    }
    rife_cmd.stdin(std::process::Stdio::piped());
    rife_cmd.stdout(std::process::Stdio::piped());
    rife_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        rife_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut rife_child = rife_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn RIFE stream: {}", e))?;
    let rife_pid = rife_child.id().unwrap_or(0);
    procs.add(rife_pid).await;
    let mut rife_stdin = rife_child.stdin.take().ok_or("Failed to open RIFE stdin")?;
    let mut rife_stdout = rife_child.stdout.take().ok_or("Failed to open RIFE stdout")?;

    let is_mp4_mov = {
        let lower = job.output.to_lowercase();
        lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".m4v")
    };
    let audio = job.keep_audio.unwrap_or(true) && info.has_audio;

    let mut ff_args = vec![
        "-y".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-s".to_string(),
        format!("{}x{}", info.width, info.height),
        "-framerate".to_string(),
        r.out_fps_expr.clone(),
        "-i".to_string(),
        "-".to_string(),
    ];

    ff_args.extend(trim_args.clone());
    ff_args.push("-i".to_string());
    ff_args.push(info.file.clone());
    ff_args.push("-map".to_string());
    ff_args.push("0:v:0".to_string());

    if audio {
        let copyable = job.trim.is_none()
            && is_mp4_mov
            && matches!(
                info.audio_codec.as_deref(),
                Some("aac" | "mp3" | "ac3" | "eac3" | "alac" | "opus" | "flac")
            );
        ff_args.push("-map".to_string());
        ff_args.push("1:a:0?".to_string());
        if copyable {
            ff_args.push("-c:a".to_string());
            ff_args.push("copy".to_string());
        } else {
            ff_args.push("-c:a".to_string());
            ff_args.push("aac".to_string());
            ff_args.push("-b:a".to_string());
            ff_args.push("256k".to_string());
        }
    }

    let out_vf = format!(
        "scale=out_color_matrix={}:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format={}",
        col.matrix, enc.fmt
    );

    ff_args.push("-map_metadata".to_string());
    ff_args.push("1".to_string());
    ff_args.push("-map_chapters".to_string());
    ff_args.push("-1".to_string());
    ff_args.push("-vf".to_string());
    ff_args.push(out_vf);

    ff_args.extend(enc.args(job.quality.unwrap_or(18)));

    ff_args.push("-colorspace".to_string());
    ff_args.push(col.space.clone());
    ff_args.push("-color_primaries".to_string());
    ff_args.push(col.primaries.clone());
    ff_args.push("-color_trc".to_string());
    ff_args.push(col.trc.clone());
    ff_args.push("-color_range".to_string());
    ff_args.push("tv".to_string());

    ff_args.push("-fps_mode".to_string());
    ff_args.push("cfr".to_string());
    ff_args.push("-t".to_string());
    ff_args.push(format!("{:.6}", total as f64 / r.out_fps));

    if is_mp4_mov {
        ff_args.push("-movflags".to_string());
        ff_args.push("+faststart".to_string());
    }

    if let Some(parent) = std::path::Path::new(&job.output).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    ff_args.push(job.output.clone());

    let mut enc_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    enc_cmd.args(&ff_args);
    enc_cmd.stdin(std::process::Stdio::piped());
    enc_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        enc_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut enc_child = enc_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn encoder: {}", e))?;
    let enc_pid = enc_child.id().unwrap_or(0);
    procs.add(enc_pid).await;
    let mut enc_stdin = enc_child.stdin.take().ok_or("Failed to open encoder stdin")?;

    emit(JobProgressEvent {
        stage: "interpolate".into(),
        pct: Some(0.0),
        done: Some(0),
        total: Some(total as u64),
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    let cancel_pipe = cancel.clone();
    let pipe_dec_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if cancel_pipe.load(Ordering::SeqCst) {
                break;
            }
            let n = match dec_stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => return Err(format!("Decoder read error: {}", e)),
            };
            if let Err(e) = rife_stdin.write_all(&buf[..n]).await {
                return Err(format!("RIFE stdin write error: {}", e));
            }
        }
        let _ = rife_stdin.flush().await;
        drop(rife_stdin);
        Ok::<(), String>(())
    });

    let frame_bytes = (info.width as usize) * (info.height as usize) * 3;
    let emit_interp = emit.clone();
    let cancel_interp = cancel.clone();
    let t_interp = Instant::now();
    let total_f = total;

    let pipe_enc_task = tokio::spawn(async move {
        let mut frame_buf = vec![0u8; frame_bytes];
        let mut count_done = 0u64;

        while count_done < (total_f as u64) {
            if cancel_interp.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            match rife_stdout.read_exact(&mut frame_buf).await {
                Ok(_) => {
                    if let Err(e) = enc_stdin.write_all(&frame_buf).await {
                        return Err(format!("Encoder stdin write error: {}", e));
                    }
                    count_done += 1;

                    if count_done.is_multiple_of(4) || count_done == (total_f as u64) {
                        let el = t_interp.elapsed().as_secs_f64();
                        let speed = (count_done as f64) / el.max(0.001);
                        let eta = if speed > 0.0 {
                            Some(((total_f as u64).saturating_sub(count_done) as f64) / speed)
                        } else {
                            None
                        };
                        emit_interp(JobProgressEvent {
                            stage: "interpolate".into(),
                            pct: Some((count_done as f64) / (total_f as f64)),
                            done: Some(count_done),
                            total: Some(total_f as u64),
                            speed: Some(speed),
                            eta,
                            preview: None,
                            note: None,
                        });
                    }
                }
                Err(e) => {
                    if count_done == (total_f as u64) {
                        break;
                    }
                    return Err(format!(
                        "Interpolation stream finished prematurely (got {} of {} frames): {}",
                        count_done, total_f, e
                    ));
                }
            }
        }
        drop(enc_stdin);
        Ok::<u64, String>(count_done)
    });

    let dec_res = dec_child.wait().await;
    procs.remove(dec_pid).await;
    let rife_res = rife_child.wait().await;
    procs.remove(rife_pid).await;

    let pipe_dec_res = pipe_dec_task.await.map_err(|e| format!("Decoder pipe panic: {}", e))?;
    let pipe_enc_res = pipe_enc_task.await.map_err(|e| format!("Encoder pipe panic: {}", e))?;

    let enc_res = enc_child.wait().await;
    procs.remove(enc_pid).await;

    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }

    pipe_dec_res?;
    let encoded = pipe_enc_res?;

    let dec_status = dec_res.map_err(|e| format!("Decoder wait error: {}", e))?;
    if !dec_status.success() {
        return Err(format!("Decoder process failed with exit {}", dec_status));
    }

    let rife_status = rife_res.map_err(|e| format!("RIFE wait error: {}", e))?;
    if !rife_status.success() {
        return Err(format!("RIFE stream process failed with exit {}", rife_status));
    }

    let enc_status = enc_res.map_err(|e| format!("Encoder wait error: {}", e))?;
    if !enc_status.success() {
        return Err(format!("Encoder process failed with exit {}", enc_status));
    }

    let out_size = std::fs::metadata(&job.output).map(|m| m.len()).unwrap_or(0);
    let seconds = t0.elapsed().as_secs_f64();
    let interp_ms = t_interp.elapsed().as_millis() as u64;

    emit(JobProgressEvent {
        stage: "done".into(),
        pct: Some(1.0),
        done: Some(encoded),
        total: Some(total as u64),
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    Ok(JobFinished {
        ok: true,
        cancelled: None,
        error: None,
        output: Some(job.output.clone()),
        engine_mode: Some("stream".into()),
        seconds: Some(seconds),
        out_size: Some(out_size),
        frames: Some(encoded),
        cuts: Some(cuts.len()),
        peak_temp_bytes: Some(0),
        stage_times: Some(StageTimes {
            analyse_ms: analyse_elapsed_ms,
            extract_ms: 0,
            rife_ms: interp_ms,
            encode_ms: interp_ms,
        }),
    })
}

async fn run_internal<F>(
    cfg: &PipelineConfig,
    job: &JobRequest,
    tmp: &Path,
    emit: Arc<F>,
    cancel: Arc<AtomicBool>,
    procs: Arc<ActiveProcesses>,
    t0: Instant,
) -> Result<JobFinished, String>
where
    F: Fn(JobProgressEvent) + Send + Sync + 'static,
{
    let requested_mode = job
        .engine_mode
        .as_deref()
        .or(cfg.engine_mode.as_deref())
        .unwrap_or("file");

    if requested_mode == "stream" || requested_mode == "auto" {
        if check_stream_engine_supported(cfg).await {
            match run_stream_pipeline(cfg, job, tmp, emit.clone(), cancel.clone(), procs.clone(), t0).await {
                Ok(finished) => return Ok(finished),
                Err(e) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[runner] Stream engine failed ({}); falling back to file mode", e);
                    let _ = std::fs::remove_file(&job.output);
                    emit(JobProgressEvent {
                        stage: "interpolate".into(),
                        pct: None,
                        done: None,
                        total: None,
                        speed: None,
                        eta: None,
                        preview: None,
                        note: Some("Streaming mode failed; switched to file mode.".into()),
                    });
                }
            }
        } else if requested_mode == "stream" {
            #[cfg(debug_assertions)]
            eprintln!("[runner] Stream engine binary not installed or failed self-test; falling back to file mode");
        }
    }
    let info = &job.info;
    let r = ratio(info, &job.target);

    let model_id = if !job.model.is_empty() && (cfg.models.is_empty() || cfg.models.contains(&job.model)) {
        &job.model
    } else if let Some(first_cfg) = cfg.models.first() {
        first_cfg
    } else {
        MODELS[0].id
    };

    let enc_id = if !job.encoder.is_empty() && (cfg.encoders.is_empty() || cfg.encoders.contains(&job.encoder)) {
        &job.encoder
    } else if let Some(first_enc) = cfg.encoders.first() {
        first_enc
    } else {
        "libx264"
    };
    let enc = get_encoder(enc_id);

    let col = if !info.colour.matrix.is_empty() {
        info.colour.clone()
    } else {
        colour_of(&ColourInput {
            height: info.height,
            ..Default::default()
        })
    };

    let trim_args: Vec<String> = if let Some(trim) = &job.trim {
        vec![
            "-ss".to_string(),
            trim.start.to_string(),
            "-to".to_string(),
            trim.end.to_string(),
        ]
    } else {
        Vec::new()
    };

    let scale_in = format!(
        "scale=in_color_matrix={}:in_range={}:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24",
        col.matrix, col.range
    );

    // ---- 1. analyse: exact frame count + scene cuts, from a fast low-res decode
    let t_analyse = Instant::now();
    emit(JobProgressEvent {
        stage: "analyse".into(),
        pct: Some(0.0),
        done: None,
        total: None,
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    let scenes_file = "scenes.txt";
    let thr = job.scene_threshold.unwrap_or(10.0);
    let vf = if job.scene_detect == Some(false) {
        "scale=-2:144".to_string()
    } else {
        format!(
            "scale=-2:270,scdet=threshold={},metadata=mode=print:key=lavfi.scd.time:file={}",
            thr, scenes_file
        )
    };

    let mut an_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    an_cmd.args(["-v", "error"]);
    an_cmd.args(&trim_args);
    let (fps_flag, fps_val) = fps_mode_args(&cfg.ffmpeg, "passthrough");
    an_cmd.args([
        "-i",
        &info.file,
        "-map",
        "0:v:0",
        fps_flag,
        fps_val,
        "-an",
        "-sn",
        "-vf",
        &vf,
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "null",
        "-",
    ]);
    an_cmd.current_dir(tmp);
    an_cmd.stdout(std::process::Stdio::piped());
    an_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        an_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut an_child = an_cmd
        .spawn()
        .map_err(|e| format!("Failed to start analysis: {}", e))?;
    let an_pid = an_child.id().unwrap_or(0);
    procs.add(an_pid).await;

    let mut count = 0usize;
    if let Some(mut stdout) = an_child.stdout.take() {
        let emit_clone = emit.clone();
        let info_frames = info.frames;
        let mut buf = [0u8; 4096];
        let mut text = String::new();
        while let Ok(n) = stdout.read(&mut buf).await {
            if n == 0 {
                break;
            }
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(pos) = text.find('\n') {
                let line = text[..pos].trim();
                if let Some(stripped) = line.strip_prefix("frame=") {
                    if let Ok(c) = stripped.trim().parse::<usize>() {
                        count = c;
                        let pct = (c as f64) / (info_frames.max(1) as f64);
                        emit_clone(JobProgressEvent {
                            stage: "analyse".into(),
                            pct: Some(pct.min(1.0)),
                            done: None,
                            total: None,
                            speed: None,
                            eta: None,
                            preview: None,
                            note: None,
                        });
                    }
                }
                text.drain(..pos + 1);
            }
        }
    }

    let an_status = an_child
        .wait()
        .await
        .map_err(|e| format!("Analysis process error: {}", e))?;
    procs.remove(an_pid).await;

    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }

    if !an_status.success() {
        let mut err_str = String::new();
        if let Some(mut stderr) = an_child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Analysis failed (exit {}).\n{}", an_status, err_str));
    }

    let mut cuts = HashSet::new();
    let scenes_path = tmp.join(scenes_file);
    if let Ok(scenes_content) = std::fs::read_to_string(&scenes_path) {
        for line in scenes_content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("frame:") {
                let frame_str = rest.split_whitespace().next().unwrap_or("");
                if let Ok(f) = frame_str.parse::<usize>() {
                    cuts.insert(f);
                }
            }
        }
    }

    if count < 2 {
        return Err("The video has fewer than two frames.".into());
    }

    let analyse_elapsed_ms = t_analyse.elapsed().as_millis() as u64;
    let free_disk = crate::setup::free_disk_space(tmp);
    let plan = plan_chunks(
        count,
        r.p,
        r.q,
        job.chunk_frames
            .unwrap_or_else(|| chunk_size_with_disk(info.width, info.height, r.p, r.q, free_disk)),
    );
    let total = plan.total;

    // ---- 2. streaming extractor with back-pressure
    let pool = tmp.join("pool");
    std::fs::create_dir_all(&pool)
        .map_err(|e| format!("Failed to create pool dir: {}", e))?;

    let max_chunk_files = plan.chunks.iter().map(|c| c.files).max().unwrap_or(100);
    let max_ahead = max_chunk_files + 4;

    let written = Arc::new(AtomicUsize::new(0));
    let released = Arc::new(AtomicUsize::new(0));
    let notify_waiters = Arc::new(tokio::sync::Notify::new());
    let notify_capacity = Arc::new(tokio::sync::Notify::new());
    let extractor_ended = Arc::new(AtomicBool::new(false));
    let extractor_failed = Arc::new(Mutex::new(None::<String>));

    let mut use_hwaccel = check_hwaccel_support(&cfg.ffmpeg, &info.file, &scale_in, tmp).await;
    let t_extract = Instant::now();
    let sync = ExtractorSync {
        pool: pool.clone(),
        written: written.clone(),
        released: released.clone(),
        max_ahead,
        notify_waiters: notify_waiters.clone(),
        notify_capacity: notify_capacity.clone(),
        cancel: cancel.clone(),
        ended: extractor_ended.clone(),
        failed: extractor_failed.clone(),
    };
    let mut ext_handle = spawn_streaming_extractor(
        &cfg.ffmpeg,
        &info.file,
        &trim_args,
        &scale_in,
        use_hwaccel,
        sync.clone(),
    )?;
    procs.add(ext_handle.pid).await;

    // ---- 5. encoder (started now, fed as chunks finish)
    let is_mp4_mov = {
        let lower = job.output.to_lowercase();
        lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".m4v")
    };
    let audio = job.keep_audio.unwrap_or(true) && info.has_audio;

    let mut ff_args = vec![
        "-y".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-c:v".to_string(),
        "png".to_string(),
        "-framerate".to_string(),
        r.out_fps_expr.clone(),
        "-i".to_string(),
        "-".to_string(),
    ];

    ff_args.extend(trim_args.clone());
    ff_args.push("-i".to_string());
    ff_args.push(info.file.clone());
    ff_args.push("-map".to_string());
    ff_args.push("0:v:0".to_string());

    if audio {
        let copyable = job.trim.is_none()
            && is_mp4_mov
            && matches!(
                info.audio_codec.as_deref(),
                Some("aac" | "mp3" | "ac3" | "eac3" | "alac" | "opus" | "flac")
            );
        ff_args.push("-map".to_string());
        ff_args.push("1:a:0?".to_string());
        if copyable {
            ff_args.push("-c:a".to_string());
            ff_args.push("copy".to_string());
        } else {
            ff_args.push("-c:a".to_string());
            ff_args.push("aac".to_string());
            ff_args.push("-b:a".to_string());
            ff_args.push("256k".to_string());
        }
    }

    let out_vf = format!(
        "scale=out_color_matrix={}:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format={}",
        col.matrix, enc.fmt
    );

    ff_args.push("-map_metadata".to_string());
    ff_args.push("1".to_string());
    ff_args.push("-map_chapters".to_string());
    ff_args.push("-1".to_string());
    ff_args.push("-vf".to_string());
    ff_args.push(out_vf);

    ff_args.extend(enc.args(job.quality.unwrap_or(18)));

    ff_args.push("-colorspace".to_string());
    ff_args.push(col.space.clone());
    ff_args.push("-color_primaries".to_string());
    ff_args.push(col.primaries.clone());
    ff_args.push("-color_trc".to_string());
    ff_args.push(col.trc.clone());
    ff_args.push("-color_range".to_string());
    ff_args.push("tv".to_string());

    let (fps_flag, fps_val) = fps_mode_args(&cfg.ffmpeg, "cfr");
    ff_args.push(fps_flag.to_string());
    ff_args.push(fps_val.to_string());
    ff_args.push("-t".to_string());
    ff_args.push(format!("{:.6}", total as f64 / r.out_fps));

    if is_mp4_mov {
        ff_args.push("-movflags".to_string());
        ff_args.push("+faststart".to_string());
    }

    if let Some(parent) = std::path::Path::new(&job.output).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    ff_args.push(job.output.clone());

    let t_encode = Instant::now();
    let mut enc_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    enc_cmd.args(&ff_args);
    enc_cmd.stdin(std::process::Stdio::piped());
    enc_cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        enc_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut enc_child = enc_cmd
        .spawn()
        .map_err(|e| format!("Failed to start encoder: {}", e))?;
    let enc_pid = enc_child.id().unwrap_or(0);
    procs.add(enc_pid).await;

    let mut enc_stdin = enc_child.stdin.take().ok_or("Failed to open encoder stdin")?;

    // ---- 3/4. chunks through RIFE
    let gpu_arg = match (&cfg.mode[..], &cfg.gpu) {
        ("gpu", Some(g)) => g.id.to_string(),
        _ => "-1".to_string(),
    };

    let t_interpolate = Instant::now();
    let mut gpu = gpu_arg;

    emit(JobProgressEvent {
        stage: "interpolate".into(),
        pct: Some(0.0),
        done: Some(0),
        total: Some(total as u64),
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    struct FeedItem {
        cout: PathBuf,
        cin: PathBuf,
        keep: usize,
        out_offset: usize,
    }

    let (feed_tx, mut feed_rx) = tokio::sync::mpsc::channel::<FeedItem>(4);

    let cancel_feed = cancel.clone();
    let feed_task = tokio::spawn(async move {
        let mut count_encoded = 0u64;
        while let Some(item) = feed_rx.recv().await {
            if cancel_feed.load(Ordering::SeqCst) {
                break;
            }
            for i in 0..item.keep {
                let file_path = item.cout.join(format!("{:08}.png", i + 1));
                let data = match tokio::fs::read(&file_path).await {
                    Ok(d) => d,
                    Err(_) => {
                        return Err(format!(
                            "Interpolation skipped frame {}.",
                            item.out_offset + i + 1
                        ));
                    }
                };
                if let Err(e) = enc_stdin.write_all(&data).await {
                    return Err(format!("Encoder write error: {}", e));
                }
                let _ = tokio::fs::remove_file(&file_path).await;
                count_encoded += 1;
            }
            let _ = tokio::fs::remove_dir_all(&item.cin).await;
            let _ = tokio::fs::remove_dir_all(&item.cout).await;
        }
        drop(enc_stdin);
        Ok::<u64, String>(count_encoded)
    });

    let mut rife_total_ms = 0u128;
    let mut cut_fix_total_ms = 0u128;
    let peak_temp_bytes = Arc::new(AtomicU64::new(0));
    peak_temp_bytes.fetch_max(dir_size(tmp), Ordering::Relaxed);

    for ci in 0..plan.chunks.len() {
        let ch = &plan.chunks[ci];
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }

        // Wait until extractor has written up to ch.a + ch.files - 1
        let target_idx = ch.a + ch.files - 1;
        while written.load(Ordering::SeqCst) <= target_idx && !extractor_ended.load(Ordering::SeqCst) {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            if let Some(err) = extractor_failed.lock().await.clone() {
                if use_hwaccel {
                    use_hwaccel = false;
                    procs.remove(ext_handle.pid).await;
                    kill_tree(ext_handle.pid);
                    ext_handle.task.abort();
                    *extractor_failed.lock().await = None;
                    extractor_ended.store(false, Ordering::SeqCst);
                    written.store(0, Ordering::SeqCst);
                    released.store(0, Ordering::SeqCst);
                    let _ = std::fs::remove_dir_all(&pool);
                    let _ = std::fs::create_dir_all(&pool);
                    ext_handle = spawn_streaming_extractor(
                        &cfg.ffmpeg,
                        &info.file,
                        &trim_args,
                        &scale_in,
                        false,
                        sync.clone(),
                    )?;
                    procs.add(ext_handle.pid).await;
                    continue;
                }
                return Err(err);
            }
            tokio::select! {
                _ = notify_waiters.notified() => {},
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(50)) => {}
            }
        }

        if written.load(Ordering::SeqCst) <= target_idx && extractor_ended.load(Ordering::SeqCst) && use_hwaccel {
            use_hwaccel = false;
            procs.remove(ext_handle.pid).await;
            kill_tree(ext_handle.pid);
            ext_handle.task.abort();
            *extractor_failed.lock().await = None;
            extractor_ended.store(false, Ordering::SeqCst);
            written.store(0, Ordering::SeqCst);
            released.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_dir_all(&pool);
            let _ = std::fs::create_dir_all(&pool);
            ext_handle = spawn_streaming_extractor(
                &cfg.ffmpeg,
                &info.file,
                &trim_args,
                &scale_in,
                false,
                sync.clone(),
            )?;
            procs.add(ext_handle.pid).await;
            continue;
        }

        let cin = tmp.join(format!("c{}-in", ci));
        let cout = tmp.join(format!("c{}-out", ci));
        std::fs::create_dir_all(&cin).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&cout).map_err(|e| e.to_string())?;

        let current_written = written.load(Ordering::SeqCst);
        let have = std::cmp::min(ch.files, current_written.saturating_sub(ch.a));

        for i in 0..have {
            let src = pool.join(format!("{:08}.png", ch.a + i + 1));
            let dst = cin.join(format!("{:08}.png", i + 1));
            if std::fs::hard_link(&src, &dst).is_err() {
                let _ = std::fs::copy(&src, &dst);
            }
        }

        let files = have;
        let n = if files == ch.files {
            ch.n
        } else {
            std::cmp::max(files, ((files as f64) * (r.p as f64) / (r.q as f64)).round() as usize)
        };
        let keep = if files == ch.files { ch.keep } else { n };

        let run_rife = |g: String, jobs: String| {
            let cin_clone = cin.clone();
            let cout_clone = cout.clone();
            let tmp_ticker = tmp.to_path_buf();
            let peak_disk_clone = peak_temp_bytes.clone();
            let rife_dir_path = PathBuf::from(&cfg.rife_dir);
            let model_path = rife_dir_path.join(model_id);
            let rife_cmd_cfg = cfg.rife_cmd.clone();
            let width = info.width;
            let height = info.height;
            let tta = job.tta.unwrap_or(false);
            let procs_clone = procs.clone();
            let emit_clone = emit.clone();
            let total_f = total;
            let ch_out_offset = ch.out_offset;
            let t_interp = t_interpolate;

            async move {
                let mut args = vec![
                    "-i".to_string(),
                    cin_clone.to_string_lossy().to_string(),
                    "-o".to_string(),
                    cout_clone.to_string_lossy().to_string(),
                    "-m".to_string(),
                    model_path.to_string_lossy().to_string(),
                    "-n".to_string(),
                    n.to_string(),
                    "-f".to_string(),
                    "%08d.png".to_string(),
                    "-g".to_string(),
                    g,
                    "-j".to_string(),
                    jobs,
                ];
                if width * height > 2560 * 1440 {
                    args.push("-u".to_string());
                }
                if tta {
                    args.push("-x".to_string());
                }

                let (cmd_bin, pre_args) = if let Some(rc) = &rife_cmd_cfg {
                    if !rc.is_empty() {
                        (rc[0].clone(), rc[1..].to_vec())
                    } else {
                        (rife_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
                    }
                } else {
                    (rife_exe(&rife_dir_path).to_string_lossy().to_string(), Vec::new())
                };

                let mut rife_cmd = tokio::process::Command::new(&cmd_bin);
                rife_cmd.args(&pre_args);
                rife_cmd.args(&args);
                if rife_dir_path.exists() {
                    rife_cmd.current_dir(&rife_dir_path);
                }
                rife_cmd.stderr(std::process::Stdio::piped());

                #[cfg(target_os = "windows")]
                {
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    rife_cmd.creation_flags(CREATE_NO_WINDOW);
                }

                let mut rife_child = rife_cmd
                    .spawn()
                    .map_err(|e| format!("Interpolation failed to spawn: {}", e))?;
                let r_pid = rife_child.id().unwrap_or(0);
                procs_clone.add(r_pid).await;

                let stop_ticker = Arc::new(AtomicBool::new(false));
                let stop_ticker_clone = stop_ticker.clone();
                let cout_ticker = cout_clone.clone();

                let ticker = tokio::spawn(async move {
                    while !stop_ticker_clone.load(Ordering::SeqCst) {
                        tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;
                        if stop_ticker_clone.load(Ordering::SeqCst) {
                            break;
                        }
                        let cur_d = dir_size(&tmp_ticker);
                        peak_disk_clone.fetch_max(cur_d, Ordering::Relaxed);
                        let d = std::fs::read_dir(&cout_ticker)
                            .map(|entries| entries.count())
                            .unwrap_or(0);
                        let done = std::cmp::min(total_f, ch_out_offset + std::cmp::min(d, keep));
                        let el = t_interp.elapsed().as_secs_f64();
                        let speed = (done as f64) / el.max(0.001);
                        let eta = if speed > 0.0 {
                            Some(((total_f.saturating_sub(done)) as f64) / speed)
                        } else {
                            None
                        };
                        let preview = if d > 2 {
                            let prev_idx = std::cmp::min(d, keep).saturating_sub(2);
                            Some(
                                cout_ticker
                                    .join(format!("{:08}.png", prev_idx))
                                    .to_string_lossy()
                                    .to_string(),
                            )
                        } else {
                            None
                        };

                        emit_clone(JobProgressEvent {
                            stage: "interpolate".into(),
                            pct: Some((done as f64) / (total_f as f64)),
                            done: Some(done as u64),
                            total: Some(total_f as u64),
                            speed: Some(speed),
                            eta,
                            preview,
                            note: None,
                        });
                    }
                });

                let status = rife_child.wait().await;
                stop_ticker.store(true, Ordering::SeqCst);
                let _ = ticker.await;
                procs_clone.remove(r_pid).await;

                let exit_status = status.map_err(|e| format!("RIFE wait error: {}", e))?;
                if !exit_status.success() {
                    let mut err_str = String::new();
                    if let Some(mut stderr) = rife_child.stderr.take() {
                        let _ = stderr.read_to_string(&mut err_str).await;
                    }
                    return Err(format!("Interpolation failed (exit {}).\n{}", exit_status, err_str));
                }
                Ok(())
            }
        };

        let t_rife_chunk = Instant::now();
        let cpu_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let is_gpu = cfg.mode == "gpu";
        let is_integrated = cfg
            .gpu
            .as_ref()
            .map(|g| g.integrated)
            .unwrap_or(true);
        let initial_jobs = rife_threads(cpu_threads, is_gpu, is_integrated);
        let rife_res = run_rife(gpu.clone(), initial_jobs).await;

        if let Err(e1) = rife_res {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let _ = std::fs::remove_dir_all(&cout);
            let _ = std::fs::create_dir_all(&cout);

            let retry1 = run_rife(gpu.clone(), "1:1:1".to_string()).await;
            if let Err(e2) = retry1 {
                if cancel.load(Ordering::SeqCst) || gpu == "-1" {
                    return Err(e2);
                }
                gpu = "-1".to_string();
                emit(JobProgressEvent {
                    stage: "interpolate".into(),
                    pct: None,
                    done: None,
                    total: None,
                    speed: None,
                    eta: None,
                    preview: None,
                    note: Some(
                        "The GPU failed on this video, so Tween switched to the CPU. This will be slower."
                            .into(),
                    ),
                });
                let _ = std::fs::remove_dir_all(&cout);
                let _ = std::fs::create_dir_all(&cout);

                run_rife(gpu.clone(), "1:1:1".to_string())
                    .await
                    .map_err(|_| e1)?;
            }
        }
        rife_total_ms += t_rife_chunk.elapsed().as_millis();

        // replace frames that would blend across a scene cut
        let t_cut = Instant::now();
        let fixes = cut_fixes(
            &super::types::Chunk {
                a: ch.a,
                files,
                n,
                keep,
                out_offset: ch.out_offset,
            },
            &cuts,
        );
        for f in fixes {
            let src_f = cin.join(format!("{:08}.png", f.src + 1));
            let dst_f = cout.join(format!("{:08}.png", f.i + 1));
            let _ = std::fs::copy(&src_f, &dst_f);
        }
        cut_fix_total_ms += t_cut.elapsed().as_millis();

        // hand this chunk to the encoder feed queue
        feed_tx
            .send(FeedItem {
                cout: cout.clone(),
                cin: cin.clone(),
                keep,
                out_offset: ch.out_offset,
            })
            .await
            .map_err(|e| format!("Failed to queue chunk for encoder: {}", e))?;

        let next_a = if ci + 1 < plan.chunks.len() {
            plan.chunks[ci + 1].a
        } else {
            count
        };
        // Release extractor frames up to next_a
        let old_rel = released.load(Ordering::SeqCst);
        for i in old_rel..next_a {
            let _ = std::fs::remove_file(pool.join(format!("{:08}.png", i + 1)));
        }
        released.store(std::cmp::max(old_rel, next_a), Ordering::SeqCst);
        notify_capacity.notify_one();
    }

    drop(feed_tx);
    let encoded = feed_task
        .await
        .map_err(|e| format!("Feed task panicked: {}", e))??;

    emit(JobProgressEvent {
        stage: "encode".into(),
        pct: Some(0.99),
        done: Some(encoded),
        total: Some(total as u64),
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    let enc_status = enc_child
        .wait()
        .await
        .map_err(|e| format!("Encoder wait error: {}", e))?;
    procs.remove(enc_pid).await;
    let encode_elapsed_ms = t_encode.elapsed().as_millis() as u64;

    if !enc_status.success() {
        let mut err_str = String::new();
        if let Some(mut stderr) = enc_child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Encoding failed (exit {}).\n{}", enc_status, err_str));
    }

    let _ = ext_handle.task.await;
    let ext_status = ext_handle
        .child
        .wait()
        .await
        .map_err(|e| format!("Extractor wait error: {}", e))?;
    procs.remove(ext_handle.pid).await;
    let extract_elapsed_ms = t_extract.elapsed().as_millis() as u64;

    if !ext_status.success() && !extractor_ended.load(Ordering::SeqCst) {
        let mut err_str = String::new();
        if let Some(mut stderr) = ext_handle.child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Frame extraction failed (exit {}).\n{}", ext_status, err_str));
    }

    let out_size = std::fs::metadata(&job.output)
        .map(|m| m.len())
        .unwrap_or(0);
    let seconds = t0.elapsed().as_secs_f64();

    peak_temp_bytes.fetch_max(dir_size(tmp), Ordering::Relaxed);

    #[cfg(debug_assertions)]
    println!(
        "[pipeline measurement] analyse: {}ms, rife_total: {}ms, cut_fixes: {}ms, total: {:.2}s, fps: {:.2}",
        analyse_elapsed_ms,
        rife_total_ms,
        cut_fix_total_ms,
        seconds,
        (encoded as f64) / seconds.max(0.001)
    );
    let _ = cut_fix_total_ms;

    let finished = JobFinished {
        ok: true,
        cancelled: None,
        error: None,
        output: Some(job.output.clone()),
        engine_mode: Some("file".into()),
        seconds: Some(seconds),
        out_size: Some(out_size),
        frames: Some(encoded),
        cuts: Some(cuts.len()),
        peak_temp_bytes: Some(peak_temp_bytes.load(Ordering::Relaxed)),
        stage_times: Some(StageTimes {
            analyse_ms: analyse_elapsed_ms,
            extract_ms: extract_elapsed_ms,
            rife_ms: rife_total_ms as u64,
            encode_ms: encode_elapsed_ms,
        }),
    };

    emit(JobProgressEvent {
        stage: "done".into(),
        pct: Some(1.0),
        done: Some(encoded),
        total: Some(total as u64),
        speed: None,
        eta: None,
        preview: None,
        note: None,
    });

    Ok(finished)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ffmpeg_version() {
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers"),
            Some((4, 4))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 4.4 Copyright (c) 2000-2021 the FFmpeg developers"),
            Some((4, 4))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 5.0.1 Copyright (c) 2000-2022 the FFmpeg developers"),
            Some((5, 0))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 5.1 Copyright (c) 2000-2022 the FFmpeg developers"),
            Some((5, 1))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 5.1.2-0ubuntu1 Copyright (c) 2000-2022 the FFmpeg developers"),
            Some((5, 1))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 6.0-full_build-www.gyan.dev"),
            Some((6, 0))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 7.1-essentials_build-www.gyan.dev"),
            Some((7, 1))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version n5.1-1-g0ef854"),
            Some((5, 1))
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 2024-03-24-git-b778c1c5fa"),
            Some((2024, 3))
        );
    }

    #[test]
    fn test_version_supports_fps_mode() {
        // FFmpeg 4.4.2 (Ubuntu 22.04 LTS apt) does NOT support -fps_mode
        assert!(!version_supports_fps_mode(
            "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers"
        ));
        assert!(!version_supports_fps_mode(
            "ffmpeg version 4.4 Copyright (c) 2000-2021 the FFmpeg developers"
        ));
        assert!(!version_supports_fps_mode(
            "ffmpeg version 5.0-1 Copyright (c) 2000-2022 the FFmpeg developers"
        ));

        // FFmpeg 5.1+ supports -fps_mode
        assert!(version_supports_fps_mode(
            "ffmpeg version 5.1.2-0ubuntu1 Copyright (c) 2000-2022 the FFmpeg developers"
        ));
        assert!(version_supports_fps_mode(
            "ffmpeg version 6.0-full_build-www.gyan.dev"
        ));
        assert!(version_supports_fps_mode(
            "ffmpeg version 7.1-essentials_build-www.gyan.dev"
        ));
        assert!(version_supports_fps_mode(
            "ffmpeg version 2024-03-24-git-b778c1c5fa-full_build"
        ));
        assert!(version_supports_fps_mode(
            "ffmpeg version N-112345-g89714859"
        ));
    }

    #[test]
    fn test_fps_mode_arg_selection() {
        // When -fps_mode is supported (FFmpeg >= 5.1)
        assert_eq!(
            fps_mode_args_for_support(true, "passthrough"),
            ("-fps_mode", "passthrough")
        );
        assert_eq!(
            fps_mode_args_for_support(true, "cfr"),
            ("-fps_mode", "cfr")
        );
        assert_eq!(
            fps_mode_args_for_support(true, "vfr"),
            ("-fps_mode", "vfr")
        );

        // When -fps_mode is NOT supported (FFmpeg 4.4 on Ubuntu 22.04)
        // Pipeline must fallback to -vsync cfr / vfr / passthrough
        assert_eq!(
            fps_mode_args_for_support(false, "passthrough"),
            ("-vsync", "passthrough")
        );
        assert_eq!(
            fps_mode_args_for_support(false, "cfr"),
            ("-vsync", "cfr")
        );
        assert_eq!(
            fps_mode_args_for_support(false, "vfr"),
            ("-vsync", "vfr")
        );
    }

    #[test]
    fn test_cached_fps_mode_support() {
        // Test manual cache insertion and lookup
        {
            let mut map = FPS_MODE_SUPPORT.lock().unwrap();
            map.insert("mock-ffmpeg-4.4".into(), false);
            map.insert("mock-ffmpeg-7.1".into(), true);
        }

        assert_eq!(
            fps_mode_args("mock-ffmpeg-4.4", "passthrough"),
            ("-vsync", "passthrough")
        );
        assert_eq!(
            fps_mode_args("mock-ffmpeg-4.4", "cfr"),
            ("-vsync", "cfr")
        );
        assert_eq!(
            fps_mode_args("mock-ffmpeg-7.1", "passthrough"),
            ("-fps_mode", "passthrough")
        );
        assert_eq!(
            fps_mode_args("mock-ffmpeg-7.1", "cfr"),
            ("-fps_mode", "cfr")
        );
    }
}
