"""Fine-tune Kronos on cached NSE 5-minute weeks: knowledge transfer from the pretrained model to our market.

Strictly chronological: training uses weeks ending on or before --train-through, validation the following week(s)
up to --validate-through, and every later week stays untouched for forecast_eval.py. The tokenizer stays frozen;
only the forecasting model is trained, with the same next-token objective as the Kronos repository's own
finetune/train_predictor.py. The best checkpoint by validation loss is kept; if training never beats the
pretrained model on validation, that is recorded and no fine-tuned model is written.
CPU only, bounded by --max-steps and --threads so the laptop stays usable. Local files only; no network.
Run with the Kronos environment: .local\\kronos-venv\\Scripts\\python.exe integrations\\trading-desk\\kronos_finetune.py --name nse-v1
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import glob
import json
import os
from pathlib import Path
import random
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import datasets  # noqa: E402
import forecast  # noqa: E402

LOOKBACK, HORIZON, CLIP = forecast.LOOKBACK, forecast.HORIZON, 5.0
WINDOW = LOOKBACK + HORIZON + 1  # as in the Kronos dataset: lookback + predict + 1
MAX_GAP = timedelta(days=4)      # a longer gap (e.g. a skipped corporate-action week) splits a series


def week_end(path):
    return date.fromisoformat(Path(path).stem.rsplit('-5m-', 1)[1])


def segments(symbol, first_end, last_end, cache=datasets.CACHE):
    """Contiguous runs of bars from cached weeks whose exclusive end lies in [first_end, last_end]."""
    bars = []
    for path in sorted(glob.glob(str(cache / f'{symbol}-5m-*.json'))):
        if first_end <= week_end(path) <= last_end:
            bars += datasets.validate(json.loads(Path(path).read_text(encoding='utf-8')))
    runs, current = [], []
    for bar in bars:
        if current and datetime.fromisoformat(bar['time']) - datetime.fromisoformat(current[-1]['time']) > MAX_GAP:
            runs.append(current)
            current = []
        current.append(bar)
    return [run for run in runs + [current] if len(run) >= WINDOW]


def samples(runs, stride):
    """(features, time features) per window; normalised on the lookback part only, so no future statistics leak."""
    import numpy as np
    out = []
    for run in runs:
        for start in range(0, len(run) - WINDOW + 1, stride):
            window = run[start:start + WINDOW]
            x = np.array([[b['openPaise'] / 100, b['highPaise'] / 100, b['lowPaise'] / 100, b['closePaise'] / 100, float(b['volume']),
                           b['volume'] * (b['openPaise'] + b['highPaise'] + b['lowPaise'] + b['closePaise']) / 400] for b in window],
                         dtype=np.float32)
            times = [datetime.fromisoformat(b['time']) for b in window]
            stamp = np.array([[t.minute, t.hour, t.weekday(), t.day, t.month] for t in times], dtype=np.float32)
            mean, std = x[:LOOKBACK].mean(axis=0), x[:LOOKBACK].std(axis=0)
            out.append((np.clip((x - mean) / (std + 1e-5), -CLIP, CLIP), stamp))
    return out


def loss_of(model, tokenizer, torch, x, stamp):
    """The Kronos repository's training objective: predict each next (s1, s2) token pair."""
    with torch.no_grad():
        s1, s2 = tokenizer.encode(x, half=True)
    logits = model(s1[:, :-1], s2[:, :-1], stamp[:, :-1, :])
    loss, _, _ = model.head.compute_loss(logits[0], logits[1], s1[:, 1:], s2[:, 1:])
    return loss


def mean_loss(model, tokenizer, torch, data, batch_size):
    import numpy as np
    model.eval()
    total = 0.0
    with torch.no_grad():
        for k in range(0, len(data), batch_size):
            chunk = data[k:k + batch_size]
            x = torch.from_numpy(np.stack([c[0] for c in chunk]))
            stamp = torch.from_numpy(np.stack([c[1] for c in chunk]))
            total += float(loss_of(model, tokenizer, torch, x, stamp)) * len(chunk)
    return round(total / len(data), 5)


