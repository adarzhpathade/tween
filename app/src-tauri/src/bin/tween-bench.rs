use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::SystemTime;
use tween_lib::pipeline::{
    probe, rife_exe, run_pipeline, GpuConfig, JobFinished, JobProgressEvent, JobRequest,
    PipelineConfig, Target, TargetValue,
};

fn format_timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Convert epoch seconds to date-time components
    let seconds_per_day = 86400;
    let days = (now / seconds_per_day) as i64;
    let rem_seconds = (now % seconds_per_day) as u32;

    let hour = rem_seconds / 3600;
    let minute = (rem_seconds % 3600) / 60;
    let second = rem_seconds % 60;

    // Days since 1970-01-01 to Y-M-D (civil date algorithm)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}Z",
        y, m, d, hour, minute, second
    )
}

fn locate_setup_config() -> Option<(PipelineConfig, String)> {
    if std::env::var("TWEEN_FORCE_NO_SETUP").is_ok() {
        return None;
    }

    let mut candidates = Vec::new();

    if let Ok(setup_dir) = std::env::var("TWEEN_SETUP_DIR") {
        candidates.push(PathBuf::from(setup_dir));
    }

    if let Some(data) = dirs::data_dir() {
        candidates.push(data.join("app.tween.desktop"));
        candidates.push(data.join("Tween"));
        candidates.push(data.join("com.adarshpathade.tween"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("out").join("smoke"));
        candidates.push(cwd.join("engine"));
        let mut curr = cwd.as_path();
        while let Some(parent) = curr.parent() {
            candidates.push(parent.join("out").join("smoke"));
            candidates.push(parent.join("engine"));
            curr = parent;
        }
    }

    for dir in candidates {
        let setup_file = dir.join("setup.json");
        if !setup_file.exists() {
            continue;
        }

        let content = match std::fs::read_to_string(&setup_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let val: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mode = val.get("mode").and_then(|m| m.as_str()).unwrap_or("");
        if mode != "gpu" {
            continue;
        }

        let gpu_val = match val.get("gpu") {
            Some(g) if g.is_object() => g,
            _ => continue,
        };

        let gpu_id = gpu_val.get("id").and_then(|i| i.as_i64()).unwrap_or(0) as i32;
        let gpu_name = gpu_val
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("Unknown GPU")
            .to_string();
        let gpu_integrated = gpu_val
            .get("integrated")
            .and_then(|i| i.as_bool())
            .unwrap_or(false);

        let rife_dir_str = match val.get("rifeDir").and_then(|r| r.as_str()) {
            Some(r) => r,
            None => continue,
        };
        let rife_dir = PathBuf::from(rife_dir_str);
        if !rife_dir.exists() {
            continue;
        }

        let rife_bin = rife_exe(&rife_dir);
        if !rife_bin.exists() {
            continue;
        }

        let model_dir = rife_dir.join("rife-v4.26");
        if !model_dir.join("flownet.bin").exists() || !model_dir.join("flownet.param").exists() {
            continue;
        }

        let ffmpeg_str = val
            .get("ffmpeg")
            .and_then(|f| f.as_str())
            .unwrap_or("ffmpeg")
            .to_string();
        let ffprobe_str = val
            .get("ffprobe")
            .and_then(|f| f.as_str())
            .unwrap_or("ffprobe")
            .to_string();

        let encoders = val
            .get("encoders")
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| vec!["libx264".to_string()]);

        let models = val
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| vec!["rife-v4.26".to_string()]);

        let cfg = PipelineConfig {
            ffmpeg: ffmpeg_str,
            ffprobe: ffprobe_str,
            rife_dir: rife_dir.to_string_lossy().to_string(),
            mode: "gpu".to_string(),
            gpu: Some(GpuConfig {
                id: gpu_id,
                name: Some(gpu_name.clone()),
                integrated: gpu_integrated,
            }),
            encoders,
            models,
            rife_cmd: None,
        };

        return Some((cfg, gpu_name));
    }

    None
}

fn pick_encoder(cfg: &PipelineConfig) -> String {
    for pref in &[
        "hevc_nvenc",
        "h264_nvenc",
        "hevc_amf",
        "h264_amf",
        "hevc_qsv",
        "h264_qsv",
        "hevc_videotoolbox",
        "h264_videotoolbox",
    ] {
        if cfg.encoders.iter().any(|e| e == *pref) {
            return (*pref).to_string();
        }
    }
    cfg.encoders.first().cloned().unwrap_or_else(|| "libx264".to_string())
}

