"""Test-only bundled data export and reference metrics, used by http-check.mjs."""
import json
from lab import METHODS, load_returns, score, weights_for
from bridge import verify_dependencies

verify_dependencies()
frame = load_returns().sort_index(axis=1).iloc[:315]
training, holdout = frame.iloc[:252], frame.iloc[252:]


def rows(data):
    return [{"timestamp": date.isoformat() + "Z", "returns": row.tolist()}
            for date, row in data.iterrows()]


print(json.dumps({"purpose": "example-testing", "assets": list(frame.columns),
                  "training": rows(training), "holdout": rows(holdout),
                  "reference": {method: score(weights_for(method, training), holdout, 15)
                                for method in METHODS}}, allow_nan=False))