def finetune(args):
    import numpy as np
    sys.path.insert(0, str(forecast.KRONOS / 'repo'))
    os.environ['HF_HUB_OFFLINE'] = '1'
    import torch
    from model import Kronos, KronosTokenizer
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    tokenizer_id, _ = forecast.VARIANTS[args.base]
    tokenizer = KronosTokenizer.from_pretrained(str(forecast.KRONOS / 'weights' / tokenizer_id))
    model = Kronos.from_pretrained(str(forecast.KRONOS / 'weights' / args.base))
    tokenizer.eval()
    for p in tokenizer.parameters():
        p.requires_grad_(False)
    earliest = date(2000, 1, 1)
    train = samples([r for s in args.symbols for r in segments(s, earliest, args.train_through)], args.stride)
    # Validation windows need lookback context, which may come from training weeks; their forecast targets must be later.
    # (Kronos's loss also scores the lookback tokens, so validation loss only selects checkpoints; the real test is
    # forecast_eval.py on weeks after --validate-through.)
    validation = validation_samples([r for s in args.symbols for r in segments(s, earliest, args.validate_through)],
                                    args.train_through.isoformat())
    if not train or not validation:
        raise SystemExit('Not enough cached weeks for this split; fetch more with datasets.py')
    before = mean_loss(model, tokenizer, torch, validation, args.batch_size)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    history, best, best_state, step = [{'step': 0, 'validationLoss': before}], before, None, 0
    while step < args.max_steps:
        rng.shuffle(train)
        model.train()
        for k in range(0, len(train) - args.batch_size + 1, args.batch_size):
            chunk = train[k:k + args.batch_size]
            x = torch.from_numpy(np.stack([c[0] for c in chunk]))
            stamp = torch.from_numpy(np.stack([c[1] for c in chunk]))
            loss = loss_of(model, tokenizer, torch, x, stamp)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 3.0)
            optimizer.step()
            step += 1
            if step % args.eval_every == 0 or step >= args.max_steps:
                current = mean_loss(model, tokenizer, torch, validation, args.batch_size)
                history.append({'step': step, 'trainLoss': round(float(loss), 5), 'validationLoss': current})
                print(json.dumps(history[-1]), flush=True)
                if current < best:
                    best, best_state = current, {k: v.detach().clone() for k, v in model.state_dict().items()}
                model.train()
            if step >= args.max_steps:
                break
    target = forecast.KRONOS / 'finetuned' / args.name
    manifest = {'schemaVersion': 1, 'name': args.name, 'baseVariant': args.base,
                'baseWeights': forecast.weights_digest(forecast.KRONOS / 'weights' / args.base),
                'kronosCommit': forecast.repo_commit(), 'symbols': args.symbols,
                'trainedThroughExclusive': args.train_through.isoformat(), 'validatedThroughExclusive': args.validate_through.isoformat(),
                'trainSamples': len(train), 'validationSamples': len(validation), 'lookback': LOOKBACK, 'horizon': HORIZON,
                'hyperparameters': {k: getattr(args, k) for k in ('lr', 'batch_size', 'max_steps', 'stride', 'seed', 'threads')},
                'validationLossPretrained': before, 'validationLossBest': best, 'history': history,
                'createdAt': datetime.now(timezone.utc).isoformat()}
    target.mkdir(parents=True, exist_ok=True)
    if best_state is None:
        manifest['outcome'] = 'no-improvement: fine-tuning never beat the pretrained model on validation; no model written'
    else:
        model.load_state_dict(best_state)
        model.save_pretrained(str(target / 'model'))
        manifest['outcome'] = 'saved-best-checkpoint'
    batch.save(target / 'manifest.json', manifest)
    return manifest


def validation_samples(runs, cutoff):
    """Windows whose forecast targets all lie after the training cutoff (context may precede it)."""
    out = []
    for run in runs:
        for start in range(0, len(run) - WINDOW + 1, HORIZON):
            window = run[start:start + WINDOW]
            if window[LOOKBACK]['time'] >= cutoff:
                out += samples([window], 1)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--name', required=True)
    parser.add_argument('--base', default='Kronos-mini', choices=sorted(forecast.VARIANTS))
    parser.add_argument('--symbol', action='append', choices=sorted(datasets.UNIVERSE), help='Repeatable; default all')
    parser.add_argument('--train-through', type=date.fromisoformat, default=date(2026, 9, 11),
                        help='Last exclusive week end used for training (default: the first four cached weeks)')
    parser.add_argument('--validate-through', type=date.fromisoformat, default=date(2026, 9, 18))
    parser.add_argument('--max-steps', type=int, default=300, choices=range(1, 5001))
    parser.add_argument('--batch-size', type=int, default=8, choices=range(1, 65))
    parser.add_argument('--lr', type=float, default=2e-5)
    parser.add_argument('--stride', type=int, default=6, choices=range(1, 76))
    parser.add_argument('--eval-every', type=int, default=25, choices=range(1, 1001))
    parser.add_argument('--threads', type=int, default=max(1, (os.cpu_count() or 2) // 2))
    parser.add_argument('--seed', type=int, default=7)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
        raise SystemExit('Name: letters, digits, _ or -')
    if args.validate_through <= args.train_through:
        raise SystemExit('Validation must come after training')
    if (forecast.KRONOS / 'finetuned' / args.name / 'manifest.json').exists():
        raise SystemExit('A fine-tuned model with this name exists; choose a new name')
    args.symbols = args.symbol or sorted(datasets.UNIVERSE)
    manifest = finetune(args)
    print(json.dumps({k: v for k, v in manifest.items() if k != 'history'}, indent=2))


if __name__ == '__main__':
    main()