#[tokio::main]
async fn main() {
    let (cfg, gpu_name) = match locate_setup_config() {
        Some(c) => c,
        None => {
            eprintln!("no GPU engine installed");
            std::process::exit(1);
        }
    };

    let encoder = pick_encoder(&cfg);

    let temp_root = std::env::temp_dir();
    let unique_id = format!("tween-bench-{}", std::process::id());
    let bench_work = temp_root.join(&unique_id);
    let _ = std::fs::remove_dir_all(&bench_work);
    if let Err(e) = std::fs::create_dir_all(&bench_work) {
        eprintln!("Failed to create bench directory: {}", e);
        std::process::exit(1);
    }

    let clip_path = bench_work.join("bench-1080p-24fps-20s.mp4");
    println!("Generating benchmark test clip (1080p, 24 fps, 20 s)...");

    let gen_status = tokio::process::Command::new(&cfg.ffmpeg)
        .args([
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=24:duration=20",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=20",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            clip_path.to_str().unwrap(),
        ])
        .status()
        .await;

    match gen_status {
        Ok(s) if s.success() && clip_path.exists() => {}
        Ok(s) => {
            eprintln!("ffmpeg clip generation failed (exit: {})", s);
            let _ = std::fs::remove_dir_all(&bench_work);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed to spawn ffmpeg for clip generation: {}", e);
            let _ = std::fs::remove_dir_all(&bench_work);
            std::process::exit(1);
        }
    }

    let probe_info = match probe(&cfg, clip_path.to_str().unwrap()).await {
        Ok(info) => info,
        Err(e) => {
            eprintln!("Failed to probe generated test clip: {}", e);
            let _ = std::fs::remove_dir_all(&bench_work);
            std::process::exit(1);
        }
    };

    let out_path = bench_work.join("bench-output.mp4");
    let req = JobRequest {
        info: probe_info,
        target: Target {
            mode: "multiplier".to_string(),
            value: TargetValue::Number(2.0),
        },
        model: "rife-v4.26".to_string(),
        encoder: encoder.clone(),
        quality: Some(18),
        keep_audio: Some(true),
        output: out_path.to_string_lossy().to_string(),
        temp_root: Some(bench_work.to_string_lossy().to_string()),
        trim: None,
        scene_detect: Some(false),
        scene_threshold: None,
        tta: Some(false),
        chunk_frames: None,
        cfg: Some(cfg.clone()),
    };

    println!("Running GPU benchmark on {} with {}...", gpu_name, encoder);
    let cancel = Arc::new(AtomicBool::new(false));

    let emit = |evt: JobProgressEvent| {
        if let Some(pct) = evt.pct {
            print!(
                "\r[{:11}] {:>3.0}% (done: {}, total: {})    ",
                evt.stage,
                pct * 100.0,
                evt.done.unwrap_or(0),
                evt.total.unwrap_or(0)
            );
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    };

    let res: JobFinished = run_pipeline(cfg.clone(), req, emit, cancel).await;
    println!();

    if !res.ok {
        eprintln!(
            "Benchmark pipeline failed: {}",
            res.error.as_deref().unwrap_or("unknown error")
        );
        let _ = std::fs::remove_dir_all(&bench_work);
        std::process::exit(1);
    }

    let total_seconds = res.seconds.unwrap_or(1.0);
    let total_frames = res.frames.unwrap_or(960);
    let output_fps = (total_frames as f64) / total_seconds.max(0.001);
    let peak_disk_bytes = res.peak_temp_bytes.unwrap_or(0);
    let peak_disk_mb = (peak_disk_bytes as f64) / 1_048_576.0;

    let stage_times = res.stage_times.unwrap_or_default();
    let projected_10min_seconds = 28800.0 / output_fps.max(0.001);
    let projected_mins = (projected_10min_seconds / 60.0).round() as u64;

    let readme_row = format!(
        "| Speed update 1 (quick wins) | File, tuned | Smooth, 2× | **{:.1}** | ~{} min |",
        output_fps, projected_mins
    );

    println!();
    println!("==================================================");
    println!("              Tween GPU Benchmark                 ");
    println!("==================================================");
    println!("GPU:            {}", gpu_name);
    println!("Encoder:        {}", encoder);
    println!("Model:          RIFE v4.26 (Smooth @ 2×)");
    println!("Clip:           1920×1080 24 fps (20 s, 480 in -> {} out frames)", total_frames);
    println!();
    println!("Results:");
    println!("  Total time:     {:.2} s", total_seconds);
    println!("  Output speed:   {:.1} fps", output_fps);
    println!("  Peak temp disk: {:.1} MB", peak_disk_mb);
    println!();
    println!("Stage times:");
    println!("  Analyse:        {} ms", stage_times.analyse_ms);
    println!("  Extract:        {} ms", stage_times.extract_ms);
    println!("  RIFE:           {} ms", stage_times.rife_ms);
    println!("  Encode:         {} ms", stage_times.encode_ms);
    println!();
    println!("README table row:");
    println!("{}", readme_row);
    println!("==================================================");

    // Save JSON result to bench-results/<timestamp>.json
    let timestamp_str = format_timestamp();
    let mut bench_results_dir = PathBuf::from("bench-results");
    if !bench_results_dir.exists() {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate1 = cwd.join("bench-results");
            let candidate2 = cwd.join("..").join("bench-results");
            if candidate2.parent().map(|p| p.join("package.json").exists()).unwrap_or(false) {
                bench_results_dir = candidate2;
            } else {
                bench_results_dir = candidate1;
            }
        }
    }
    let _ = std::fs::create_dir_all(&bench_results_dir);
    let json_file = bench_results_dir.join(format!("{}.json", timestamp_str));

    let json_val = serde_json::json!({
        "timestamp": timestamp_str,
        "version": "0.1.0",
        "engineMode": "File, tuned",
        "job": "Smooth, 2×",
        "gpu": gpu_name,
        "encoder": encoder,
        "model": "rife-v4.26",
        "clip": {
            "width": 1920,
            "height": 1080,
            "fps": 24.0,
            "duration": 20.0,
            "framesIn": 480,
            "framesOut": total_frames
        },
        "results": {
            "totalSeconds": total_seconds,
            "outputFps": output_fps,
            "peakTempDiskBytes": peak_disk_bytes,
            "peakTempDiskMb": peak_disk_mb,
            "stageTimesMs": {
                "analyse": stage_times.analyse_ms,
                "extract": stage_times.extract_ms,
                "rife": stage_times.rife_ms,
                "encode": stage_times.encode_ms
            },
            "projected10MinMinutes": projected_mins
        },
        "readmeRow": readme_row
    });

    if let Ok(json_text) = serde_json::to_string_pretty(&json_val) {
        if std::fs::write(&json_file, json_text).is_ok() {
            println!("Saved benchmark result to: {}", json_file.display());
        }
    }

    let _ = std::fs::remove_dir_all(&bench_work);
}
