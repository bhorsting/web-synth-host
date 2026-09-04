using System;
using System.IO;
using NAudio.Wave;

class CircularBuffer {
    private readonly byte[] buffer;
    private int writePos = 0;
    private int readPos = 0;
    private int count = 0;
    private readonly object lockObj = new object();

    // 16384 bytes = 2048 stereo Float32 frames = ~42.6 ms of maximum backlog @ 48kHz.
    // Generous enough to never drop samples during normal playing with 256-sample ASIO buffers,
    // yet tight enough that latency stays below 42ms even after temporary lags.
    private readonly int maxCapacity = 16384;

    public CircularBuffer(int capacity = 65536) {
        buffer = new byte[capacity];
    }

    public void Write(byte[] data, int offset, int length) {
        if (length <= 0) return;
        // Strictly align to 8-byte stereo Float32 frames
        int validBytes = (length / 8) * 8;
        if (validBytes <= 0) return;

        lock (lockObj) {
            int spaceToEnd = buffer.Length - writePos;
            if (validBytes <= spaceToEnd) {
                Buffer.BlockCopy(data, offset, buffer, writePos, validBytes);
                writePos = (writePos + validBytes) % buffer.Length;
            } else {
                Buffer.BlockCopy(data, offset, buffer, writePos, spaceToEnd);
                int remaining = validBytes - spaceToEnd;
                Buffer.BlockCopy(data, offset + spaceToEnd, buffer, 0, remaining);
                writePos = remaining;
            }

            count += validBytes;

            // Clamping backlog if queue exceeds 16KB (~42ms)
            if (count > maxCapacity) {
                int excess = count - maxCapacity;
                excess = (excess / 8) * 8;
                readPos = (readPos + excess) % buffer.Length;
                count -= excess;
            }
        }
    }

    public int Read(byte[] dest, int offset, int length) {
        lock (lockObj) {
            int framesAvailable = count / 8;
            int framesRequested = length / 8;
            int framesToRead = Math.Min(framesRequested, framesAvailable);
            int bytesToRead = framesToRead * 8;

            if (bytesToRead > 0) {
                int spaceToEnd = buffer.Length - readPos;
                if (bytesToRead <= spaceToEnd) {
                    Buffer.BlockCopy(buffer, readPos, dest, offset, bytesToRead);
                    readPos = (readPos + bytesToRead) % buffer.Length;
                } else {
                    Buffer.BlockCopy(buffer, readPos, dest, offset, spaceToEnd);
                    int remaining = bytesToRead - spaceToEnd;
                    Buffer.BlockCopy(buffer, 0, dest, offset + spaceToEnd, remaining);
                    readPos = remaining;
                }
                count -= bytesToRead;
            }

            // Fill remainder with silence (zeros)
            if (bytesToRead < length) {
                Array.Clear(dest, offset + bytesToRead, length - bytesToRead);
            }

            return length;
        }
    }
}

class AsioStreamProvider : IWaveProvider {
    private readonly WaveFormat waveFormat;
    private readonly CircularBuffer circularBuffer;

    public AsioStreamProvider(int sampleRate, CircularBuffer buffer) {
        this.waveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 2);
        this.circularBuffer = buffer;
    }

    public WaveFormat WaveFormat {
        get { return waveFormat; }
    }

    public int Read(byte[] buffer, int offset, int count) {
        return circularBuffer.Read(buffer, offset, count);
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
            var ring = new CircularBuffer();
            var provider = new AsioStreamProvider(sampleRate, ring);

            using (var asio = new AsioOut(driverName)) {
                asio.Init(provider);
                asio.Play();

                // Notify parent Electron process
                Console.WriteLine("ASIO_READY:latency=" + asio.PlaybackLatency + ":channels=" + asio.DriverOutputChannelCount);
                Console.Out.Flush();

                using (var stdin = Console.OpenStandardInput()) {
                    byte[] pipeBuf = new byte[8192];
                    byte[] comboBuf = new byte[8192 + 8];
                    int remainder = 0;

                    int bytesRead;
                    while ((bytesRead = stdin.Read(pipeBuf, 0, pipeBuf.Length)) > 0) {
                        if (remainder > 0) {
                            Buffer.BlockCopy(pipeBuf, 0, comboBuf, remainder, bytesRead);
                            int total = remainder + bytesRead;
                            int valid = (total / 8) * 8;
                            int newRem = total - valid;

                            ring.Write(comboBuf, 0, valid);

                            if (newRem > 0) {
                                Buffer.BlockCopy(comboBuf, valid, comboBuf, 0, newRem);
                            }
                            remainder = newRem;
                        } else {
                            int valid = (bytesRead / 8) * 8;
                            int newRem = bytesRead - valid;

                            ring.Write(pipeBuf, 0, valid);

                            if (newRem > 0) {
                                Buffer.BlockCopy(pipeBuf, valid, comboBuf, 0, newRem);
                            }
                            remainder = newRem;
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
