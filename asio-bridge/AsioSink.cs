using System;
using System.IO;
using NAudio.Wave;

class CircularBuffer {
    private readonly byte[] buffer;
    private int writePos = 0;
    private int readPos = 0;
    private int count = 0;
    private readonly object lockObj = new object();

    private bool isBuffering = true;
    private int prebufferTarget = 4096; // dynamically set to 2 ASIO buffers
    private int maxBacklog = 12288;     // dynamically set to ~3-4 ASIO buffers (max ~25ms)

    private int totalUnderruns = 0;
    private int totalDrops = 0;
    private long totalBytesWritten = 0;
    private long totalBytesRead = 0;

    public int TotalUnderruns { get { return totalUnderruns; } }
    public int TotalDrops { get { return totalDrops; } }
    public long TotalBytesWritten { get { return totalBytesWritten; } }
    public long TotalBytesRead { get { return totalBytesRead; } }

    public CircularBuffer(int capacity = 65536) {
        buffer = new byte[capacity];
    }

    public void ConfigureThresholds(int asioBufferBytes) {
        lock (lockObj) {
            // Target 2 ASIO buffers for prebuffering (e.g. 512 samples = ~10.6ms @ 48kHz for 256-sample ASIO)
            prebufferTarget = Math.Max(asioBufferBytes * 2, 4096);
            // Clamp backlog so latency never exceeds ~25ms
            maxBacklog = Math.Max(prebufferTarget * 3, 16384);
        }
    }

    public void Write(byte[] data, int offset, int length) {
        if (length <= 0) return;
        int validBytes = (length / 8) * 8;
        if (validBytes <= 0) return;

        lock (lockObj) {
            totalBytesWritten += validBytes;

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

            // Clamping backlog if queue exceeds maxBacklog
            if (count > maxBacklog) {
                int excess = count - maxBacklog;
                excess = (excess / 8) * 8;
                readPos = (readPos + excess) % buffer.Length;
                count -= excess;
                totalDrops++;
            }
        }
    }

    public int Read(byte[] dest, int offset, int length) {
        lock (lockObj) {
            if (isBuffering) {
                if (count < prebufferTarget) {
                    Array.Clear(dest, offset, length);
                    return length;
                }
                isBuffering = false;
            }

            int framesAvailable = count / 8;
            int framesRequested = length / 8;
            int framesToRead = Math.Min(framesRequested, framesAvailable);
            int bytesToRead = framesToRead * 8;

            if (bytesToRead > 0) {
                totalBytesRead += bytesToRead;

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

            if (bytesToRead < length) {
                Array.Clear(dest, offset + bytesToRead, length - bytesToRead);
                isBuffering = true;
                totalUnderruns++;
            }

            return length;
        }
    }

    public int Count {
        get { lock (lockObj) { return count; } }
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

                int asioBufferBytes = asio.PlaybackLatency * 8;
                if (asioBufferBytes <= 0) asioBufferBytes = 2048;
                ring.ConfigureThresholds(asioBufferBytes);

                asio.Play();

                // Notify parent Electron process
                Console.WriteLine("ASIO_READY:latency=" + asio.PlaybackLatency + ":buffer=" + asio.PlaybackLatency + ":channels=" + asio.DriverOutputChannelCount);
                Console.Out.Flush();

                // Periodic stats reporter every 2.5 seconds
                var statsTimer = new System.Timers.Timer(2500);
                statsTimer.Elapsed += (s, e) => {
                    Console.WriteLine("[ASIO Stats] Queue: " + ring.Count + " bytes, Written: " + ring.TotalBytesWritten + ", Read: " + ring.TotalBytesRead + ", Underruns: " + ring.TotalUnderruns + ", Drops: " + ring.TotalDrops);
                    Console.Out.Flush();
                };
                statsTimer.AutoReset = true;
                statsTimer.Start();

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

