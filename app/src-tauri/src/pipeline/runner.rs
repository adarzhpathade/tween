use super::encoders::get_encoder;
use super::models::{rife_exe, MODELS};
use super::plan::{chunk_size, cut_fixes, plan_chunks, ratio};
use super::probe::colour_of;
use super::splitter::PngSplitter;
use super::types::{
    ColourInput, JobFinished, JobProgressEvent, JobRequest, PipelineConfig,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

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

    let temp_root = match &job.temp_root {
        Some(r) => PathBuf::from(r),
        None => std::env::temp_dir(),
    };
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
    an_cmd.args([
        "-i",
        &info.file,
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
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

    let analyse_elapsed_ms = t_analyse.elapsed().as_millis();
    let plan = plan_chunks(
        count,
        r.p,
        r.q,
        job.chunk_frames
            .unwrap_or_else(|| chunk_size(info.width, info.height, r.p, r.q)),
    );
    let total = plan.total;

    // ---- 2. streaming extractor with back-pressure
    let pool = tmp.join("pool");
    std::fs::create_dir_all(&pool)
        .map_err(|e| format!("Failed to create pool dir: {}", e))?;

    let max_chunk_files = plan.chunks.iter().map(|c| c.files).max().unwrap_or(100);
    let max_ahead = max_chunk_files * 2 + 4;

    let written = Arc::new(AtomicUsize::new(0));
    let released = Arc::new(AtomicUsize::new(0));
    let notify_waiters = Arc::new(tokio::sync::Notify::new());
    let notify_capacity = Arc::new(tokio::sync::Notify::new());
    let extractor_ended = Arc::new(AtomicBool::new(false));
    let extractor_failed = Arc::new(Mutex::new(None::<String>));

    let mut ext_cmd = tokio::process::Command::new(&cfg.ffmpeg);
    ext_cmd.args(["-v", "error"]);
    ext_cmd.args(&trim_args);
    ext_cmd.args([
        "-i",
        &info.file,
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
        "-an",
        "-sn",
        "-vf",
        &scale_in,
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-compression_level",
        "2",
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
    procs.add(ext_pid).await;

    let mut ext_stdout = ext_child.stdout.take().ok_or("Failed to open extractor stdout")?;
    let pool_clone = pool.clone();
    let written_clone = written.clone();
    let released_clone = released.clone();
    let notify_waiters_clone = notify_waiters.clone();
    let notify_capacity_clone = notify_capacity.clone();
    let cancel_clone = cancel.clone();
    let ended_clone = extractor_ended.clone();

    let failed_clone = extractor_failed.clone();

    let extractor_task = tokio::spawn(async move {
        let mut splitter = PngSplitter::new();
        let mut buf = vec![0u8; 65536];

        loop {
            if cancel_clone.load(Ordering::SeqCst) {
                break;
            }
            while written_clone.load(Ordering::SeqCst).saturating_sub(released_clone.load(Ordering::SeqCst)) > max_ahead {
                if cancel_clone.load(Ordering::SeqCst) {
                    break;
                }
                tokio::select! {
                    _ = notify_capacity_clone.notified() => {},
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(50)) => {}
                }
            }

            match ext_stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    splitter.push(&buf[..n], |img| {
                        let idx = written_clone.fetch_add(1, Ordering::SeqCst);
                        let file_name = format!("{:08}.png", idx + 1);
                        let _ = std::fs::write(pool_clone.join(file_name), &img);
                        notify_waiters_clone.notify_waiters();
                    });
                }
                Err(e) => {
                    let mut lock = failed_clone.lock().await;
                    *lock = Some(format!("Extractor read error: {}", e));
                    break;
                }
            }
        }
        ended_clone.store(true, Ordering::SeqCst);
        notify_waiters_clone.notify_waiters();
    });

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
        .map_err(|e| format!("Failed to start encoder: {}", e))?;
    let enc_pid = enc_child.id().unwrap_or(0);
    procs.add(enc_pid).await;

    let mut enc_stdin = enc_child.stdin.take().ok_or("Failed to open encoder stdin")?;

    // ---- 3/4. chunks through RIFE
    let gpu_arg = match (&cfg.mode[..], &cfg.gpu) {
        ("gpu", Some(g)) => g.id.to_string(),
        _ => "-1".to_string(),
    };
    let light = cfg.mode != "gpu"
        || cfg
            .gpu
            .as_ref()
            .map(|g| g.integrated)
            .unwrap_or(true);

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
                return Err(err);
            }
            tokio::select! {
                _ = notify_waiters.notified() => {},
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(50)) => {}
            }
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
        let initial_jobs = if light { "1:1:1" } else { "2:2:2" };
        let rife_res = run_rife(gpu.clone(), initial_jobs.to_string()).await;

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

    if !enc_status.success() {
        let mut err_str = String::new();
        if let Some(mut stderr) = enc_child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Encoding failed (exit {}).\n{}", enc_status, err_str));
    }

    let _ = extractor_task.await;
    let ext_status = ext_child
        .wait()
        .await
        .map_err(|e| format!("Extractor wait error: {}", e))?;
    procs.remove(ext_pid).await;

    if !ext_status.success() && !extractor_ended.load(Ordering::SeqCst) {
        let mut err_str = String::new();
        if let Some(mut stderr) = ext_child.stderr.take() {
            let _ = stderr.read_to_string(&mut err_str).await;
        }
        return Err(format!("Frame extraction failed (exit {}).\n{}", ext_status, err_str));
    }

    let out_size = std::fs::metadata(&job.output)
        .map(|m| m.len())
        .unwrap_or(0);
    let seconds = t0.elapsed().as_secs_f64();

    #[cfg(debug_assertions)]
    println!(
        "[pipeline measurement] analyse: {}ms, rife_total: {}ms, cut_fixes: {}ms, total: {:.2}s, fps: {:.2}",
        analyse_elapsed_ms,
        rife_total_ms,
        cut_fix_total_ms,
        seconds,
        (encoded as f64) / seconds.max(0.001)
    );

    let finished = JobFinished {
        ok: true,
        cancelled: None,
        error: None,
        output: Some(job.output.clone()),
        seconds: Some(seconds),
        out_size: Some(out_size),
        frames: Some(encoded),
        cuts: Some(cuts.len()),
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
