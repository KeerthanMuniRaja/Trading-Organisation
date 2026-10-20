"""Personal research only. Isolated historical replay; no wallets or broker orders."""
import argparse
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
IST = timezone(timedelta(hours=5, minutes=30))
SYMBOL = "RELIANCE.NS"


def validate(dataset):
    if (dataset.get("schemaVersion") != 1 or dataset.get("symbol") != SYMBOL or
            dataset.get("currency") != "INR" or dataset.get("interval") != "5m" or
            dataset.get("priceBasis") != "unadjusted" or
            dataset.get("source") not in ("yahoo-via-yfinance", "synthetic-test")):
        raise ValueError("INVALID_DATASET_METADATA")
    bars = dataset.get("bars")
    if not isinstance(bars, list) or not 13 <= len(bars) <= 6000:
        raise ValueError("INVALID_BAR_COUNT")
    previous = None
    for b in bars:
        t = datetime.fromisoformat(b["time"])
        if t.utcoffset() != timedelta(hours=5, minutes=30) or (previous and t <= previous):
            raise ValueError("INVALID_BAR_ORDER_OR_TIMEZONE")
        minute = t.hour * 60 + t.minute
        if not (555 <= minute <= 925) or minute % 5 or t.second or t.microsecond or t.weekday() >= 5:
            raise ValueError("INVALID_SESSION_BAR")
        previous = t
        prices = [b.get(k) for k in ("openPaise", "highPaise", "lowPaise", "closePaise")]
        if not all(type(n) is int and 0 < n <= 100_000_000 for n in prices):
            raise ValueError("INVALID_PRICE")
        o, h, low, c = prices
        if not low <= min(o, c) <= max(o, c) <= h:
            raise ValueError("INVALID_OHLC")
        if type(b.get("volume")) is not int or b["volume"] < 0:
            raise ValueError("INVALID_VOLUME")
        if b.get("dividend", 0) != 0 or b.get("split", 0) != 0:
            raise ValueError("CORPORATE_ACTION_REQUIRES_ADJUSTMENT")
    return bars


def run_replay(dataset):
    bars = validate(dataset)
    cash, initial, realised = 1_000_000, 1_000_000, 0
    position, pending = None, None
    closes, trades, decisions, curve = [], [], [], []
    peak, max_drawdown = initial, 0
    for i, b in enumerate(bars):
        # Pending orders were decided using only previous completed bars.
        if pending:
            side, signal_time = pending
            raw = b["openPaise"]
            fill = (raw * 10005 + 9999) // 10000 if side == "buy" else raw * 9995 // 10000
            fee = (fill * 10 + 9999) // 10000
            cost = fill + fee
            if side == "buy" and position is None and cost <= min(cash, initial // 5) and realised > -10_000:
                cash -= cost
                position = {"costPaise": cost, "entryIndex": i, "quantity": 1}
                trades.append({"side": side, "signalBar": signal_time, "fillBar": b["time"],
                               "fillPaise": fill, "feePaise": fee, "quantity": 1})
            elif side == "sell" and position:
                net = fill - fee - position["costPaise"]
                cash += fill - fee
                realised += net
                position = None
                trades.append({"side": side, "signalBar": signal_time, "fillBar": b["time"],
                               "fillPaise": fill, "feePaise": fee, "quantity": 1, "realisedNetPaise": net})
        # No execution-bar volume check: its final volume is unknown at its open.
        pending = None
        closes.append(b["closePaise"])
        closes = closes[-12:]
        action = "hold"
        if position and len(closes) == 12 and (sum(closes[-3:]) * 4 <= sum(closes) or i - position["entryIndex"] >= 6):
            action = "sell"
        elif not position and b["volume"] > 0 and realised > -10_000 and len(trades) < 20 and len(closes) == 12 and sum(closes[-3:]) * 4000 > sum(closes) * 1001:
            action = "buy"
        if action != "hold":
            pending = (action, b["time"])
        decisions.append({"bar": b["time"], "decision": action})
        liquidation = b["closePaise"] * 9995 // 10000 if position else 0
        liquidation -= (liquidation * 10 + 9999) // 10000
        equity = cash + liquidation
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak)
        curve.append({"bar": b["time"], "equityPaise": equity})
    return {"mode": "historical-replay", "strategy": "fixed-momentum-baseline-v2",
            "source": dataset["source"], "symbol": SYMBOL, "bars": len(bars),
            "initialPaise": initial, "cashPaise": cash, "realisedNetPaise": realised,
            "unrealisedNetPaise": curve[-1]["equityPaise"] - initial - realised,
            "endingEquityPaise": curve[-1]["equityPaise"], "maxDrawdownFraction": max_drawdown,
            "openPosition": position, "unfilledFinalSignal": pending,
            "assumptions": {"slippageBps": 5, "illustrativeFeeBpsPerSide": 10,
                            "fill": "next-observed-bar-open", "maxPositionPercent": 20,
                            "overnightHoldingPossible": True, "liquidity": "unverified-open-fill-assumption"},
            "qualification": "diagnostic-only-not-AI-training-or-profitability-proof",
            "trades": trades, "decisions": decisions, "equityCurve": curve}


