"""Forecast analyst: a numerical market model (Kronos) as a distinct desk bot. Research only.

Kronos (github.com/shiyu-coder/Kronos, MIT licence) is a pretrained candlestick forecaster. It is the only model
weight among the ten reference repositories; the others are frameworks. Here it forecasts the next hour of 5-minute
bars from completed bars only, and its stance is derived from the forecast by fixed rules, so it makes no
language-model call and cannot be argued with. Its scorecard is the same as every analyst's.

Weights and code are owner-installed local copies (see README); loading never contacts the network.
torch and pandas are imported only when a forecaster is built, so the desk runs without them.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KRONOS = ROOT / '.local' / 'kronos'
HORIZON = 12               # one hour of 5-minute bars, the desk's judging horizon
LOOKBACK = 400             # bars of context (about five sessions), as in the Kronos examples
MIN_HISTORY = 72           # about one session; with less the forecaster abstains
COST_BPS_ROUND_TRIP = 30   # same threshold the desk judges every analyst against
SESSION_LAST = (15, 25)    # last 5-minute bar of the NSE session
VARIANTS = {               # model id -> (tokenizer id, maximum context)
    'Kronos-mini': ('Kronos-Tokenizer-2k', 2048),
    'Kronos-small': ('Kronos-Tokenizer-base', 512),
}


def future_times(last, count):
    """Timestamps of the next `count` session bars after `last` (skips the close, nights and weekends).
    Only the calendar is used; no future market data is involved."""
    t, out = datetime.fromisoformat(last), []
    while len(out) < count:
        t += timedelta(minutes=5)
        if (t.hour, t.minute) > SESSION_LAST:
            t = (t + timedelta(days=1)).replace(hour=9, minute=15)
        while t.weekday() >= 5:
            t = (t + timedelta(days=1)).replace(hour=9, minute=15)
        out.append(t)
    return out


def history(bars, i, lookback=LOOKBACK):
    """The completed bars the forecaster may see at bar i, or None when there are too few."""
    window = bars[max(0, i + 1 - lookback):i + 1]
    return window if len(window) >= MIN_HISTORY else None


def opinion(expected_bps):
    """Fixed mapping from forecast to stance: beyond the round-trip cost is a view, otherwise neutral."""
    if abs(expected_bps) <= COST_BPS_ROUND_TRIP:
        return {'stance': 'neutral', 'conviction': 'low', 'reasons': [f'Forecast 1-hour move {expected_bps:+.1f} bps is within costs.'],
                'invalidation': 'A forecast beyond 30 bps either way.'}
    stance = 'bullish' if expected_bps > 0 else 'bearish'
    conviction = 'high' if abs(expected_bps) >= 90 else 'medium' if abs(expected_bps) >= 60 else 'low'
    return {'stance': stance, 'conviction': conviction, 'reasons': [f'Forecast 1-hour move {expected_bps:+.1f} bps.'],
            'invalidation': f'Price moving {"below" if stance == "bullish" else "above"} the last close within the hour.'}


def build(spec, **options):
    """'Kronos-mini' / 'Kronos-small' (pretrained) or 'finetuned:NAME' (made by kronos_finetune.py)."""
    if spec in VARIANTS:
        return KronosForecaster.pretrained(spec, **options)
    if spec.startswith('finetuned:') and spec[10:].replace('-', '').replace('_', '').isalnum():
        return KronosForecaster.finetuned(spec[10:], **options)
    raise ValueError('Forecaster: Kronos-mini, Kronos-small or finetuned:NAME')


def weights_digest(directory):
    digest = hashlib.sha256()
    for path in sorted(Path(directory).rglob('*')):
        relative = path.relative_to(directory)
        if path.is_file() and not any(part.startswith('.') for part in relative.parts):  # skip download metadata
            digest.update(relative.as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def repo_commit(repo=KRONOS / 'repo'):
    """The pinned Kronos source revision, read from the local clone (no git command needed)."""
    head = (repo / '.git' / 'HEAD').read_text(encoding='utf-8').strip()
    if head.startswith('ref: '):
        ref = repo / '.git' / head[5:]
        if ref.exists():
            return ref.read_text(encoding='utf-8').strip()
        packed = (repo / '.git' / 'packed-refs').read_text(encoding='utf-8')
        return next(line.split()[0] for line in packed.splitlines() if line.endswith(head[5:]))
    return head


class KronosForecaster:
    """forecaster(bars, i) -> forecast dict, or None when history is too short. Deterministic per bar (seeded)."""

    def __init__(self, model_dir, tokenizer_dir, max_context, *, samples=5, device='cpu', label=None):
        import os
        import sys
        os.environ['HF_HUB_OFFLINE'] = '1'  # local weights only; never download at run time
        sys.path.insert(0, str(KRONOS / 'repo'))
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer
        self.torch = torch
        torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))  # leave half the processor to everything else
        tokenizer = KronosTokenizer.from_pretrained(str(model_dir if tokenizer_dir is None else tokenizer_dir))
        model = Kronos.from_pretrained(str(model_dir))
        self.predictor = KronosPredictor(model, tokenizer, device=device, max_context=max_context)
        self.samples = samples
        # The name identifies weights and sampling, so results from different settings never mix.
        self.name = f"{label or Path(model_dir).name + '@' + weights_digest(model_dir)}-s{samples}"

    @classmethod
    def pretrained(cls, variant='Kronos-mini', **options):
        tokenizer, context = VARIANTS[variant]
        return cls(KRONOS / 'weights' / variant, KRONOS / 'weights' / tokenizer, context, **options)

    @classmethod
    def finetuned(cls, name, **options):
        directory = KRONOS / 'finetuned' / name
        import json
        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
        tokenizer, context = VARIANTS[manifest['baseVariant']]
        return cls(directory / 'model', KRONOS / 'weights' / tokenizer, context, label=f'{name}@{weights_digest(directory / "model")}', **options)

    def __call__(self, bars, i):
        """Forecast from completed bars[:i+1] only; None when there is too little history."""
        import pandas as pd
        window = history(bars, i)
        if window is None:
            return None
        frame = pd.DataFrame({'open': [b['openPaise'] / 100 for b in window], 'high': [b['highPaise'] / 100 for b in window],
                              'low': [b['lowPaise'] / 100 for b in window], 'close': [b['closePaise'] / 100 for b in window],
                              'volume': [float(b['volume']) for b in window]})
        frame['amount'] = frame['volume'] * frame[['open', 'high', 'low', 'close']].mean(axis=1)
        x_time = pd.Series(pd.to_datetime([b['time'] for b in window]))
        y_time = pd.Series(pd.to_datetime([t.isoformat() for t in future_times(window[-1]['time'], HORIZON)]))
        seed = int(hashlib.sha256(window[-1]['time'].encode()).hexdigest()[:8], 16)
        self.torch.manual_seed(seed)  # same bar, same forecast: replay results are reproducible
        predicted = self.predictor.predict(df=frame, x_timestamp=x_time, y_timestamp=y_time, pred_len=HORIZON,
                                           T=1.0, top_p=0.9, sample_count=self.samples, verbose=False)
        last = window[-1]['closePaise'] / 100
        expected = round((float(predicted['close'].iloc[-1]) - last) / last * 10000, 1)
        return {'model': self.name, 'expectedReturn1HourBps': expected, 'lookbackBars': len(window),
                'samplesAveraged': self.samples, 'seed': seed}
