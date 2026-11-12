# A wake word of the household's own: recorded in its voices, on the microphone
# the assistant listens with, and trained here into a model openWakeWord loads
# (/var/lib/balaur-wakewords/<word>.tflite).
#
#   record WHO [COUNT]    WHO says the word COUNT times, once per prompt
#   speech WHO [SECONDS]  WHO talks WITHOUT the word: what must not wake it
#   room [MINUTES]        the room as it is (TV, music, talk), without the word
#   train [--hours H]     recordings -> model, and a report of how well it does
#   status                what has been recorded
#   selftest              the model writer against the runtime (no recordings)
#
# How it works. openWakeWord turns audio into one 96-number embedding every
# 80 ms (a speech model from Google, the same for every wake word) and a small
# classifier looks at the last 16 of them (1.28 s). Only that classifier is
# trained here, with numpy; the model file asks it about three windows on end
# and gives the lowest score, so one stray window does not wake anything:
#   positives  each recorded take, many times over: faster/slower, quieter/louder,
#              with reverb, over the room's own noise;
#   negatives  the household's own recordings without the word, as they are and
#              varied the same way; halves of the word; noise alone; and
#              openWakeWord's precomputed features of ~2000 hours of speech, noise
#              and music (huggingface.co/datasets/davidscripka/openwakeword_features;
#              only the first --hours of it are downloaded).
# One take in five is kept out of training and used to measure how often the
# word is caught; false wakes are counted on openWakeWord's 11-hour validation
# set and on the held-out end of the household's negatives.
#
# The recordings stay on this machine, readable by root only; delete them with
# `sudo rm -r /var/lib/balaur-wake-training/<word>` once the model is good.
import argparse, json, math, multiprocessing, os, re, shlex, subprocess, sys, threading, time, zlib
import urllib.request
from collections import deque
from pathlib import Path

import numpy as np

RATE = 16000
CHUNK = 1280  # 80 ms: one embedding
WINDOW = 16  # embeddings the classifier sees
FEATS = 96
SUSTAIN = 3  # windows on end that must all score high: a false wake is mostly one stray window
CLIP = WINDOW + SUSTAIN - 1  # embeddings the model file takes
CANVAS = 29 * CHUNK  # 2.32 s: those 18 embeddings look back on 28 chunks
TAKE_SECONDS = 2.5
HIDDEN = (64, 32)
BLUR = 0.3  # noise added to each embedding in training, in standard deviations
WRONG_YES = 300.0  # what a negative weighs against a positive by the end of training
REFRACTORY = 25  # frames (2 s) in which the server does not fire again

DATA = Path(os.environ.get("BALAUR_WAKE_DATA", "/var/lib/balaur-wake-training"))
MODELS = Path(os.environ.get("BALAUR_WAKE_MODELS", "/var/lib/balaur-wakewords"))
FEATURES_URL = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/"
ACAV = "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"  # windows (N, 16, 96), float16
VALIDATION = "validation_set_features.npy"  # frames (N, 96), float32, 11 hours on end


def say(*a):
    print(*a, flush=True)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float32)))) if len(x) else 0.0


# ---------------------------------------------------------------- recording


