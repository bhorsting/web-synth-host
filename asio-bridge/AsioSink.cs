using System;
using System.IO;
using NAudio.Wave;

class FloatCircularBuffer {
    private readonly float[] buffer;
    private int writePos = 0;
    private int readPos = 0;
    private int availableFloats = 0;
    private readonly object lockObj = new object();

    private int targetCushionFrames = 256;
    private int maxAllowedFrames = 512;
    private int preRollFrames = 256;
    private bool isBuffering = true;

    // Default capacity: 32768 floats = 16384 stereo frames (~341 ms @ 48kHz)
    public FloatCircularBuffer(int capacityFloats = 32768) {
        buffer = new float[capacityFloats];
    }

    public void ConfigureCushion(int hwBufferFrames) {
        lock (lockObj) {
            // Target cushion: at least 256 frames (~5.33ms), or 2x hardware buffer
            targetCushionFrames = Math.Max(256, hwBufferFrames * 2);
            // Clamp threshold: trim oldest backlog if buffer exceeds cushion + 2x hw buffer
            maxAllowedFrames = targetCushionFrames + Math.Max(256, hwBufferFrames * 2);
            preRollFrames = targetCushionFrames;
            isBuffering = true;
        }
    }

    public void Write(float[] src, int srcFloatOffset, int floatCount) {
        if (floatCount <= 0) return;
        // Strict stereo frame alignment (even number of floats)
        int validFloats = (floatCount / 2) * 2;
        if (validFloats <= 0) return;

        lock (lockObj) {
            int spaceToEnd = buffer.Length - writePos;
            if (validFloats <= spaceToEnd) {
                Array.Copy(src, srcFloatOffset, buffer, writePos, validFloats);
                writePos = (writePos + validFloats) % buffer.Length;
            } else {
                Array.Copy(src, srcFloatOffset, buffer, writePos, spaceToEnd);
                int remaining = validFloats - spaceToEnd;
                Array.Copy(src, srcFloatOffset + spaceToEnd, buffer, 0, remaining);
                writePos = remaining;
            }

            availableFloats += validFloats;
            int currentFrames = availableFloats / 2;

            if (isBuffering && currentFrames >= preRollFrames) {
                isBuffering = false;
            }

            // Real-time latency clamp:
            // Drop oldest excess stereo frames if backlog exceeds maxAllowedFrames
            if (currentFrames > maxAllowedFrames) {
                int excessFrames = currentFrames - targetCushionFrames;
                int excessFloats = excessFrames * 2;
                readPos = (readPos + excessFloats) % buffer.Length;
                availableFloats -= excessFloats;
            }
        }
    }

    public int ReadBytes(byte[] dest, int destByteOffset, int byteCount) {
        int neededFloats = byteCount / 4;
        int neededFrames = neededFloats / 2;
        int floatsToProcess = neededFrames * 2;
        int bytesToProcess = floatsToProcess * 4;

        lock (lockObj) {
            int availableFrames = availableFloats / 2;

            if (isBuffering || availableFrames < neededFrames) {
                if (isBuffering) {
                    Array.Clear(dest, destByteOffset, byteCount);
                    return byteCount;
                }

                // Buffer underrun: read whatever complete frames are available
                int toReadFrames = availableFrames;
                int toReadFloats = toReadFrames * 2;
                int toReadBytes = toReadFloats * 4;

                if (toReadFloats > 0) {
                    CopyFloatsToBytes(dest, destByteOffset, toReadFloats);
                    availableFloats -= toReadFloats;
                }

                // Clear remaining bytes to silence
                Array.Clear(dest, destByteOffset + toReadBytes, byteCount - toReadBytes);

                // Trigger re-buffering cushion to prevent stutter on every subsequent callback
                isBuffering = true;
                return byteCount;
            }

            // Normal smooth playback
            CopyFloatsToBytes(dest, destByteOffset, floatsToProcess);
            availableFloats -= floatsToProcess;

            if (byteCount > bytesToProcess) {
                Array.Clear(dest, destByteOffset + bytesToProcess, byteCount - bytesToProcess);
            }

            return byteCount;
        }
    }

