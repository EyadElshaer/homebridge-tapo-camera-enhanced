import { analyzeRgbFrame } from "./nightVisionDetector";

async function testNightVisionDetector() {
  // 1. Grayscale monochrome frame (IR Night Vision)
  const grayBuf = Buffer.alloc(6912);
  for (let i = 0; i < 6912; i += 3) {
    const val = 80;
    grayBuf[i] = val;
    grayBuf[i + 1] = val;
    grayBuf[i + 2] = val;
  }

  const grayState = analyzeRgbFrame(grayBuf, 6.0);
  if (!grayState.isDark) {
    throw new Error("Expected grayState.isDark to be true");
  }
  if (grayState.colorDiff !== 0) {
    throw new Error(`Expected colorDiff to be 0, got ${grayState.colorDiff}`);
  }
  if (grayState.ambientLux > 1.0 || grayState.ambientLux < 0.1) {
    throw new Error(`Expected ambientLux between 0.1 and 1.0, got ${grayState.ambientLux}`);
  }
  console.log("✓ Grayscale night vision test passed");

  // 2. Colored daytime frame
  const colorBuf = Buffer.alloc(6912);
  for (let i = 0; i < 6912; i += 3) {
    colorBuf[i] = 200; // Red
    colorBuf[i + 1] = 120; // Green
    colorBuf[i + 2] = 50; // Blue
  }

  const colorState = analyzeRgbFrame(colorBuf, 6.0);
  if (colorState.isDark) {
    throw new Error("Expected colorState.isDark to be false");
  }
  if (colorState.colorDiff <= 50) {
    throw new Error(`Expected colorDiff > 50, got ${colorState.colorDiff}`);
  }
  if (colorState.ambientLux < 50) {
    throw new Error(`Expected ambientLux >= 50, got ${colorState.ambientLux}`);
  }
  console.log("✓ Color daytime test passed");

  // 3. Pitch black frame (low luminance)
  const blackBuf = Buffer.alloc(6912);
  const blackState = analyzeRgbFrame(blackBuf, 6.0);
  if (!blackState.isDark) {
    throw new Error("Expected blackState.isDark to be true");
  }
  if (blackState.ambientLux !== 0.1) {
    throw new Error(`Expected ambientLux to be 0.1, got ${blackState.ambientLux}`);
  }
  console.log("✓ Pitch black frame test passed");

  // 4. Empty buffer handling
  const emptyBuf = Buffer.alloc(0);
  const emptyState = analyzeRgbFrame(emptyBuf);
  if (emptyState.isDark) {
    throw new Error("Expected emptyState.isDark to be false");
  }
  console.log("✓ Empty buffer test passed");
}

void testNightVisionDetector();
