using System;
using System.IO;
using NAudio.Wave;

class CircularBuffer {
    private readonly byte[] buffer;
    private int writePos = 0;
    private int readPos = 0;
    private int count = 0;
    private readonly object lockObj = new object();

    // 256 samples stereo Float32 = 256 * 2 * 4 = 2048 bytes = ~4.26ms
    // Clamping to 2048 bytes ensures the buffer NEVER exceeds 4.2ms of backlog!
    private readonly int maxCapacity = 2048;

    public CircularBuffer(int capacity = 16384) {
        buffer = new byte[capacity];
    }

    public void Write(byte[] data, int offset, int length) {
        lock (lockObj) {
            for (int i = 0; i < length; i++) {
                buffer[writePos] = data[offset + i];
                writePos = (writePos + 1) % buffer.Length;
                count++;
            }

            // Real-time latency clamp: drop stale ahead-of-time silence
            if (count > maxCapacity) {
                readPos = (writePos - maxCapacity + buffer.Length) % buffer.Length;
                count = maxCapacity;
            }
        }
    }

    public int Read(byte[] dest, int offset, int length) {
        lock (lockObj) {
            int toRead = Math.Min(length, count);
            for (int i = 0; i < toRead; i++) {
                dest[offset + i] = buffer[readPos];
                readPos = (readPos + 1) % buffer.Length;
            }
            count -= toRead;
            if (toRead < length) {
                Array.Clear(dest, offset + toRead, length - toRead);
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
                    byte[] readBuf = new byte[1024]; // 1 block of 128 samples
                    int bytesRead;
                    while ((bytesRead = stdin.Read(readBuf, 0, readBuf.Length)) > 0) {
                        ring.Write(readBuf, 0, bytesRead);
                    }
                }
            }
        } catch (Exception ex) {
            Console.Error.WriteLine("ASIO_ERROR: " + ex.Message);
            Console.Error.Flush();
        }
    }
}
