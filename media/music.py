import numpy as np, wave
SR = 44100; DUR = 46.0; N = int(SR * DUR)
rng = np.random.default_rng(7)
t_all = np.arange(N) / SR
out = np.zeros(N)
BEAT = 0.5  # 120 BPM

def add(sig, start, gain=1.0):
    i = int(start * SR)
    if i >= N or i < 0: return
    end = min(N, i + len(sig))
    out[i:end] += gain * sig[:end - i]

def kick(length=0.35):
    t = np.arange(int(SR * length)) / SR
    f = 45 + 80 * np.exp(-t * 30)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * np.exp(-t * 9)

def snare(length=0.22):
    t = np.arange(int(SR * length)) / SR
    n = rng.standard_normal(len(t))
    tone = np.sin(2 * np.pi * 190 * t)
    return (0.7 * n + 0.3 * tone) * np.exp(-t * 22)

def hat(length=0.05):
    t = np.arange(int(SR * length)) / SR
    n = rng.standard_normal(len(t))
    n = np.diff(n, prepend=0)  # crude highpass
    return n * np.exp(-t * 80)

def note(freq, length, harm=(1, .5, .25)):
    t = np.arange(int(SR * length)) / SR
    s = sum(a * np.sin(2 * np.pi * freq * k * t) for k, a in zip((1, 2, 3), harm))
    env = np.minimum(1, t / 0.01) * np.exp(-t * 2.2)
    return s * env

def pad(freqs, length):
    t = np.arange(int(SR * length)) / SR
    s = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    env = np.minimum(1, t / 0.8) * np.minimum(1, (length - t) / 0.8)
    return s * env

def hz(midi): return 440 * 2 ** ((midi - 69) / 12)
# chords as midi roots: Am F C G  (A2=45)
prog = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [48, 52, 55]), (55, [55, 59, 62])]
bar = 2.0
beats = int(DUR / BEAT)
for b in range(beats):
    t0 = b * BEAT
    if t0 > 41.5: break
    add(kick(), t0, 0.9)
    if b % 4 in (1, 3): add(snare(), t0, 0.45)
    add(hat(), t0, 0.12)
    add(hat(), t0 + BEAT / 2, 0.08)
# bass: pumping 8ths on chord root
for k in range(int(DUR / (BEAT / 2))):
    t0 = k * BEAT / 2
    if t0 > 41.5: break
    root, _ = prog[int(t0 // bar) % 4]
    add(note(hz(root - 12), BEAT / 2 * 0.9, (1, .6, .3)), t0, 0.32)
# pads per 2-bar block
for blk in range(int(np.ceil(DUR / (bar * 2)))):
    t0 = blk * bar * 2
    if t0 > 41.5: break
    _, chord = prog[blk % 4]
    add(pad([hz(m + 12) for m in chord], bar * 2), t0, 0.22)
# hit + riser
add(kick(0.8) * 1.2, 0.0, 1.0)
add(kick(0.9) * 1.2, 37.6, 1.0)
riser_len = 3.5
rt = np.arange(int(SR * riser_len)) / SR
riser = rng.standard_normal(len(rt)) * (rt / riser_len) ** 2 * 0.35
add(riser, 33.2, 1.0)
# fade out
fade = np.clip((DUR - t_all) / 2.0, 0, 1)
out = out * fade
out = out / max(1e-9, np.max(np.abs(out))) * 0.85
pcm = (out * 32767).astype(np.int16)
with wave.open("music.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("music ok", DUR)
