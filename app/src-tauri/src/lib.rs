pub mod pipeline;
pub mod remotezip;
pub mod setup;

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pipeline::PipelineState::new())
        .invoke_handler(tauri::generate_handler![
            app_version,
            setup::setup_run,
            setup::setup_config,
            setup::open_url,
            pipeline::probe_video,
            pipeline::extract_frame,
            pipeline::pick_video_file,
            pipeline::pick_output_folder,
            pipeline::start_job,
            pipeline::cancel_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