    private void CopyFloatsToBytes(byte[] dest, int destByteOffset, int floatCount) {
        int spaceToEnd = buffer.Length - readPos;
        if (floatCount <= spaceToEnd) {
            Buffer.BlockCopy(buffer, readPos * 4, dest, destByteOffset, floatCount * 4);
            readPos = (readPos + floatCount) % buffer.Length;
        } else {
            Buffer.BlockCopy(buffer, readPos * 4, dest, destByteOffset, spaceToEnd * 4);
            int remaining = floatCount - spaceToEnd;
            Buffer.BlockCopy(buffer, 0, dest, destByteOffset + (spaceToEnd * 4), remaining * 4);
            readPos = remaining;
        }
    }
}

class AsioStreamProvider : IWaveProvider {
    private readonly WaveFormat waveFormat;
    private readonly FloatCircularBuffer circularBuffer;

    public AsioStreamProvider(int sampleRate, FloatCircularBuffer buffer) {
        this.waveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 2);
        this.circularBuffer = buffer;
    }

    public WaveFormat WaveFormat {
        get { return waveFormat; }
    }

    public int Read(byte[] buffer, int offset, int count) {
        return circularBuffer.ReadBytes(buffer, offset, count);
    }
}

class Program {
    [STAThread]
    static void Main(string[] args) {
        int sampleRate = 48000;
        string driverName = "ASIO 2.0 - ESI U168 XT";
        if (args.Length > 0 && !string.IsNullOrEmpty(args[0])) {
            driverName = args[0];
        }

        try {
            var ring = new FloatCircularBuffer();
            var provider = new AsioStreamProvider(sampleRate, ring);

            using (var asio = new AsioOut(driverName)) {
                asio.Init(provider);

                int hwBufferFrames = asio.FramesPerBuffer > 0 ? asio.FramesPerBuffer : asio.PlaybackLatency;
                if (hwBufferFrames <= 0) hwBufferFrames = 64;
                ring.ConfigureCushion(hwBufferFrames);

                asio.Play();

                // Notify parent Electron process
                Console.WriteLine("ASIO_READY:latency=" + asio.PlaybackLatency + ":buffer=" + hwBufferFrames + ":channels=" + asio.DriverOutputChannelCount);
                Console.Out.Flush();

                using (var stdin = Console.OpenStandardInput()) {
                    byte[] pipeBuf = new byte[8192];
                    byte[] comboBuf = new byte[8192 + 8];
                    int remainderBytes = 0;
                    float[] floatBuf = new float[4096];

                    int bytesRead;
                    while ((bytesRead = stdin.Read(pipeBuf, 0, pipeBuf.Length)) > 0) {
                        if (remainderBytes > 0) {
                            Buffer.BlockCopy(pipeBuf, 0, comboBuf, remainderBytes, bytesRead);
                            int totalBytes = remainderBytes + bytesRead;
                            int completeFrames = totalBytes / 8;
                            int validBytes = completeFrames * 8;
                            int newRemainder = totalBytes - validBytes;

                            int floatCount = validBytes / 4;
                            Buffer.BlockCopy(comboBuf, 0, floatBuf, 0, validBytes);
                            ring.Write(floatBuf, 0, floatCount);

                            if (newRemainder > 0) {
                                Buffer.BlockCopy(comboBuf, validBytes, comboBuf, 0, newRemainder);
                            }
                            remainderBytes = newRemainder;
                        } else {
                            int completeFrames = bytesRead / 8;
                            int validBytes = completeFrames * 8;
                            int newRemainder = bytesRead - validBytes;

                            int floatCount = validBytes / 4;
                            Buffer.BlockCopy(pipeBuf, 0, floatBuf, 0, validBytes);
                            ring.Write(floatBuf, 0, floatCount);

                            if (newRemainder > 0) {
                                Buffer.BlockCopy(pipeBuf, validBytes, comboBuf, 0, newRemainder);
                            }
                            remainderBytes = newRemainder;
                        }
                    }
                }
            }
        } catch (Exception ex) {
            Console.Error.WriteLine("ASIO_ERROR: " + ex.Message);
            Console.Error.Flush();
        }
    }
}