class Mic:
    """The assistant's microphone, as raw 16 kHz mono from BALAUR_WAKE_CAPTURE."""

    def __init__(self):
        cmd = os.environ.get("BALAUR_WAKE_CAPTURE")
        if not cmd:
            sys.exit("BALAUR_WAKE_CAPTURE is not set: run this as `sudo balaur-wake-word`")
        self.proc = subprocess.Popen(shlex.split(cmd), stdout=subprocess.PIPE)
        self.buf, self.lock, self.closed = bytearray(), threading.Lock(), False
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while chunk := self.proc.stdout.read1(4096):
            with self.lock:
                self.buf += chunk
        self.closed = True

    def flush(self):
        with self.lock:
            del self.buf[: len(self.buf) // 2 * 2]

    def read(self, seconds):
        need = int(seconds * RATE) * 2
        deadline = time.monotonic() + seconds + 5
        while len(self.buf) < need:
            if self.closed or time.monotonic() > deadline:
                sys.exit(
                    "\nthe microphone gave no audio: is the assistant's account logged in to the desktop?"
                )
            time.sleep(0.02)
        with self.lock:
            data = bytes(self.buf[:need])
            del self.buf[:need]
        return np.frombuffer(data, dtype=np.int16)

    def close(self):
        self.proc.terminate()


def find_word(x):
    """Where the one utterance of a take is, (start, end) in samples; or why not, as text."""
    y = x.astype(np.float32)
    y -= y.mean()
    n = 320  # 20 ms
    r = np.sqrt(np.square(y[: len(y) // n * n].reshape(-1, n)).mean(axis=1))
    floor = max(float(np.percentile(r, 20)), 1.0)
    loud = np.flatnonzero(r > max(3 * floor, floor + 50))
    if len(loud) == 0:
        return "nothing heard (too quiet?)"
    # Sounds less than 0.3 s apart are one utterance; shorter than 0.1 s is a click.
    groups = [g for g in np.split(loud, np.flatnonzero(np.diff(loud) > 15) + 1) if len(g) >= 5]
    if not groups:
        return "nothing heard (too quiet?)"
    if len(groups) > 1:
        return "more than one sound: once, in a quiet moment"
    start = int(groups[0][0]) * n - int(0.06 * RATE)
    end = (int(groups[0][-1]) + 1) * n + int(0.10 * RATE)
    if start < 0.1 * RATE:
        return "too early: wait for the number"
    if end > len(x) - 0.1 * RATE:
        return "cut off at the end: a little sooner"
    if end - start < 0.3 * RATE:
        return "too short"
    if end - start > 1.6 * RATE:
        return "too long, or the room is too noisy"
    if np.mean(np.abs(x.astype(np.int32)) >= 32700) > 0.002:
        return "too loud for the microphone (clipping)"
    return start, end


def stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def cmd_record(args):
    out = DATA / args.word / "positive"
    out.mkdir(parents=True, exist_ok=True)
    mic, session, saved, misses = Mic(), stamp(), 0, 0
    say(f'{args.who}: say "{phrase(args.word)}" once, each time a number appears ({args.count} times).')
    say("Vary it between rounds: next to the machine, across the room, quietly, quickly, tired.")
    mic.read(1.0)
    while saved < args.count:
        print(f"  {saved + 1:3d}/{args.count}  > ", end="", flush=True)
        mic.flush()
        take = mic.read(TAKE_SECONDS)
        found = find_word(take)
        if isinstance(found, str):
            misses += 1
            say(f"again: {found}")
            if misses >= 10:
                sys.exit("ten misses in a row: check the microphone with `sudo balaur-wake-test`.")
            time.sleep(0.8)
            continue
        misses = 0
        start, end = found
        take.tofile(out / f"{args.who}-{session}-{saved:03d}.raw")
        saved += 1
        say(f"ok   {(end - start) / RATE:.2f} s, level {rms(take[start:end]):.0f}")
        time.sleep(0.6)
    mic.close()
    cmd_status(args)


def cmd_ambient(args):
    out = DATA / args.word / "negative"
    out.mkdir(parents=True, exist_ok=True)
    if args.cmd == "speech":
        name, seconds = f"speech-{args.who}", args.seconds
        say(f'{args.who}: talk or read aloud for {seconds} s, WITHOUT saying "{phrase(args.word)}".')
        say("Work in words that sound like it: bal, balon, balcon, balama, baladă, bălai, palat,")
        say("salam, malul, Laura, aur, taur, dinozaur, restaurant, tablou, and the old wake word.")
    else:
        name, seconds = "room", int(args.minutes * 60)
        say(f'Recording the room for {args.minutes:g} min: leave the TV or music on and talk as usual,')
        say(f'but nobody says "{phrase(args.word)}".')
    mic, path, left = Mic(), out / f"{name}-{stamp()}.raw", seconds
    mic.read(0.5)
    mic.flush()
    with open(path, "wb") as f:
        while left > 0:
            step = min(5, left)
            mic.read(step).tofile(f)
            left -= step
            print(f"\r  {left:4d} s left ", end="", flush=True)
    say("\rdone.          ")
    mic.close()
    cmd_status(args)


def phrase(word):
    return " ".join(w.capitalize() for w in word.split("_"))


def takes_of(word):
    return sorted((DATA / word / "positive").glob("*.raw"))


def negatives_of(word):
    return sorted((DATA / word / "negative").glob("*.raw"))


def cmd_status(args):
    people = {}
    for p in takes_of(args.word):
        who = p.name.split("-")[0]
        people[who] = people.get(who, 0) + 1
    kinds = {}
    for p in negatives_of(args.word):
        kind = "room" if p.name.startswith("room-") else "-".join(p.name.split("-")[:2])
        kinds[kind] = kinds.get(kind, 0) + p.stat().st_size / 2 / RATE
    say(f'"{phrase(args.word)}" in {DATA / args.word}:')
    say("  takes:     " + (", ".join(f"{w} {n}" for w, n in people.items()) or "none yet"))
    say("  negatives: " + (", ".join(f"{k} {s / 60:.1f} min" for k, s in kinds.items()) or "none yet"))
    model = MODELS / f"{args.word}.tflite"
    report = DATA / args.word / "report.json"
    if model.exists() and report.exists():
        r = json.loads(report.read_text())
        say(f"  model:     {model}, trained {r['trained']} on {r['takes']} takes; threshold {r['threshold']}")
    else:
        say("  model:     not trained yet")


# ---------------------------------------------------------------- features


class Extractor:
    """openWakeWord's own front end, fed the way the server feeds it."""

    def __init__(self):
        from pyopen_wakeword import OpenWakeWordFeatures

        self.features = OpenWakeWordFeatures.from_builtin()
        self.last = deque(maxlen=CLIP)

    def feed(self, pcm):
        """Embeddings (n, 96) for int16 audio, whole 80 ms chunks of it."""
        raw, out = pcm.tobytes(), []
        for i in range(0, len(raw) - 2 * CHUNK + 1, 2 * CHUNK):
            for e in self.features.process_streaming(raw[i : i + 2 * CHUNK]):
                out.extend(e.reshape(-1, FEATS))
        self.last.extend(out)
        return out

    def window(self, pcm):
        """The 18 embeddings the model sees when `pcm` (a CANVAS) has just ended."""
        self.feed(pcm)
        return np.stack(self.last)


def colored_noise(rng, n):
    spectrum = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spectrum), dtype=np.float64)
    f[0] = 1
    y = np.fft.irfft(spectrum / f ** rng.uniform(0.0, 1.0), n)  # white to brown
    return (y / (y.std() + 1e-9)).astype(np.float32)


def augment(rng, take, start, end, noise, tail=(0.0, 0.4)):
    """One variation of a take: a CANVAS of audio that ends `tail` seconds after the word."""
    x = take.astype(np.float32)
    x -= x.mean()
    k = rng.uniform(0.9, 1.1)  # said faster and higher, or slower and lower
    x = np.interp(np.arange(0, len(x) - 1, k), np.arange(len(x)), x).astype(np.float32)
    start, end = int(start / k), int(end / k)
    if rng.random() < 0.3:  # a more echoing room, or farther from the microphone
        m = int(rng.uniform(0.15, 0.5) * RATE)
        ir = rng.standard_normal(m) * np.exp(-6.9 * np.arange(m) / m)
        ir *= rng.uniform(0.1, 0.5) / np.sqrt(np.sum(ir * ir))
        ir[0] = 1.0
        n = len(x) + m
        x = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)].astype(np.float32)
    level = rms(x[start:end]) + 1e-6
    stop = end + int(rng.uniform(*tail) * RATE)
    piece = x[max(0, stop - CANVAS) : min(stop, len(x))].copy()
    fade = min(480, len(piece))
    piece[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
    canvas = np.zeros(CANVAS, dtype=np.float32)
    at = CANVAS - (stop - min(stop, len(x)))
    canvas[at - len(piece) : at] = piece
    background = None
    if noise is not None and len(noise) > CANVAS and rng.random() < 0.7:
        o = int(rng.integers(0, len(noise) - CANVAS))
        background = noise[o : o + CANVAS].astype(np.float32)
        background -= background.mean()
        snr = rng.uniform(3, 25)
        if rms(background) < 1:
            background = None
    if background is None:
        background, snr = colored_noise(rng, CANVAS), rng.uniform(10, 40)
    canvas += background * (level / rms(background) / 10 ** (snr / 20))
    canvas *= 10 ** rng.uniform(-0.5, 0.3)  # -10 dB to +6 dB
    peak = float(np.abs(canvas).max())
    if peak > 30000:
        canvas *= 30000 / peak
    return canvas.astype(np.int16)


_extractor, _noise = None, None


def _settle():
    """A worker: low priority, on one core of its own. openWakeWord's runtime
    spreads over several threads for little gain; four pinned workers do more."""
    os.nice(10)
    try:
        cores = {}
        for cpu in sorted(os.sched_getaffinity(0)):
            siblings = Path(f"/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list").read_text()
            cores.setdefault(siblings, cpu)
        mine = sorted(cores.values())
        os.sched_setaffinity(0, {mine[(multiprocessing.current_process()._identity[0] - 1) % len(mine)]})
    except (OSError, IndexError):
        pass


def cores():
    try:
        return len({
            Path(f"/sys/devices/system/cpu/cpu{c}/topology/thread_siblings_list").read_text()
            for c in os.sched_getaffinity(0)
        })
    except OSError:
        return max(1, (os.cpu_count() or 2) // 2)


def _clips_job(job):
    """`count` clips (count, 18, 96) of one kind, from one recording; cached.
      word   the take's word, varied: the positives (held: ending late enough
             that all three windows have heard the whole word)
      part   the first or the second half of the word alone: not the word
      decoy  other moments of a negative recording, varied like the word
      quiet  noise alone, down to silence"""
    global _extractor
    kind, path, limit, seed, count, cache = job
    if cache.exists():
        return np.load(cache)
    held = kind == "held"
    if _extractor is None:
        _extractor = Extractor()
    rng = np.random.default_rng(seed)
    x = np.fromfile(path, dtype=np.int16)[:limit] if path else None
    found = find_word(x) if kind in ("word", "held", "part") else None
    out = []
    for _ in range(count):
        if kind in ("word", "held"):
            clip = augment(rng, x, *found, _noise, (0.2, 0.4) if held else (0.0, 0.4))
        elif kind == "part":
            start, end = found
            at = start + int(rng.uniform(0.35, 0.65) * (end - start))
            y, fade = x.astype(np.float32), np.linspace(1, 0, 320, dtype=np.float32)
            if rng.random() < 0.5:
                y[at - 320 : at] *= fade
                y[at:] = 0
                clip = augment(rng, y, start, at, _noise)
            else:
                y[at : at + 320] *= fade[::-1]
                y[:at] = 0
                clip = augment(rng, y, at, end, _noise)
        elif kind == "decoy":
            o = int(rng.integers(0, len(x) - int(TAKE_SECONDS * RATE)))
            end = int(rng.uniform(1.6, 2.3) * RATE)
            start = end - int(rng.uniform(0.3, 1.0) * RATE)
            clip = augment(rng, x[o : o + int(TAKE_SECONDS * RATE)], start, end, _noise)
        else:
            if _noise is not None and len(_noise) > CANVAS and rng.random() < 0.5:
                o = int(rng.integers(0, len(_noise) - CANVAS))
                clip = _noise[o : o + CANVAS].astype(np.float32) * 10 ** rng.uniform(-1.5, 0.3)
            else:
                clip = colored_noise(rng, CANVAS) * rng.uniform(0, 1) ** 3 * 3000
            clip = clip.clip(-32000, 32000).astype(np.int16)
        out.append(_extractor.window(clip))
    out = np.stack(out).astype(np.float16)
    cache.parent.mkdir(exist_ok=True)
    tmp = cache.with_suffix(".part.npy")
    np.save(tmp, out)
    tmp.replace(cache)
    return out


def _stream_job(job):
    """A recording's embeddings on end (n, 96), as the server would see them; cached.
    `lead`: a take on its own is given two seconds of its own background first."""
    path, lead, cache = job
    if cache.exists():
        return np.load(cache)
    pcm = np.fromfile(path, dtype=np.int16)
    if lead:
        rng = np.random.default_rng(len(pcm))
        y = pcm[: len(pcm) // 320 * 320].astype(np.float32).reshape(-1, 320)
        floor = float(np.percentile(np.sqrt(np.square(y - y.mean()).mean(axis=1)), 20))
        pcm = np.concatenate([(colored_noise(rng, 2 * RATE) * floor).astype(np.int16), pcm])
    ex = Extractor()
    ex.feed(pcm[:CHUNK])  # the burst for the silence openWakeWord starts with
    out = np.array(ex.feed(pcm[CHUNK:]), dtype=np.float16).reshape(-1, FEATS)
    cache.parent.mkdir(exist_ok=True)
    tmp = cache.with_suffix(".part.npy")
    np.save(tmp, out)
    tmp.replace(cache)
    return out


def fetch(name, size=None):
    """A file of openWakeWord's features (its first `size` bytes), resuming a partial one."""
    path = DATA / "public" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    have = path.stat().st_size if path.exists() else 0
    if size is None:
        done = path.with_suffix(".complete")
        if done.exists():
            return path
    elif have >= size:
        return path
    headers = {"Range": f"bytes={have}-" + ("" if size is None else str(size - 1))}
    req = urllib.request.Request(FEATURES_URL + name, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(path, "ab") as f:
            if have and resp.status != 206:
                sys.exit(f"{name}: the server would not resume the download; delete {path} and retry")
            total = have + int(resp.headers.get("Content-Length", 0))
            while block := resp.read(1 << 20):
                f.write(block)
                have += len(block)
                print(f"\r  {name}: {have / 1e6:6.0f} of {total / 1e6:.0f} MB ", end="", flush=True)
    except OSError as e:
        sys.exit(f"\n{name}: download failed ({e}); run train again to resume")
    say()
    if size is None:
        done.touch()
    return path


def open_npy(path):
    """A .npy as a read-only memmap, however much of it was downloaded."""
    with open(path, "rb") as f:
        np.lib.format.read_magic(f)
        shape, _, dtype = np.lib.format.read_array_header_1_0(f)
        offset = f.tell()
    row = int(np.prod(shape[1:])) * dtype.itemsize
    n = min(shape[0], (path.stat().st_size - offset) // row)
    return np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(n, *shape[1:]))


# ---------------------------------------------------------------- the classifier


def sigmoid(z):
    return 1 / (1 + np.exp(-np.clip(z, -30, 30)))


class Net:
    """16 x 96 embeddings -> ReLU layers -> one score."""

    def __init__(self, rng, mu, sd):
        sizes = (WINDOW * FEATS, *HIDDEN, 1)
        self.mu, self.sd = mu.astype(np.float32), sd.astype(np.float32)
        self.W = [
            (rng.standard_normal((a, b)) * math.sqrt(2 / a)).astype(np.float32)
            for a, b in zip(sizes, sizes[1:])
        ]
        self.b = [np.zeros(b, dtype=np.float32) for b in sizes[1:]]
        self.m = [np.zeros_like(p) for p in self.W + self.b]
        self.v = [np.zeros_like(p) for p in self.W + self.b]
        self.t = 0

    def _forward(self, X):
        h = ((np.asarray(X, dtype=np.float32) - self.mu) / self.sd).reshape(len(X), -1)
        acts = [h]
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            h = h @ W + b
            if i < len(self.W) - 1:
                h = np.maximum(h, 0)
            acts.append(h)
        return acts

    def score(self, X):
        return sigmoid(self._forward(X)[-1][:, 0])

    def step(self, X, y, weight, lr, decay=1e-4):
        acts = self._forward(X)
        g = ((sigmoid(acts[-1][:, 0]) - y) * weight / weight.sum())[:, None].astype(np.float32)
        grads_W, grads_b = [None] * len(self.W), [None] * len(self.W)
        for i in reversed(range(len(self.W))):
            grads_W[i], grads_b[i] = acts[i].T @ g, g.sum(axis=0)
            if i:
                g = (g @ self.W[i].T) * (acts[i] > 0)
        self.t += 1
        params, grads = self.W + self.b, grads_W + grads_b
        for j, (p, gr) in enumerate(zip(params, grads)):
            self.m[j] = 0.9 * self.m[j] + 0.1 * gr
            self.v[j] = 0.999 * self.v[j] + 0.001 * gr * gr
            mh, vh = self.m[j] / (1 - 0.9**self.t), self.v[j] / (1 - 0.999**self.t)
            if j < len(self.W):
                p *= 1 - lr * decay
            p -= lr * mh / (np.sqrt(vh) + 1e-8)

    def layers(self):
        """[(weights (out, in), bias)] with the input scaling folded into the first."""
        mu, sd = np.tile(self.mu, WINDOW), np.tile(self.sd, WINDOW)
        out = []
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            if i == 0:
                b = b - (mu / sd) @ W
                W = W / sd[:, None]
            out.append((np.ascontiguousarray(W.T, dtype=np.float32), b.astype(np.float32)))
        return out


def windows(frames, starts):
    """Windows (n, 16, 96) of embeddings on end, beginning at `starts`."""
    return frames[np.asarray(starts)[:, None] + np.arange(WINDOW)]


def score_stream(net, frames, starts=None):
    starts = np.arange(len(frames) - WINDOW + 1) if starts is None else starts
    return np.concatenate(
        [net.score(windows(frames, starts[i : i + 8192])) for i in range(0, len(starts), 8192)]
        or [np.zeros(0)]
    )


def score_windows(net, array):
    return np.concatenate(
        [net.score(array[i : i + 8192]) for i in range(0, len(array), 8192)] or [np.zeros(0)]
    )


class Pool:
    """Negatives to draw from: `get(indices)` gives windows, `index` is what may be
    drawn. After `mine`, a third of each draw is what the net is most wrong about."""

    def __init__(self, name, get, index, share):
        self.name, self.get, self.index, self.share, self.hard = name, get, index, share, None

    def draw(self, rng, n):
        idx = self.index[rng.integers(0, len(self.index), n)]
        if self.hard is not None:
            idx[: n // 3] = self.hard[rng.integers(0, len(self.hard), n // 3)]
        return np.asarray(self.get(np.sort(idx)), dtype=np.float32)

    def mine(self, net):
        s = np.concatenate(
            [net.score(self.get(self.index[i : i + 8192])) for i in range(0, len(self.index), 8192)]
        )
        self.hard = self.index[np.argsort(s)[-max(256, len(s) // 40) :]]
        return f"{self.name} {int((s > 0.5).sum())}"


def train_net(seed, pos, pools, acav, steps):
    """pos (P, 16, 96): the word. pools: the household's negatives. acav:
    openWakeWord's negative windows (N, 16, 96), which fill the rest of each batch."""
    rng = np.random.default_rng(seed)
    sample = acav[np.sort(rng.choice(len(acav), min(20000, len(acav)), replace=False))]
    sample = np.asarray(sample, dtype=np.float32).reshape(-1, FEATS)
    net = Net(rng, sample.mean(axis=0), sample.std(axis=0) + 1e-3)
    pools = [Pool(*p) for p in pools if len(p[2])]
    n_pos = 256
    sizes = [int(1024 * p.share) for p in pools]
    pools.append(Pool("openWakeWord's", lambda i: acav[i], np.arange(len(acav)), None))
    sizes.append(1024 - n_pos - sum(sizes))
    y = np.concatenate([np.ones(n_pos), np.zeros(1024 - n_pos)]).astype(np.float32)
    # Drawn once: fresh noise for every example of every step would double the time.
    blur = rng.standard_normal((2048, WINDOW, FEATS), dtype=np.float32) * (BLUR * net.sd)
    for step in range(steps):
        if step and step % (steps // 3) == 0:
            say(f"    step {step}: negatives scoring over 0.5: " + ", ".join(p.mine(net) for p in pools))
        X = np.concatenate(
            [np.asarray(pos[np.sort(rng.integers(0, len(pos), n_pos))], dtype=np.float32)]
            + [p.draw(rng, n) for p, n in zip(pools, sizes)]
        )
        # Two things that cut the false wakes on audio it has never heard (measured
        # on the validation set): every example is blurred a little, so the word is
        # a region and not a set of points; and a wrong "yes" comes to cost far more
        # than a wrong "no", as it does in a room where the word is rare.
        X += blur[rng.integers(0, len(blur), len(X))]
        weight = np.where(y > 0, 1.0, 1.0 + (WRONG_YES - 1.0) * step / steps).astype(np.float32)
        lr = 1e-5 + 2e-3 * 0.5 * (1 + math.cos(math.pi * step / steps))
        net.step(X, y, weight, lr)
    return net


def sustained(scores):
    """What the model file gives: the lowest of each SUSTAIN scores on end."""
    if len(scores) < SUSTAIN:
        return np.zeros(0)
    return np.min([scores[k : len(scores) - SUSTAIN + 1 + k] for k in range(SUSTAIN)], axis=0)


def events(scores, threshold):
    """How many times the server would have fired on these scores, one per 80 ms."""
    n, last = 0, -REFRACTORY
    for i in np.flatnonzero(scores > threshold):
        if i - last >= REFRACTORY:
            n, last = n + 1, i
    return n


# ---------------------------------------------------------------- the model file


def write_tflite(path, layers):
    """A TensorFlow Lite model, written field by field (schema v3). Input [1, 18, 96];
    the classifier (FULLY_CONNECTED layers, ReLU between them) is applied to the
    three 16-embedding windows in it, as three first layers whose weights sit at
    three offsets; MINIMUM of the three, then LOGISTIC. Output [1, 1]. Saves pulling
    in TensorFlow for this."""
    import flatbuffers
    from flatbuffers.number_types import UOffsetTFlags

    FULLY_CONNECTED, LOGISTIC, MINIMUM, RELU, FC_OPTIONS = 9, 14, 57, 1, 8
    b = flatbuffers.Builder(1 << 16)

    def ints(values):
        b.StartVector(4, len(values), 4)
        for v in reversed(values):
            b.PrependInt32(v)
        return b.EndVector()

    def offsets(values):
        b.StartVector(4, len(values), 4)
        for v in reversed(values):
            b.PrependUOffsetTRelative(v)
        return b.EndVector()

    def table(slots, fill):
        b.StartObject(slots)
        fill()
        return b.EndObject()

    buffers, tensors, operators = [], [], []

    def tensor(name, shape, array=None):
        """A tensor, with its values if it is a constant; its index."""
        data = None
        if array is not None:
            raw = array.astype("<f4").tobytes()
            b.StartVector(1, len(raw), 16)
            b.head = UOffsetTFlags.py_type(b.Head() - len(raw))
            b.Bytes[b.Head() : b.Head() + len(raw)] = raw
            data = b.EndVector()
        buffers.append(table(1, lambda: data is not None and b.PrependUOffsetTRelativeSlot(0, data, 0)))
        n, s = b.CreateString(name), ints(shape)

        def fill():
            b.PrependUOffsetTRelativeSlot(0, s, 0)
            b.PrependUint32Slot(2, len(buffers) - 1, 0)
            b.PrependUOffsetTRelativeSlot(3, n, 0)

        tensors.append(table(4, fill))
        return len(tensors) - 1

    def operator(opcode, inputs, shape, name, activation=None):
        """An operator and the tensor it writes; that tensor's index."""
        out = tensor(name, shape)
        options = None
        if activation is not None:
            options = table(1, lambda: b.PrependInt8Slot(0, activation, 0))
        i, o = ints(inputs), ints([out])

        def fill():
            b.PrependUint32Slot(0, opcode, 0)
            b.PrependUOffsetTRelativeSlot(1, i, 0)
            b.PrependUOffsetTRelativeSlot(2, o, 0)
            if options is not None:
                b.PrependUint8Slot(3, FC_OPTIONS, 0)
                b.PrependUOffsetTRelativeSlot(4, options, 0)

        operators.append(table(5, fill))
        return out

    def opcode(code):
        def fill():
            b.PrependInt8Slot(0, code, 0)
            b.PrependInt32Slot(2, 1, 0)  # version
            b.PrependInt32Slot(3, code, 0)

        return table(4, fill)

    buffers.append(table(1, lambda: None))  # buffer 0 is empty, by convention
    embeddings = tensor("embeddings", [1, CLIP, FEATS])
    W0, bias0 = layers[0]
    bias0 = tensor("dense0/bias", list(bias0.shape), bias0)
    rest = [
        (tensor(f"dense{n}/weights", list(W.shape), W), tensor(f"dense{n}/bias", list(bias.shape), bias), W.shape[0])
        for n, (W, bias) in enumerate(layers[1:], 1)
    ]
    lowest = None
    for k in range(SUSTAIN):
        shifted = np.zeros((W0.shape[0], CLIP * FEATS), dtype=np.float32)
        shifted[:, k * FEATS : k * FEATS + W0.shape[1]] = W0
        weights = tensor(f"window{k}/dense0/weights", list(shifted.shape), shifted)
        h = operator(0, [embeddings, weights, bias0], [1, W0.shape[0]], f"window{k}/dense0", RELU)
        for n, (weights, bias, width) in enumerate(rest, 1):
            last = n == len(rest)
            h = operator(0, [h, weights, bias], [1, width], f"window{k}/dense{n}", 0 if last else RELU)
        lowest = h if lowest is None else operator(2, [lowest, h], [1, 1], f"lowest{k}")
    score = operator(1, [lowest], [1, 1], "score")

    t, i, o, ops = offsets(tensors), ints([embeddings]), ints([score]), offsets(operators)
    name = b.CreateString("main")

    def fill_subgraph():
        b.PrependUOffsetTRelativeSlot(0, t, 0)
        b.PrependUOffsetTRelativeSlot(1, i, 0)
        b.PrependUOffsetTRelativeSlot(2, o, 0)
        b.PrependUOffsetTRelativeSlot(3, ops, 0)
        b.PrependUOffsetTRelativeSlot(4, name, 0)

    subgraphs = offsets([table(5, fill_subgraph)])
    codes = offsets([opcode(FULLY_CONNECTED), opcode(LOGISTIC), opcode(MINIMUM)])
    bufs, description = offsets(buffers), b.CreateString("balaur-wake-word")

    def fill_model():
        b.PrependUint32Slot(0, 3, 0)  # schema version
        b.PrependUOffsetTRelativeSlot(1, codes, 0)
        b.PrependUOffsetTRelativeSlot(2, subgraphs, 0)
        b.PrependUOffsetTRelativeSlot(3, description, 0)
        b.PrependUOffsetTRelativeSlot(4, bufs, 0)

    b.Finish(table(5, fill_model), file_identifier=b"TFL3")
    tmp = Path(str(path) + ".new")
    tmp.write_bytes(bytes(b.Output()))
    tmp.chmod(0o644)
    tmp.replace(path)


def check_model(path, net, rng):
    """The file, in the runtime the server uses, gives the scores training saw."""
    from pyopen_wakeword import OpenWakeWord

    X = rng.standard_normal((40 + CLIP - 1, FEATS)).astype(np.float32) * net.sd + net.mu
    model = OpenWakeWord.from_model(path)
    got = [p for f in X for p in model.process_streaming(f.reshape(1, 1, 1, FEATS))]
    want = sustained(score_stream(net, X))
    if len(got) != len(want) or np.abs(np.array(got) - want).max() > 1e-4:
        sys.exit(f"{path}: the written model does not give the trained model's scores")


def cmd_selftest(args):
    rng = np.random.default_rng(0)
    net = Net(rng, rng.standard_normal(FEATS), rng.uniform(0.5, 2.0, FEATS))
    for b in net.b:
        b += rng.standard_normal(b.shape).astype(np.float32)
    path = Path(args.out) / "selftest.tflite"
    write_tflite(path, net.layers())
    check_model(path, net, rng)
    X = rng.standard_normal((64, WINDOW, FEATS)).astype(np.float32)
    y = (X[:, 0, 0] > 0).astype(np.float32)
    for _ in range(300):
        net.step(X, y, np.ones(64, dtype=np.float32), 1e-2)
    if np.mean((net.score(X) > 0.5) == (y > 0.5)) < 0.99:
        sys.exit("selftest: the trainer did not learn a separable toy problem")
    say("selftest: the written model matches in the runtime, and the trainer learns")


# ---------------------------------------------------------------- train


def cmd_train(args):
    global _noise
    os.nice(10)
    word, rng = args.word, np.random.default_rng(args.seed)
    cache = DATA / word / "cache"
    takes = [p for p in takes_of(word) if not isinstance(find_word(np.fromfile(p, dtype=np.int16)), str)]
    who = lambda p: p.name.split("-")[0]
    people = sorted({who(p) for p in takes})
    say(f'"{phrase(word)}": ' + ", ".join(f"{w} {sum(who(p) == w for p in takes)} takes" for w in people))
    if len(takes) < 20:
        sys.exit("too few takes to train on: `sudo balaur-wake-word record <who>` first (60 or more each)")

    # Every fifth take of each person is held out, to measure with.
    held = [p for w in people for p in [t for t in takes if who(t) == w][4::5]]
    kept = [p for p in takes if p not in held]
    negatives = [p for p in negatives_of(word) if p.stat().st_size >= 2 * 4 * RATE]
    if not negatives:
        say("  no negatives of your own (`speech`, `room`): it will wake more easily on your talk and TV")

    say("openWakeWord's features (downloaded once):")
    acav = open_npy(fetch(ACAV, 128 + int(args.hours * 3600 / 1.28) * WINDOW * FEATS * 2))
    validation = open_npy(fetch(VALIDATION))
    say(f"  {len(acav) * 1.28 / 3600:.0f} h of negatives, {len(validation) * 0.08 / 3600:.1f} h to validate on")

    # The first 80% of each negative recording is trained on, the rest measured
    # with. The room's noise also goes under the takes, split the same way.
    limit = {p: p.stat().st_size // 2 * 4 // 5 for p in negatives}
    rooms = [np.fromfile(p, dtype=np.int16) for p in negatives if p.name.startswith("room-")]
    noise_kept = np.concatenate([r[: len(r) * 4 // 5] for r in rooms]) if rooms else None
    noise_held = np.concatenate([r[len(r) * 4 // 5 :] for r in rooms]) if rooms else None

    # How many clips of each recording: in steps, and by the recording alone where
    # possible, so that adding recordings leaves most of the cache of use.
    per_take = next(n for n in (60, 40, 30, 20, 15) if n == 15 or n * len(kept) <= 9000)
    used = set()

    def job(kind, stem, path, n, tag):
        name = f"{kind}-{stem}-{n}-{args.seed}-{len(rooms)}{tag}.npy"
        used.add(name)
        return (kind, path, limit.get(path), zlib.crc32(name.encode()), n, cache / name)

    jobs_kept = [job("word", p.stem, p, per_take, "k") for p in kept]
    jobs_kept += [job("part", p.stem, p, per_take // 4, "k") for p in kept]
    for p in negatives:  # the people's own talk is worth more than the room's
        per_minute = 100 if p.name.startswith("room-") else 400
        jobs_kept.append(job("decoy", p.stem, p, max(8, min(1500, limit[p] * per_minute // (60 * RATE))), "k"))
    jobs_kept += [job("quiet", f"noise{i}", None, 50, "k") for i in range(8)]
    jobs_held = [job("held", p.stem, p, per_take, "h") for p in held]
    streams = [(p, False, cache / f"stream-{p.stem}.npy") for p in negatives]
    plain = [(p, True, cache / f"take-{p.stem}.npy") for p in held]
    used.update(j[2].name for j in streams + plain)

    def run(jobs, fn, noise=None):
        global _noise
        _noise = noise  # the workers are forked with it
        out = []
        with multiprocessing.get_context("fork").Pool(cores(), initializer=_settle) as pool:
            for result in pool.imap(fn, jobs, chunksize=1):
                out.append(result)
                print(f"\r  {len(out)} of {len(jobs)} ", end="", flush=True)
        print("\r", end="")
        return out

    began = time.monotonic()
    n = sum(j[4] for j in jobs_kept + jobs_held)
    say(f"features: {n} clips from {len(takes)} takes and {sum(limit.values()) / RATE / 60:.0f} min of negatives "
        f"(what an earlier run made is reused) ...")
    made_kept = run(jobs_kept, _clips_job, noise_kept)
    made_held = run(jobs_held, _clips_job, noise_held)
    streams, plain = run(streams, _stream_job), run(plain, _stream_job)
    for stale in set(p.name for p in cache.glob("*.npy")) - used:
        (cache / stale).unlink()
    say(f"  done in {time.monotonic() - began:.0f} s")

    stack = lambda kinds, jobs, made: np.concatenate(
        [m for j, m in zip(jobs, made) if j[0] in kinds] or [np.zeros((0, CLIP, FEATS), np.float16)]
    )
    # The classifier trains on the last window of each clip.
    pos_kept, pos_held = stack(("word",), jobs_kept, made_kept)[:, -WINDOW:], stack(("held",), jobs_held, made_held)
    varied = stack(("part", "decoy", "quiet"), jobs_kept, made_kept)[:, -WINDOW:]

    # The household's negatives as they were recorded, on end; a window never
    # spans two recordings.
    own = np.concatenate(streams) if streams else np.zeros((0, FEATS), np.float16)
    starts_kept, starts_held, at = [np.zeros(0, np.int64)], [np.zeros(0, np.int64)], 0
    for s in streams:
        n = max(0, len(s) - WINDOW + 1)
        starts_kept.append(at + np.arange(0, n * 4 // 5))
        starts_held.append(at + np.arange(min(n, n * 4 // 5 + WINDOW), n))
        at += len(s)
    starts_kept, starts_held = np.concatenate(starts_kept), np.concatenate(starts_held)

    def pools(starts):
        return [
            ("varied", lambda i: varied[i], np.arange(len(varied)), 0.1875),
            ("as recorded", lambda i: windows(own, i), starts, 0.1875),
        ]

    say(f"training on {len(pos_kept)} positives, {len(varied) + len(starts_kept)} negatives of yours "
        f"and {len(acav)} of openWakeWord's ({args.steps} steps) ...")
    net = train_net(args.seed, pos_kept, pools(starts_kept), acav, args.steps)

    # How it does on what it has not seen.
    who_held = [who(p) for p in held]
    best = np.array([sustained(score_stream(net, f)).max() for f in plain])
    noisy = np.min([score_windows(net, pos_held[:, k : k + WINDOW]) for k in range(SUSTAIN)], axis=0)
    val_scores = sustained(score_stream(net, validation))
    own_scores = sustained(score_stream(net, own, starts_held))
    val_hours, own_minutes = len(val_scores) * 0.08 / 3600, len(own_scores) * 0.08 / 60
    say(f"\nheld-out takes: {len(best)} as recorded, and {len(noisy)} variations of them (noise, reverb, speed)")
    say(f"false wakes: per hour, on openWakeWord's validation set ({val_hours:.1f} h)"
        + (f"; and in the {own_minutes:.0f} held-out min of your negatives" if own_minutes else ""))
    say("  threshold   caught    varied   false/h" + ("   yours" if own_minutes else ""))
    rows, choice = [], None
    for th in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
        row = {
            "threshold": th,
            "caught": float(np.mean(best > th)),
            "varied": float(np.mean(noisy > th)),
            "false_per_hour": events(val_scores, th) / val_hours,
            "own_false": events(own_scores, th),
        }
        rows.append(row)
        say(f"  {th:9.2f}   {100 * row['caught']:5.1f} %   {100 * row['varied']:5.1f} %   {row['false_per_hour']:7.2f}"
            + (f"   {row['own_false']:5d}" if own_minutes else ""))
        if choice is None and th >= 0.5 and row["false_per_hour"] <= 0.5 and not row["own_false"]:
            choice = row
    if choice is None:
        choice = rows[-1]
        say("  it wakes too easily at every threshold: record more `speech` and `room`, and more takes")
    th = choice["threshold"]
    for w in people:
        mine = np.array([b for b, o in zip(best, who_held) if o == w] or [0.0])
        say(f"  {w}: {int((mine > th).sum())} of {len(mine)} held-out takes wake it at {th}; weakest score {mine.min():.2f}")

    # The model that ships has seen every take; its false wakes are measured again.
    say(f"\ntraining the final model on all {len(takes)} takes ...")
    net = train_net(args.seed + 1, np.concatenate([pos_kept, pos_held[:, -WINDOW:]]),
                    pools(np.concatenate([starts_kept, starts_held])), acav, args.steps)
    final_false = events(sustained(score_stream(net, validation)), th) / val_hours
    MODELS.mkdir(parents=True, exist_ok=True)
    path = MODELS / f"{word}.tflite"
    write_tflite(path, net.layers())
    check_model(path, net, rng)
    report = {
        "word": word,
        "trained": time.strftime("%Y-%m-%d %H:%M"),
        "takes": len(takes),
        "people": {w: sum(who(p) == w for p in takes) for w in people},
        "negative_minutes": round(len(own) * 0.08 / 60, 1),
        "threshold": th,
        "final_false_per_hour": round(final_false, 2),
        "held_out": rows,
    }
    (DATA / word / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    say(f"wrote {path} ({path.stat().st_size // 1024} kB): {final_false:.2f} false wakes an hour "
        f"on the validation set at {th}")
    say(f"\nTry it:    sudo balaur-wake-test --word {word}")
    say(f'Use it:    balaur.assistant.wakeWord = "{word}"; wakeThreshold = {th};')


def main():
    ap = argparse.ArgumentParser(prog="balaur-wake-word", description="A wake word in the household's own voices.")
    ap.add_argument("--word", default="balaur", help="the model's name: lowercase, _ between words (balaur)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("record", help="someone says the word, once per prompt")
    p.add_argument("who")
    p.add_argument("count", nargs="?", type=int, default=25)
    p = sub.add_parser("speech", help="someone talks without the word")
    p.add_argument("who")
    p.add_argument("seconds", nargs="?", type=int, default=90)
    p = sub.add_parser("room", help="the room as it is, without the word")
    p.add_argument("minutes", nargs="?", type=float, default=10)
    p = sub.add_parser("train", help="recordings -> model")
    p.add_argument("--hours", type=float, default=300, help="hours of openWakeWord's negatives to use (8.6 MB each)")
    p.add_argument("--steps", type=int, default=6000)
    p.add_argument("--seed", type=int, default=1)
    sub.add_parser("status", help="what has been recorded")
    p = sub.add_parser("selftest")
    p.add_argument("out")
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9]+(_[a-z0-9]+)*", args.word):
        sys.exit("--word: lowercase letters and digits, _ between words")
    if getattr(args, "who", None) is not None and not re.fullmatch(r"[a-z0-9]+", args.who):
        sys.exit("who: a short lowercase name, e.g. alex")
    {
        "record": cmd_record,
        "speech": cmd_ambient,
        "room": cmd_ambient,
        "train": cmd_train,
        "status": cmd_status,
        "selftest": cmd_selftest,
    }[args.cmd](args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nstopped.")
