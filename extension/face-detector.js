// VisionGuard - face-detector.js (v2: ONNX Runtime Web, replaces TF.js/BlazeFace)
//
// WHY THIS FILE EXISTS: Manifest V3 extensions block `eval`/`new Function()`
// via CSP (script-src 'self', with no 'unsafe-eval' override possible).
// TensorFlow.js internally relies on `new Function()` for tensor indexing,
// so it cannot run in an extension page at all - this is a hard platform
// limitation, not a bug in our code. ONNX Runtime Web's WASM backend does
// NOT need JS eval (WASM execution is allowed under MV3's default
// 'wasm-unsafe-eval' CSP directive), so it works where TF.js cannot.
//
// Model: UltraFace version-slim-320 (Linzaer/Ultra-Light-Fast-Generic-
// Face-Detector-1MB) - a ~1.2MB ONNX face detector, purpose-built for
// exactly this "lightweight, local" use case.

let ortSession = null;

// Point ONNX Runtime Web at our locally bundled WASM files (not a CDN -
// required for MV3, and keeps everything on-device per the PS).
ort.env.wasm.wasmPaths = "lib/";
ort.env.wasm.numThreads = 1; // avoid needing SharedArrayBuffer/cross-origin isolation

async function loadFaceModel() {
  if (ortSession) return ortSession;
  console.log("[VisionGuard] loading UltraFace ONNX model...");
  ortSession = await ort.InferenceSession.create("models/version-slim-320.onnx");
  console.log("[VisionGuard] UltraFace model ready");
  return ortSession;
}

// UltraFace expects a 320x240 RGB image, normalized to [-1, 1].
function preprocess(imageElement) {
  const modelWidth = 320;
  const modelHeight = 240;

  const canvas = document.createElement("canvas");
  canvas.width = modelWidth;
  canvas.height = modelHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageElement, 0, 0, modelWidth, modelHeight);

  const { data } = ctx.getImageData(0, 0, modelWidth, modelHeight);

  // HWC RGBA -> CHW RGB, normalized to [-1, 1]
  const floatData = new Float32Array(3 * modelHeight * modelWidth);
  const plane = modelHeight * modelWidth;
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4] / 128.0 - 1.0;
    const g = data[i * 4 + 1] / 128.0 - 1.0;
    const b = data[i * 4 + 2] / 128.0 - 1.0;
    floatData[i] = r;
    floatData[plane + i] = g;
    floatData[2 * plane + i] = b;
  }

  return new ort.Tensor("float32", floatData, [1, 3, modelHeight, modelWidth]);
}

// Simple IoU-based non-max suppression to drop overlapping duplicate boxes.
function nms(boxes, scores, iouThreshold = 0.5) {
  const indices = scores
    .map((s, i) => i)
    .sort((a, b) => scores[b] - scores[a]);

  const keep = [];
  const suppressed = new Set();

  for (const i of indices) {
    if (suppressed.has(i)) continue;
    keep.push(i);
    for (const j of indices) {
      if (j === i || suppressed.has(j)) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed.add(j);
    }
  }
  return keep;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return interArea / (areaA + areaB - interArea);
}

/**
 * Runs face detection on an HTMLImageElement. Returns results in the same
 * shape dom-detector.js produces, in the ORIGINAL image's pixel space
 * (device pixels - same space as the screenshot canvas):
 *   { category: "face", x, y, width, height }
 */
async function detectFaces(imageElement) {
  const session = await loadFaceModel();
  const inputTensor = preprocess(imageElement);

  const feeds = { input: inputTensor };
  const results = await session.run(feeds);

  // UltraFace outputs: "scores" [1, N, 2] (background, face) and
  // "boxes" [1, N, 4] (x1, y1, x2, y2) normalized to [0, 1]
  const scoresData = results.scores.data;
  const boxesData = results.boxes.data;
  const numBoxes = results.boxes.dims[1];

  const CONFIDENCE_THRESHOLD = 0.7;
  const candidateBoxes = [];
  const candidateScores = [];

  for (let i = 0; i < numBoxes; i++) {
    const faceScore = scoresData[i * 2 + 1]; // index 1 = "face" class
    if (faceScore > CONFIDENCE_THRESHOLD) {
      candidateBoxes.push([
        boxesData[i * 4],
        boxesData[i * 4 + 1],
        boxesData[i * 4 + 2],
        boxesData[i * 4 + 3],
      ]);
      candidateScores.push(faceScore);
    }
  }

  const keepIndices = nms(candidateBoxes, candidateScores);

  const origWidth = imageElement.naturalWidth || imageElement.width;
  const origHeight = imageElement.naturalHeight || imageElement.height;

  return keepIndices.map((i) => {
    const [x1, y1, x2, y2] = candidateBoxes[i];
    return {
      category: "face",
      x: Math.round(x1 * origWidth),
      y: Math.round(y1 * origHeight),
      width: Math.round((x2 - x1) * origWidth),
      height: Math.round((y2 - y1) * origHeight),
    };
  });
}