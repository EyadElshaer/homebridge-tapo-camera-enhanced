import { Readable } from "stream";

export interface MP4Atom {
  header: Buffer;
  length: number;
  type: string;
  data: Buffer;
}

/**
 * Reads an exact number of bytes from a Node.js Readable stream.
 */
export async function readLength(
  readable: Readable,
  length: number
): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  return new Promise<Buffer>((resolve, reject) => {
    let finished = false;
    const buffers: Buffer[] = [];
    let accumulated = 0;

    const cleanup = () => {
      readable.removeListener("readable", onReadable);
      readable.removeListener("error", onError);
      readable.removeListener("end", onEnd);
      readable.removeListener("close", onClose);
    };

    const finish = (err: Error | null, result?: Buffer) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve(result || Buffer.alloc(0));
      }
    };

    const onReadable = () => {
      if (finished) return;
      try {
        while (accumulated < length) {
          const needed = length - accumulated;
          let chunk = readable.read(needed) as Buffer | null;
          if (!chunk) {
            chunk = readable.read() as Buffer | null;
          }
          if (!chunk) {
            break;
          }

          if (chunk.length > needed) {
            buffers.push(chunk.subarray(0, needed));
            accumulated += needed;
            readable.unshift(chunk.subarray(needed));
          } else {
            buffers.push(chunk);
            accumulated += chunk.length;
          }
        }

        if (accumulated >= length) {
          finish(null, Buffer.concat(buffers, accumulated));
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const onError = (err: Error) => {
      finish(err);
    };

    const onEnd = () => {
      if (accumulated === length) {
        finish(null, Buffer.concat(buffers, accumulated));
      } else {
        finish(new Error("Stream ended before required bytes were read"));
      }
    };

    const onClose = () => {
      if (accumulated === length) {
        finish(null, Buffer.concat(buffers, accumulated));
      } else {
        finish(new Error("Stream closed before required bytes were read"));
      }
    };

    readable.on("readable", onReadable);
    readable.on("error", onError);
    readable.on("end", onEnd);
    readable.on("close", onClose);

    // Drain any already available data
    onReadable();
  });
}

/**
 * Parses fragmented MP4 (fMP4) stream into MP4Atom boxes.
 */
export async function* parseFragmentedMP4(
  readable: Readable,
  timeout = 0
): AsyncGenerator<MP4Atom> {
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    if (timeout > 0) {
      timer = setTimeout(() => {
        readable.destroy(new Error("Timeout waiting for MP4 atom"));
      }, timeout);
    }

    try {
      let header: Buffer;
      try {
        header = await readLength(readable, 8);
      } catch {
        // Stream ended or closed
        break;
      }

      if (!header || header.length < 8) {
        break;
      }

      const length = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("latin1");

      let dataLength = length - 8;

      if (length === 1) {
        // 64-bit extended size box
        let extHeader: Buffer;
        try {
          extHeader = await readLength(readable, 8);
        } catch {
          break;
        }
        if (!extHeader || extHeader.length < 8) {
          break;
        }
        const bigLen = extHeader.readBigUInt64BE(0);
        dataLength = Number(bigLen) - 16;
        header = Buffer.concat([header, extHeader]);
      } else if (length === 0) {
        // Box continues until EOF
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of readable) {
            chunks.push(chunk as Buffer);
          }
        } catch {
          break;
        }
        const data = Buffer.concat(chunks);
        yield { header, length: header.length + data.length, type, data };
        break;
      }

      if (dataLength < 0) {
        break;
      }

      let data: Buffer;
      try {
        data = await readLength(readable, dataLength);
      } catch {
        break;
      }

      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      yield {
        header,
        length: header.length + data.length,
        type,
        data,
      };
    } catch {
      break;
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  }
}
