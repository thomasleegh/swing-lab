# Third-party files

- `vision_bundle.mjs`, `wasm/*`: MediaPipe Tasks Vision 0.10.14 (npm `@mediapipe/tasks-vision`), © Google LLC, Apache License 2.0.
- `../../models/pose_landmarker_full.task`: MediaPipe Pose Landmarker (full, float16), © Google LLC, Apache License 2.0.
  Byte-identical structure to Google's published model (pose_detector.tflite + pose_landmarks_detector.tflite).

Bundled so the app works offline and never depends on a third-party CDN.
