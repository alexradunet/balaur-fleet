# Scores a recording with openWakeWord (the same library the server uses) and
# prints every moment a wake word scored above 0.05, with how loud the
# microphone was then. NAME may be "all": every built-in wake word, to find
# the one that suits your voice. Optional 4th argument: a gain to apply first.
import array, math, sys
from pyopen_wakeword import Model, OpenWakeWord, OpenWakeWordFeatures

name, path, threshold = sys.argv[1], sys.argv[2], float(sys.argv[3])
gain = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0

samples = array.array("h", open(path, "rb").read())
if gain != 1.0:
    samples = array.array("h", (max(-32768, min(32767, int(s * gain))) for s in samples))
audio = samples.tobytes()
chunk = 1280 * 2  # 80 ms of 16 kHz 16-bit mono

def rms(b):
    a = array.array("h", b)
    return math.sqrt(sum(x * x for x in a) / max(1, len(a)))

def load(n):
    try:
        return OpenWakeWord.from_builtin(Model(n))
    except ValueError:
        return OpenWakeWord.from_model(f"/var/lib/duet-wakewords/{n}.tflite")

def score(n):
    oww, features = load(n), OpenWakeWordFeatures.from_builtin()
    ms, peak, peak_at, loud, best, hits, peaks = 0, 0.0, 0, 0.0, 0.0, 0, []
    recent = []
    for i in range(0, len(audio), chunk):
        c = audio[i:i + chunk]
        recent = (recent + [rms(c)])[-25:]
        for f in features.process_streaming(c):
            for p in oww.process_streaming(f):
                best = max(best, p)
                if p > peak:
                    peak, peak_at, loud = p, ms, max(recent)
        ms += 80
        if peak > 0.05 and (ms - peak_at > 800 or i + chunk >= len(audio)):
            peaks.append((peak_at, peak, loud))
            hits += peak > threshold
            peak = 0.0
    return best, hits, peaks

names = [m.value for m in Model] if name == "all" else [name]
for n in names:
    best, hits, peaks = score(n)
    print(f"{n}: woke {hits} time(s), best score {best:.2f}")
    for at, p, loud in peaks:
        print(f"  {at / 1000:5.1f}s  score {p:.2f}  {'WAKES' if p > threshold else 'too low'}   (voice level {loud:.0f})")
levels = sorted(rms(audio[i:i + chunk]) for i in range(0, len(audio), chunk))
print(f"threshold {threshold}; microphone level: background {levels[len(levels) // 2]:.0f}, loudest {levels[-1]:.0f} (gain x{gain:g})")
