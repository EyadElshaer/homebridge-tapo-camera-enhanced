import { Readable } from "stream";
import { parseFragmentedMP4, readLength } from "./mp4Parser";

async function testReadLength() {
  const data = Buffer.from("Hello World, Fragmented MP4 test!");
  const stream = Readable.from([data.subarray(0, 5), data.subarray(5)]);

  const chunk1 = await readLength(stream, 5);
  if (chunk1.toString() !== "Hello") {
    throw new Error(`Expected 'Hello', got '${chunk1.toString()}'`);
  }

  const chunk2 = await readLength(stream, 6);
  if (chunk2.toString() !== " World") {
    throw new Error(`Expected ' World', got '${chunk2.toString()}'`);
  }

  console.log("✓ readLength passed");
}

async function testParseFragmentedMP4() {
  // Helper to create an MP4 box
  const makeBox = (type: string, payload: string) => {
    const payloadBuf = Buffer.from(payload);
    const len = payloadBuf.length + 8;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(len, 0);
    header.write(type, 4, 4, "latin1");
    return Buffer.concat([header, payloadBuf]);
  };

  const ftypBox = makeBox("ftyp", "isomiso2avc1mp41");
  const moovBox = makeBox("moov", "moov_data_here");
  const moofBox = makeBox("moof", "moof_fragment_metadata");
  const mdatBox = makeBox("mdat", "mdat_video_payload_bytes");

  const fullStream = Buffer.concat([ftypBox, moovBox, moofBox, mdatBox]);
  const readable = Readable.from([
    fullStream.subarray(0, 10),
    fullStream.subarray(10, 30),
    fullStream.subarray(30),
  ]);

  const parsedBoxes: { type: string; length: number; data: string }[] = [];
  for await (const box of parseFragmentedMP4(readable)) {
    parsedBoxes.push({
      type: box.type,
      length: box.length,
      data: box.data.toString(),
    });
  }

  if (parsedBoxes.length !== 4) {
    throw new Error(`Expected 4 boxes, got ${parsedBoxes.length}`);
  }

  if (parsedBoxes[0].type !== "ftyp" || parsedBoxes[0].data !== "isomiso2avc1mp41") {
    throw new Error("ftyp box mismatch");
  }

  if (parsedBoxes[1].type !== "moov" || parsedBoxes[1].data !== "moov_data_here") {
    throw new Error("moov box mismatch");
  }

  if (parsedBoxes[2].type !== "moof" || parsedBoxes[2].data !== "moof_fragment_metadata") {
    throw new Error("moof box mismatch");
  }

  if (parsedBoxes[3].type !== "mdat" || parsedBoxes[3].data !== "mdat_video_payload_bytes") {
    throw new Error("mdat box mismatch");
  }

  console.log("✓ parseFragmentedMP4 passed");
}

async function testLargeAtoms() {
  const payloadSize = 300 * 1024; // 300KB
  const payloadBuf = Buffer.alloc(payloadSize, 0xaa);
  const len = payloadSize + 8;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(len, 0);
  header.write("mdat", 4, 4, "latin1");

  const fullAtom = Buffer.concat([header, payloadBuf]);

  // Break full atom into small 4KB chunks
  const chunks: Buffer[] = [];
  const chunkSize = 4096;
  for (let i = 0; i < fullAtom.length; i += chunkSize) {
    chunks.push(fullAtom.subarray(i, Math.min(i + chunkSize, fullAtom.length)));
  }

  const stream = Readable.from(chunks);
  const parsed: { type: string; length: number; dataLen: number }[] = [];

  for await (const box of parseFragmentedMP4(stream)) {
    parsed.push({
      type: box.type,
      length: box.length,
      dataLen: box.data.length,
    });
  }

  if (parsed.length !== 1 || parsed[0].type !== "mdat" || parsed[0].dataLen !== payloadSize) {
    throw new Error(`Large atom test failed: ${JSON.stringify(parsed)}`);
  }

  console.log("✓ testLargeAtoms passed");
}

async function runTests() {
  try {
    await testReadLength();
    await testParseFragmentedMP4();
    await testLargeAtoms();
    console.log("All MP4 parser tests passed successfully!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

runTests();