def download(end):
    try:
        import yfinance as yf
    except ImportError:
        raise ValueError("YFINANCE_NOT_INSTALLED: see docs/historical-replay.md") from None
    if end > datetime.now(IST).date():
        raise ValueError("END_MUST_NOT_BE_IN_FUTURE")
    yf.set_tz_cache_location(str(ROOT / ".local" / "market-replay-cache"))
    ticker = yf.Ticker(SYMBOL)
    frame = ticker.history(start=(end - timedelta(days=7)).isoformat(), end=end.isoformat(),
                           interval="5m", auto_adjust=False, back_adjust=False, actions=True,
                           repair=False, timeout=20)
    if frame.empty:
        raise ValueError("EMPTY_PROVIDER_DATA")
    meta = ticker.get_history_metadata()
    if (meta.get("symbol") != SYMBOL or meta.get("currency") != "INR" or
            meta.get("exchangeTimezoneName") not in ("Asia/Kolkata", "Asia/Calcutta")):
        raise ValueError("UNEXPECTED_MARKET_METADATA")
    rows = []
    def price(value):
        if not math.isfinite(float(value)):
            raise ValueError("NONFINITE_PRICE")
        return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    for index, row in frame.iterrows():
        if index.tzinfo is None:
            raise ValueError("MISSING_TIMEZONE")
        t = index.to_pydatetime().astimezone(IST)
        if t.date() >= end or t.date() < end - timedelta(days=7):
            raise ValueError("OUT_OF_RANGE_BAR")
        volume = float(row["Volume"])
        if not math.isfinite(volume) or not volume.is_integer():
            raise ValueError("INVALID_VOLUME")
        rows.append({"time": t.isoformat(), **{k.lower() + "Paise": price(row[k]) for k in ("Open", "High", "Low", "Close")},
                     "volume": int(volume), "dividend": float(row.get("Dividends", 0)),
                     "split": float(row.get("Stock Splits", 0))})
    dataset = {"schemaVersion": 1, "symbol": SYMBOL, "currency": "INR", "interval": "5m",
               "source": "yahoo-via-yfinance", "providerVersion": yf.__version__,
               "priceBasis": "unadjusted", "retrievedAt": datetime.now(timezone.utc).isoformat(),
               "endExclusive": end.isoformat(), "bars": rows}
    validate(dataset)
    return dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--download", action="store_true")
    source.add_argument("--input", type=Path)
    source.add_argument("--review-run", type=Path)
    parser.add_argument("--end", type=date.fromisoformat, default=datetime.now(IST).date())
    args = parser.parse_args()
    if args.review_run:
        from experience import review_run
        target = review_run(args.review_run)
        print(f"Recomputed experience packet (independent review still required): {target}")
        return
    if args.download:
        dataset = download(args.end)
    else:
        if args.input.stat().st_size > 5_000_000:
            raise ValueError("DATASET_TOO_LARGE")
        dataset = json.loads(args.input.read_text(encoding="utf-8"))
    result = run_replay(dataset)
    raw = json.dumps(dataset, sort_keys=True, allow_nan=False).encode()
    result["datasetSha256"] = hashlib.sha256(raw).hexdigest()
    result["simulatorSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    folder = ROOT / ".local" / "market-replay" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "dataset.json").write_bytes(raw)
    (folder / "report.json").write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    from experience import review_run
    review_run(folder)
    print(f"Historical replay: {result['bars']} bars, {len(result['trades'])} simulated fills.")
    print(f"Realised net: INR {result['realisedNetPaise']/100:.2f}; unrealised: INR {result['unrealisedNetPaise']/100:.2f}")
    print(f"Report: {folder / 'report.json'}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not echo provider exceptions, response bodies or network configuration.
        print(f"Replay failed ({type(error).__name__}); no result should be treated as a successful run.", file=sys.stderr)
        sys.exit(1)
