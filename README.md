# Tween

A desktop app that raises a video's frame rate (for example 24 to 48 or 60 fps) by generating the frames in between. It runs on your own GPU with [RIFE](https://github.com/nihui/rife-ncnn-vulkan) (`rife-ncnn-vulkan`) and FFmpeg. Your videos never leave your device.

> Status: early prototype. The UI is being designed in HTML mocks first (`design/`); the Electron app in `src/` is a working-in-progress pipeline.

## Requirements

- Windows with a Vulkan-capable GPU
- [Node.js](https://nodejs.org) 20+
- [FFmpeg](https://ffmpeg.org) on your `PATH`
- The RIFE engine (not included in this repo, see below)

## Set up the RIFE engine

1. Download a Windows release of `rife-ncnn-vulkan` from <https://github.com/nihui/rife-ncnn-vulkan/releases>.
2. Extract it so that `engine/rife/rife-ncnn-vulkan.exe` exists, with the model folders (`rife-v4.6`, and so on) beside it.

## Run

```
npm install
npm start
```

## Design

Open any file in `design/` in a browser. The current one is `design/app-design-v7-onboarding-v3.html`. Use the bar at the bottom to switch between the Welcome, Open, Ready, Processing and Done screens.

## Licence

MIT. RIFE and `rife-ncnn-vulkan` are MIT-licensed by their authors and are downloaded separately.
