import { analyzeRgbFrame } from "./nightVisionDetector";

async function testNightVisionDetector() {
  // Test 1: Pure grayscale frame (simulating night vision / IR mode)
  // 32x18 = 576 pixels => 1728 bytes
  const grayBuffer = Buffer.alloc(1728);
  for (let i = 0; i < grayBuffer.length; i += 3) {
    grayBuffer[i] = 120; // R
    grayBuffer[i + 1] = 120; // G
    grayBuffer[i + 2] = 120; // B
  }

  const grayResult = analyzeRgbFrame(grayBuffer, 6.0);
  if (!grayResult.isDark) {
    throw new Error("Expected grayscale frame to be detected as dark");
  }
  if (grayResult.colorDiff !== 0) {
    throw new Error(`Expected colorDiff 0, got ${grayResult.colorDiff}`);
  }
  console.log("✓ Grayscale night vision test passed");

  // Test 2: Color frame (simulating daytime color image)
  const colorBuffer = Buffer.alloc(1728);
  for (let i = 0; i < colorBuffer.length; i += 3) {
    colorBuffer[i] = 200; // R (high red)
    colorBuffer[i + 1] = 100; // G
    colorBuffer[i + 2] = 50; // B
  }

  const colorResult = analyzeRgbFrame(colorBuffer, 6.0);
  if (colorResult.isDark) {
    throw new Error("Expected color frame to NOT be detected as dark");
  }
  if (colorResult.colorDiff <= 6.0) {
    throw new Error(
      `Expected colorDiff > 6.0, got ${colorResult.colorDiff}`
    );
  }
  console.log("✓ Color daytime test passed");

  // Test 3: Pitch black frame (luminance near 0)
  const blackBuffer = Buffer.alloc(1728, 2);
  const blackResult = analyzeRgbFrame(blackBuffer, 6.0);
  if (!blackResult.isDark) {
    throw new Error("Expected pitch black frame to be detected as dark");
  }
  console.log("✓ Pitch black frame test passed");

  // Test 4: Empty buffer
  const emptyResult = analyzeRgbFrame(Buffer.alloc(0));
  if (emptyResult.isDark) {
    throw new Error("Expected empty buffer fallback to not dark");
  }
  console.log("✓ Empty buffer test passed");
}

void testNightVisionDetector();
